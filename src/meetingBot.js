// ============================================================
// PRISMA — Meeting Bot (Placeholder)
// ============================================================

/**
 * Placeholder module for future Meeting Bot support.
 *
 * Planned features:
 * - Real-time meeting transcription
 * - Transcript storage and retrieval
 * - Auto-summary generation via Gemini
 * - Action item extraction
 * - Query past meetings
 *
 * DB table `meetings` is already created in db.js
 */

async function startTranscription(userId, meetingId) {
    console.log('[MeetingBot] Not yet implemented — startTranscription');
    return { success: false, message: 'Meeting bot is not yet implemented.' };
}

async function getSummary(userId, meetingId) {
    console.log('[MeetingBot] Not yet implemented — getSummary');
    return { summary: null, message: 'Meeting bot is not yet implemented.' };
}

async function queryMeetings(userId, query) {
    console.log('[MeetingBot] Not yet implemented — queryMeetings');
    return { results: [], message: 'Meeting bot is not yet implemented.' };
}

module.exports = { startTranscription, getSummary, queryMeetings };
