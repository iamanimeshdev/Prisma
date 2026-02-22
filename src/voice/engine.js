// ============================================================
// PRISMA — Voice Engine Orchestrator
// ============================================================
const EventEmitter = require('events');
const wakeWord = require('./wakeWord');
const { listen } = require('./stt');
const { speak, stopSpeaking } = require('./tts');

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
        this._chatHandler = null; // Set by Electron main process
    }

    /**
     * Initialize the voice engine.
     */
    async initialize() {
        await wakeWord.initialize();

        wakeWord.on('detected', () => {
            this._onWakeWordDetected();
        });

        console.log('[VoiceEngine] Initialized');
    }

    /**
     * Set the chat handler function that sends messages to the backend.
     * @param {Function} handler - async (text) => responseText
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
        if (this.enabled) {
            this.disable();
        } else {
            this.enable();
        }
        return this.enabled;
    }

    /**
     * Manual trigger (from UI button or keyboard shortcut).
     */
    manualTrigger() {
        if (this.state === STATE.SPEAKING) {
            stopSpeaking();
        }
        this._onWakeWordDetected();
    }

    /**
     * Handle wake word detection.
     */
    async _onWakeWordDetected() {
        if (!this.enabled && this.state !== STATE.IDLE) return;
        if (this.state === STATE.RECORDING || this.state === STATE.PROCESSING) return;

        try {
            // Stop listening for wake word during recording
            wakeWord.stopListening();
            stopSpeaking();

            // Record user speech
            this._setState(STATE.RECORDING);
            this.emit('stateChange', this.state);

            const text = await listen(5000); // 5 second recording

            if (!text || text.trim().length === 0) {
                console.log('[VoiceEngine] No speech detected');
                this._resumeListening();
                return;
            }

            console.log('[VoiceEngine] User said:', text);
            this.emit('userSpeech', text);

            // Process through chat
            this._setState(STATE.PROCESSING);

            if (this._chatHandler) {
                const response = await this._chatHandler(text);
                console.log('[VoiceEngine] Assistant response:', response?.substring(0, 100));
                this.emit('assistantResponse', response);

                // Speak response
                this._setState(STATE.SPEAKING);
                await speak(response);
            }
        } catch (err) {
            console.error('[VoiceEngine] Error:', err.message);
            this.emit('error', err);
        } finally {
            this._resumeListening();
        }
    }

    /**
     * Resume listening for wake word.
     */
    _resumeListening() {
        if (this.enabled) {
            this._setState(STATE.LISTENING_WAKE);
            wakeWord.startListening();
        } else {
            this._setState(STATE.IDLE);
        }
    }

    /**
     * Update state and emit change event.
     */
    _setState(newState) {
        this.state = newState;
        this.emit('stateChange', newState);
    }

    /**
     * Get current state.
     */
    getState() {
        return {
            state: this.state,
            enabled: this.enabled,
            wakeWordAvailable: wakeWord.available,
        };
    }

    /**
     * Clean up.
     */
    destroy() {
        this.disable();
        wakeWord.destroy();
    }
}

module.exports = new VoiceEngine();
