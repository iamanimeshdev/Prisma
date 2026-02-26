// ============================================================
// PRISMA — Speech-to-Text (via unified voice server)
// ============================================================
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { isReady, getBaseUrl } = require('./voiceServer');

const PYTHON_PATH = process.env.PYTHON_PATH || 'python';

/**
 * Record audio from the microphone for a specified duration.
 */
function recordAudio(durationMs = 5000) {
    return new Promise((resolve, reject) => {
        const tempFile = path.join(os.tmpdir(), `prisma_recording_${Date.now()}.wav`);
        const soxBin = process.env.SOX_PATH || 'sox';

        const inputArgs = process.platform === 'win32'
            ? ['-t', 'waveaudio', 'default']
            : ['--default-device'];

        const args = [
            ...inputArgs,
            '--no-show-progress',
            '--rate', '16000',
            '--channels', '1',
            '--encoding', 'signed-integer',
            '--bits', '16',
            '--type', 'wav',
            tempFile,
            'trim', '0', String(durationMs / 1000),
        ];

        const proc = spawn(soxBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            if (code !== 0) reject(new Error(`Sox recording failed (${code}): ${stderr}`));
            else { console.log('[STT] Recording saved:', tempFile); resolve(tempFile); }
        });
        proc.on('error', (err) => reject(new Error('Sox error: ' + err.message)));
    });
}

/**
 * Transcribe audio — via voice server (fast) or fallback spawn.
 */
async function transcribeWithWhisper(audioPath) {
    try {
        let text;
        if (isReady()) {
            const res = await fetch(`${getBaseUrl()}/stt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio_path: audioPath }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Transcription failed');
            text = data.text;
        } else {
            // Fallback: spawn per call
            text = await new Promise((resolve, reject) => {
                const script = `import sys,warnings\nwarnings.filterwarnings("ignore")\nfrom faster_whisper import WhisperModel\nm=WhisperModel("small",device="cpu",compute_type="int8")\ns,i=m.transcribe(sys.argv[1],language="en",beam_size=5)\nprint(" ".join([x.text for x in s]).strip())`;
                const p = spawn(PYTHON_PATH, ['-c', script, audioPath], {
                    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
                });
                let out = '', err = '';
                p.stdout.on('data', d => out += d);
                p.stderr.on('data', d => err += d);
                p.on('close', c => c !== 0 ? reject(new Error(err)) : resolve(out.trim()));
                p.on('error', e => reject(e));
            });
        }
        console.log('[STT] Transcribed:', text);
        return text;
    } finally {
        try { fs.unlinkSync(audioPath); } catch (e) { /* ignore */ }
    }
}

/**
 * Record and transcribe speech.
 */
async function listen(durationMs = 5000) {
    console.log('[STT] Recording for', durationMs / 1000, 'seconds...');
    const audioPath = await recordAudio(durationMs);
    console.log('[STT] Transcribing...');
    return await transcribeWithWhisper(audioPath);
}

module.exports = { listen, recordAudio, transcribeWithWhisper };
