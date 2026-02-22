// ============================================================
// PRISMA — Scheduler (Reminder Polling)
// ============================================================
const db = require('../core/database');
const EventEmitter = require('events');

class Scheduler extends EventEmitter {
    constructor(intervalMs = 60000) {
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
            const pending = db.getPendingReminders();
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
