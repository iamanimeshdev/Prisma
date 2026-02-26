// ============================================================
// PRISMA — Text-to-Speech (via unified voice server)
// ============================================================
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { isReady, getBaseUrl } = require('./voiceServer');

const VOICE = process.env.TTS_VOICE || 'en-US-AvaNeural';
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';

let currentPlayer = null;
const audioCache = new Map();

/**
 * Pre-cache an audio file for instant playback later.
 */
async function precache(key, text) {
    const cachePath = path.join(os.tmpdir(), `prisma_cache_${key}.mp3`);
    try {
        await synthesize(text, cachePath);
        audioCache.set(key, cachePath);
        console.log(`[TTS] Pre-cached: "${key}"`);
    } catch (err) {
        console.warn(`[TTS] Failed to pre-cache "${key}":`, err.message);
    }
}

/**
 * Speak text aloud. If cacheKey matches, plays instantly.
 */
async function speak(text, cacheKey) {
    if (!text || text.trim().length === 0) return;

    if (cacheKey && audioCache.has(cacheKey)) {
        console.log(`[TTS] Playing cached: "${cacheKey}"`);
        await playAudio(audioCache.get(cacheKey));
        return;
    }

    const cleanText = text
        .replace(/[*_`#\[\]()]/g, '')
        .replace(/\n+/g, '. ')
        .replace(/\s+/g, ' ')
        .trim();

    if (cleanText.length === 0) return;
    console.log('[TTS] Speaking:', cleanText.substring(0, 80) + '...');

    const tempFile = path.join(os.tmpdir(), `prisma_tts_${Date.now()}.mp3`);
    try {
        await synthesize(cleanText, tempFile);
        await playAudio(tempFile);
    } finally {
        try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
    }
}

/**
 * Synthesize text — via voice server (fast) or fallback spawn.
 */
async function synthesize(text, outputPath) {
    if (isReady()) {
        const res = await fetch(`${getBaseUrl()}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: VOICE, output: outputPath }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'TTS failed');
    } else {
        // Fallback: spawn per call
        await new Promise((resolve, reject) => {
            const script = `import sys,asyncio,edge_tts\nasync def m():\n c=edge_tts.Communicate(sys.argv[1],sys.argv[2])\n await c.save(sys.argv[3])\nasyncio.run(m())`;
            const p = spawn(PYTHON_PATH, ['-c', script, text, VOICE, outputPath], {
                stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
            });
            let err = '';
            p.stderr.on('data', d => err += d);
            p.on('close', c => c !== 0 ? reject(new Error(err)) : resolve());
            p.on('error', e => reject(e));
        });
    }
}

function playAudio(filePath) {
    return new Promise((resolve) => {
        currentPlayer = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const pid = currentPlayer.pid;
        currentPlayer.on('close', () => {
            currentPlayer = null;
            resolve(); // Always resolve — interrupted or finished, doesn't matter
        });
        currentPlayer.on('error', () => { currentPlayer = null; resolve(); });
    });
}

function stopSpeaking() {
    if (currentPlayer) {
        const pid = currentPlayer.pid;
        currentPlayer = null;
        try {
            // On Windows, .kill() sends SIGTERM which ffplay ignores.
            // Must use taskkill /F to force-kill.
            if (process.platform === 'win32' && pid) {
                const { execSync } = require('child_process');
                execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
            } else {
                process.kill(pid, 'SIGKILL');
            }
        } catch (e) { /* already dead */ }
        console.log('[TTS] Stopped');
    }
}

function destroy() {
    stopSpeaking();
    for (const [, fp] of audioCache) { try { fs.unlinkSync(fp); } catch (e) { } }
    audioCache.clear();
}

module.exports = { speak, stopSpeaking, precache, destroy };
