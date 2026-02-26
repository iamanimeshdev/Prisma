// ============================================================
// PRISMA — Voice Engine Orchestrator
// ============================================================
const EventEmitter = require('events');
const wakeWord = require('./wakeWord');
const { listen } = require('./stt');
const { speak, stopSpeaking, precache, destroy: destroyTTS } = require('./tts');
const { startVoiceServer, destroyVoiceServer } = require('./voiceServer');

// Voice states
const STATE = {
    IDLE: 'idle',
    LISTENING_WAKE: 'listening_wake',
    RECORDING: 'recording',
    PROCESSING: 'processing',
    SPEAKING: 'speaking',
};

class VoiceEngine extends EventEmitter {
    constructor() {
        super();
        this.state = STATE.IDLE;
        this.enabled = false;
        this._chatHandler = null;
        this._hasGreeted = false; // Greet only once on first wake
    }

    /**
     * Initialize the voice engine.
     */
    async initialize() {
        // Start unified Python voice server (loads Whisper + edge-tts)
        await startVoiceServer();

        // Pre-cache the greeting for instant playback
        precache('greeting', 'Hi, this is Prism! What can I do for you today?');

        await wakeWord.initialize();

        wakeWord.on('detected', () => {
            this._onWakeWordDetected();
        });

        console.log('[VoiceEngine] Initialized');

        // Auto-enable listening on startup — always on
        this.enable();
    }

    /**
     * Set the chat handler function that sends messages to the backend.
     */
    setChatHandler(handler) {
        this._chatHandler = handler;
    }

    /**
     * Enable voice interaction and start listening for wake word.
     */
    enable() {
        this.enabled = true;
        this._setState(STATE.LISTENING_WAKE);
        wakeWord.startListening();
        console.log('[VoiceEngine] Enabled');
    }

    /**
     * Disable voice interaction.
     */
    disable() {
        this.enabled = false;
        wakeWord.stopListening();
        stopSpeaking();
        this._setState(STATE.IDLE);
        console.log('[VoiceEngine] Disabled');
    }

    /**
     * Toggle voice on/off.
     */
    toggle() {
        if (this.enabled) this.disable();
        else this.enable();
        return this.enabled;
    }

    /**
     * Manual trigger (from UI button or keyboard shortcut).
     */
    manualTrigger() {
        if (this.state === STATE.SPEAKING) stopSpeaking();
        this._onWakeWordDetected();
    }

    /**
     * Handle wake word detection.
     */
    async _onWakeWordDetected() {
        // If speaking, interrupt — stop speech and go straight to recording
        if (this.state === STATE.SPEAKING) {
            console.log('[VoiceEngine] Interrupted by wake word');
            stopSpeaking();
            this._interrupted = true;
            // Fall through to start recording
        }

        if (this.state === STATE.RECORDING || this.state === STATE.PROCESSING) return;

        this._interrupted = false;

        try {
            wakeWord.stopListening();
            stopSpeaking();

            // Greet only on first wake word after app startup
            if (!this._hasGreeted) {
                this._setState(STATE.SPEAKING);
                console.log('[VoiceEngine] First wake — greeting user');
                await speak('Hi, this is Prism! What can I do for you today?', 'greeting');
                this._hasGreeted = true;
            }

            // Record user speech
            this._setState(STATE.RECORDING);
            this.emit('stateChange', this.state);

            const text = await listen(7000);

            if (!text || text.trim().length === 0) {
                console.log('[VoiceEngine] No speech detected');
                this._resumeListening();
                return;
            }

            console.log('[VoiceEngine] User said:', text);
            this.emit('userSpeech', text);

            this._setState(STATE.PROCESSING);

            if (this._chatHandler) {
                const response = await this._chatHandler(text);
                console.log('[VoiceEngine] Response:', response?.substring(0, 100));
                this.emit('assistantResponse', response);

                // Speak response — but keep wake word active so user can interrupt
                this._setState(STATE.SPEAKING);
                wakeWord.startListening();
                await speak(response);
            }
        } catch (err) {
            // Ignore errors from interrupted speech
            if (!this._interrupted) {
                console.error('[VoiceEngine] Error:', err.message);
                this.emit('error', err);
            }
        } finally {
            this._resumeListening();
        }
    }

    _resumeListening() {
        if (this.enabled) {
            this._setState(STATE.LISTENING_WAKE);
            wakeWord.startListening();
        } else {
            this._setState(STATE.IDLE);
        }
    }

    _setState(newState) {
        this.state = newState;
        this.emit('stateChange', newState);
    }

    getState() {
        return {
            state: this.state,
            enabled: this.enabled,
            wakeWordAvailable: wakeWord.available,
        };
    }

    destroy() {
        this.disable();
        wakeWord.destroy();
        destroyTTS();
        destroyVoiceServer();
    }
}

module.exports = new VoiceEngine();
