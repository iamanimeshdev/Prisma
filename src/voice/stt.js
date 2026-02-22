// ============================================================
// PRISMA — Speech-to-Text (Whisper via Python)
// ============================================================
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Record audio from the microphone for a specified duration.
 * Returns the path to the recorded WAV file.
 */
function recordAudio(durationMs = 5000) {
    return new Promise((resolve, reject) => {
        try {
            const tempFile = path.join(os.tmpdir(), `prisma_recording_${Date.now()}.wav`);
            const soxBin = process.env.SOX_PATH || 'sox';
            const sampleRate = 16000;
            const channels = 1;

            // Build sox args: on Windows use waveaudio driver, otherwise default device
            const inputArgs = process.platform === 'win32'
                ? ['-t', 'waveaudio', 'default']
                : ['--default-device'];

            const args = [
                ...inputArgs,
                '--no-show-progress',
                '--rate', String(sampleRate),
                '--channels', String(channels),
                '--encoding', 'signed-integer',
                '--bits', '16',
                '--type', 'wav',
                tempFile,
                'trim', '0', String(durationMs / 1000),
            ];

            console.log('[STT] Sox command:', soxBin, args.join(' '));

            const proc = spawn(soxBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

            let stderr = '';
            proc.stderr.on('data', (d) => { stderr += d.toString(); });

            proc.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Sox recording failed (code ${code}): ${stderr}`));
                } else {
                    console.log('[STT] Recording saved:', tempFile);
                    resolve(tempFile);
                }
            });

            proc.on('error', (err) => {
                reject(new Error('Sox spawn error: ' + err.message));
            });
        } catch (err) {
            reject(new Error('Audio recording failed: ' + err.message));
        }
    });
}

/**
 * Transcribe an audio file using Python Whisper.
 * @param {string} audioPath - Path to the WAV file
 * @returns {Promise<string>} Transcribed text
 */
function transcribeWithWhisper(audioPath) {
    return new Promise((resolve, reject) => {
        const pythonPath = process.env.PYTHON_PATH || 'python';

        // Inline Python script using faster-whisper (bundled with WhisperX)
        // "small" model is much better at emails/names than "base"
        const script = `
import sys
import warnings
warnings.filterwarnings("ignore")

from faster_whisper import WhisperModel

model = WhisperModel("small", device="cpu", compute_type="int8")
segments, info = model.transcribe(sys.argv[1], language="en", beam_size=5)
text = " ".join([seg.text for seg in segments]).strip()
print(text)
`;

        const proc = spawn(pythonPath, ['-c', script, audioPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            // Clean up temp file
            try { fs.unlinkSync(audioPath); } catch (e) { /* ignore */ }

            if (code !== 0) {
                console.error('[STT] Whisper error:', stderr);
                reject(new Error('Whisper transcription failed'));
            } else {
                const text = stdout.trim();
                console.log('[STT] Transcribed:', text);
                resolve(text);
            }
        });

        proc.on('error', (err) => {
            reject(new Error('Failed to start Python: ' + err.message));
        });
    });
}

/**
 * Record and transcribe speech.
 * @param {number} durationMs - Recording duration in milliseconds
 * @returns {Promise<string>} Transcribed text
 */
async function listen(durationMs = 5000) {
    console.log('[STT] Recording for', durationMs / 1000, 'seconds...');
    const audioPath = await recordAudio(durationMs);
    console.log('[STT] Transcribing...');
    const text = await transcribeWithWhisper(audioPath);
    return text;
}

module.exports = { listen, recordAudio, transcribeWithWhisper };
