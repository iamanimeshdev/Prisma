// ============================================================
// PRISMA — Unified Voice Server (STT + TTS on one port)
// ============================================================
// A single persistent Python HTTP server that handles both
// speech-to-text (Whisper) and text-to-speech (edge-tts).
// The Whisper model loads once at startup and stays in memory.
const { spawn } = require('child_process');

const PYTHON_PATH = process.env.PYTHON_PATH || 'python';
const VOICE_PORT = 9457;

let server = null;
let ready = false;

const SERVER_SCRIPT = `
import sys, json, warnings, asyncio
warnings.filterwarnings("ignore")

from http.server import HTTPServer, BaseHTTPRequestHandler
from faster_whisper import WhisperModel
import edge_tts

# Load Whisper model once at startup
print("LOADING_MODEL", flush=True)
model = WhisperModel("small", device="cpu", compute_type="int8")
print("READY", flush=True)

class VoiceHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length))

        if self.path == "/stt":
            self._handle_stt(body)
        elif self.path == "/tts":
            self._handle_tts(body)
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_stt(self, body):
        try:
            audio_path = body["audio_path"]
            segments, info = model.transcribe(audio_path, language="en", beam_size=5)
            text = " ".join([seg.text for seg in segments]).strip()
            self._respond(200, {"ok": True, "text": text})
        except Exception as e:
            self._respond(500, {"ok": False, "error": str(e)})

    def _handle_tts(self, body):
        try:
            text = body["text"]
            voice = body["voice"]
            output = body["output"]
            asyncio.run(self._synthesize(text, voice, output))
            self._respond(200, {"ok": True})
        except Exception as e:
            self._respond(500, {"ok": False, "error": str(e)})

    async def _synthesize(self, text, voice, output):
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(output)

    def _respond(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        pass

server = HTTPServer(("127.0.0.1", ${VOICE_PORT}), VoiceHandler)
server.serve_forever()
`;

/**
 * Start the unified voice server.
 * @returns {Promise<void>}
 */
function startVoiceServer() {
    if (server) return Promise.resolve();

    return new Promise((resolve) => {
        server = spawn(PYTHON_PATH, ['-u', '-c', SERVER_SCRIPT], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        server.stderr.on('data', (d) => {
            const msg = d.toString().trim();
            if (msg) console.warn('[VoiceServer]', msg);
        });

        server.on('exit', (code) => {
            console.log('[VoiceServer] Exited with code', code);
            server = null;
            ready = false;
        });

        server.on('error', (err) => {
            console.error('[VoiceServer] Error:', err.message);
            server = null;
            ready = false;
        });

        let buf = '';
        const onData = (data) => {
            buf += data.toString();
            if (buf.includes('LOADING_MODEL')) {
                console.log('[VoiceServer] Loading Whisper model (one-time)...');
            }
            if (buf.includes('READY')) {
                ready = true;
                console.log('[VoiceServer] Ready — STT + TTS on port', VOICE_PORT);
                server.stdout.removeListener('data', onData);
                resolve();
            }
        };
        server.stdout.on('data', onData);

        // Timeout after 30s
        setTimeout(() => {
            if (!ready) {
                console.warn('[VoiceServer] Startup timeout, falling back to per-call mode');
                resolve();
            }
        }, 30000);
    });
}

/**
 * Check if the server is ready.
 */
function isReady() {
    return ready && server;
}

/**
 * Get the base URL for the voice server.
 */
function getBaseUrl() {
    return `http://127.0.0.1:${VOICE_PORT}`;
}

/**
 * Destroy the voice server.
 */
function destroyVoiceServer() {
    if (server) {
        try {
            // On Windows, kill the entire process tree to ensure cleanup
            if (process.platform === 'win32') {
                const { execSync } = require('child_process');
                execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' });
            } else {
                server.kill('SIGKILL');
            }
        } catch (e) { /* ignore */ }
        server = null;
        ready = false;
    }
}

module.exports = { startVoiceServer, destroyVoiceServer, isReady, getBaseUrl };
