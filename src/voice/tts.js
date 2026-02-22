// ============================================================
// PRISMA — Text-to-Speech (using 'say' package)
// ============================================================
const say = require('say');

/**
 * Speak text aloud using the system TTS engine.
 * @param {string} text - Text to speak
 * @returns {Promise<void>}
 */
function speak(text) {
    return new Promise((resolve, reject) => {
        if (!text || text.trim().length === 0) {
            resolve();
            return;
        }

        // Clean text for TTS (remove markdown, special chars)
        const cleanText = text
            .replace(/[*_`#\[\]()]/g, '')  // Remove markdown
            .replace(/\n+/g, '. ')          // Newlines to pauses
            .replace(/\s+/g, ' ')           // Collapse whitespace
            .trim();

        console.log('[TTS] Speaking:', cleanText.substring(0, 80) + '...');

        say.speak(cleanText, null, 1.0, (err) => {
            if (err) {
                console.error('[TTS] Error:', err.message);
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

/**
 * Stop any ongoing speech.
 */
function stopSpeaking() {
    say.stop();
}

module.exports = { speak, stopSpeaking };
