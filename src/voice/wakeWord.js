// ============================================================
// PRISMA — Wake Word Detection
// ============================================================
const EventEmitter = require('events');

class WakeWordEngine extends EventEmitter {
    constructor() {
        super();
        this.isListening = false;
        this.porcupine = null;
        this.recorder = null;
        this.available = false;
    }

    /**
     * Initialize wake word detection.
     * Falls back gracefully if Porcupine is not available.
     */
    async initialize() {
        const accessKey = process.env.PORCUPINE_ACCESS_KEY;
        if (!accessKey) {
            console.warn('[WakeWord] No PORCUPINE_ACCESS_KEY — wake word disabled. Use manual trigger.');
            this.available = false;
            return;
        }

        try {
            const { Porcupine, BuiltinKeyword } = require('@picovoice/porcupine-node');
            const keyword = process.env.WAKE_WORD?.toLowerCase() || 'computer';

            // Map wake word to built-in keyword (Porcupine has limited built-in keywords)
            // For custom "prisma" keyword, you'd need a custom .ppn file from Picovoice Console
            // Defaulting to "computer" as a built-in fallback
            let keywordEnum = BuiltinKeyword.COMPUTER;
            const builtinMap = {
                alexa: BuiltinKeyword.ALEXA,
                americano: BuiltinKeyword.AMERICANO,
                blueberry: BuiltinKeyword.BLUEBERRY,
                bumblebee: BuiltinKeyword.BUMBLEBEE,
                computer: BuiltinKeyword.COMPUTER,
                grapefruit: BuiltinKeyword.GRAPEFRUIT,
                grasshopper: BuiltinKeyword.GRASSHOPPER,
                'hey google': BuiltinKeyword.HEY_GOOGLE,
                'hey siri': BuiltinKeyword.HEY_SIRI,
                jarvis: BuiltinKeyword.JARVIS,
                'ok google': BuiltinKeyword.OK_GOOGLE,
                picovoice: BuiltinKeyword.PICOVOICE,
                porcupine: BuiltinKeyword.PORCUPINE,
                terminator: BuiltinKeyword.TERMINATOR,
            };

            if (builtinMap[keyword]) {
                keywordEnum = builtinMap[keyword];
            } else {
                console.warn(`[WakeWord] "${keyword}" is not a built-in keyword. Using "computer". For custom keywords, generate a .ppn file from Picovoice Console.`);
            }

            this.porcupine = new Porcupine(accessKey, [keywordEnum], [0.5]);
            this.available = true;
            console.log(`[WakeWord] Initialized with keyword: "${keyword}"`);
        } catch (err) {
            console.warn('[WakeWord] Porcupine not available:', err.message);
            this.available = false;
        }
    }

    /**
     * Start listening for the wake word.
     */
    startListening() {
        if (!this.available || !this.porcupine) {
            console.log('[WakeWord] Not available — use manual trigger');
            return;
        }

        if (this.isListening) return;

        try {
            const { spawn } = require('child_process');
            const frameLength = this.porcupine.frameLength;
            const sampleRate = this.porcupine.sampleRate;

            const soxBin = process.env.SOX_PATH || 'sox';

            // Build sox args: on Windows use waveaudio driver
            const inputArgs = process.platform === 'win32'
                ? ['-t', 'waveaudio', 'default']
                : ['--default-device'];

            const args = [
                ...inputArgs,
                '--no-show-progress',
                '--rate', String(sampleRate),
                '--channels', '1',
                '--encoding', 'signed-integer',
                '--bits', '16',
                '--type', 'raw',
                '-',  // pipe to stdout
            ];

            this.recorder = spawn(soxBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

            let buffer = Buffer.alloc(0);
            const bytesPerFrame = frameLength * 2; // 16-bit PCM

            this.recorder.stdout.on('data', (data) => {
                buffer = Buffer.concat([buffer, data]);

                while (buffer.length >= bytesPerFrame) {
                    const frame = new Int16Array(buffer.buffer, buffer.byteOffset, frameLength);
                    buffer = buffer.slice(bytesPerFrame);

                    const keywordIndex = this.porcupine.process(frame);
                    if (keywordIndex >= 0) {
                        console.log('[WakeWord] Detected!');
                        this.emit('detected');
                    }
                }
            });

            this.recorder.stderr.on('data', (d) => {
                console.warn('[WakeWord] Sox stderr:', d.toString().trim());
            });

            this.recorder.on('error', (err) => {
                console.error('[WakeWord] Sox error:', err.message);
            });

            this.isListening = true;
            console.log('[WakeWord] Listening...');
        } catch (err) {
            console.error('[WakeWord] Failed to start recording:', err.message);
        }
    }

    /**
     * Stop listening.
     */
    stopListening() {
        if (this.recorder) {
            this.recorder.kill();
            this.recorder = null;
        }
        this.isListening = false;
    }

    /**
     * Manual trigger (for keyboard or UI button activation).
     */
    manualTrigger() {
        console.log('[WakeWord] Manual trigger');
        this.emit('detected');
    }

    /**
     * Clean up resources.
     */
    destroy() {
        this.stopListening();
        if (this.porcupine) {
            this.porcupine.release();
            this.porcupine = null;
        }
    }
}

module.exports = new WakeWordEngine();
