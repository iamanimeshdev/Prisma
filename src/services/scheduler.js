// ============================================================
// PRISMA — Scheduler (Reminder Polling)
// ============================================================
const db = require('../core/database');
const EventEmitter = require('events');

class Scheduler extends EventEmitter {
    constructor(intervalMs = 10000) {
        super();
        this.intervalMs = intervalMs;
        this.timer = null;
    }

    start() {
        console.log('[Scheduler] Started — polling every', this.intervalMs / 1000, 'seconds');
        this.timer = setInterval(() => this.checkReminders(), this.intervalMs);
        // Run immediately on start
        this.checkReminders();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            console.log('[Scheduler] Stopped');
        }
    }

    checkReminders() {
        try {
            // Heartbeat — useful for debugging speed
            console.log('[Scheduler] Heartbeat - Time:', db.db.prepare("SELECT datetime('now') as now").get().now);
            const pending = db.getPendingReminders();
            if (pending.length > 0) {
                console.log(`[Scheduler] Check: Found ${pending.length} pending reminders`);
            }
            for (const reminder of pending) {
                console.log(`[Scheduler] Triggering reminder: "${reminder.title}" for user ${reminder.user_id}`);
                db.markReminderTriggered(reminder.id);
                this.emit('reminder', reminder);
            }
        } catch (err) {
            console.error('[Scheduler] Error checking reminders:', err.message);
        }
    }
}

module.exports = new Scheduler();
