// ============================================================
// PRISMA -- Pulse Engine (Proactive Background Agent)
// ============================================================
// The Pulse Engine is PRISMA's heartbeat. It runs autonomously,
// monitoring emails, calendar, scheduled jobs, and GitHub repos
// to proactively notify the user without them needing to ask.
// ============================================================
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');
const { google } = require('googleapis');
const db = require('../core/database');
const { getAuthenticatedClient } = require('./auth');

// Intervals (ms)
const INTERVALS = {
    emailCheck: 5 * 60 * 1000,     // 5 minutes
    calendarCheck: 10 * 60 * 1000,  // 10 minutes
    jobRunner: 30 * 1000,           // 30 seconds
    reminderCheck: 10 * 1000,       // 10 seconds
    repoCheck: 10 * 60 * 1000,      // 10 minutes (auto-discover new repos and register webhooks)
    cleanup: 60 * 60 * 1000,        // 1 hour (cleanup old pulse logs)
};

class PulseEngine extends EventEmitter {
    constructor() {
        super();
        this.timers = {};
        this.running = false;
        this.notificationQueue = [];

        // GitHub monitoring state
        this._lastPushTimes = new Map();    // repoFullName -> pushedAt ISO string
        this._processedIssues = new Set();  // "owner/repo#123" strings
        this._ghAvailable = null;           // cached gh CLI check
    }

    /**
     * Start the Pulse Engine. Begins all monitoring loops.
     */
    start() {
        if (this.running) return;
        this.running = true;
        console.log('[Pulse] Engine started -- PRISMA is alive');

        // Start all monitoring loops
        this.timers.jobs = setInterval(() => this._runJobs(), INTERVALS.jobRunner);
        this.timers.reminders = setInterval(() => this._checkReminders(), INTERVALS.reminderCheck);
        this.timers.email = setInterval(() => this._checkEmails(), INTERVALS.emailCheck);
        this.timers.calendar = setInterval(() => this._checkCalendar(), INTERVALS.calendarCheck);
        this.timers.repos = setInterval(() => this._checkGitHubRepos(), INTERVALS.repoCheck);
        this.timers.cleanup = setInterval(() => this._cleanup(), INTERVALS.cleanup);

        // Recover any jobs stuck in 'running' from a previous crash
        this._recoverStuckJobs();

        // Run jobs and reminders immediately
        this._runJobs();
        this._checkReminders();

        // Delay first email/calendar/repo check by 30s to let systems settle
        setTimeout(() => {
            this._checkEmails();
            this._checkCalendar();
            this._checkGitHubRepos();
        }, 30000);

        // Listen for immediate post-push scans from gitTools
        this.on('repo:pushed', (data) => {
            this._runGuardianScan(data.folderPath, data.repoFullName, data.userId);
            // Immediately register webhook on this repo so future pushes/issues are caught
            this._registerWebhookForRepo(data.repoFullName);
        });
    }

    /**
     * Stop all monitoring loops.
     */
    stop() {
        this.running = false;
        for (const key of Object.keys(this.timers)) {
            clearInterval(this.timers[key]);
        }
        this.timers = {};
        console.log('[Pulse] Engine stopped');
    }

    /**
     * Get and clear pending notifications for polling.
     */
    getNotifications() {
        const batch = [...this.notificationQueue];
        this.notificationQueue = [];
        return batch;
    }

    /**
     * Push a notification to the queue (with deduplication).
     */
    _notify({ userId, source, sourceId, priority, title, body, actions }) {
        // Check if already notified
        if (db.hasPulseNotification(userId, source, sourceId)) {
            return;
        }

        // Log to prevent duplicates
        db.logPulseNotification({
            id: uuidv4(),
            userId,
            source,
            sourceId,
        });

        const notification = {
            id: uuidv4(),
            userId,
            source,
            sourceId,
            priority: priority || 'info', // 'urgent', 'important', 'info'
            title,
            body,
            actions: actions || [],
            timestamp: new Date().toISOString(),
        };

        this.notificationQueue.push(notification);
        this.emit('notification', notification);
        console.log(`[Pulse] [${priority?.toUpperCase() || 'INFO'}]: ${title}`);
    }

    // -- Email Monitor ----------------------------------------

    async _checkEmails() {
        try {
            const users = db.getAllUsers();
            for (const user of users) {
                await this._checkEmailsForUser(user);
            }
        } catch (err) {
            console.error('[Pulse/Email] Monitor error:', err.message);
        }
    }

    async _checkEmailsForUser(user) {
        try {
            const auth = await getAuthenticatedClient(user.id);
            const gmail = google.gmail({ version: 'v1', auth });

            // Get recent unread emails
            const res = await gmail.users.messages.list({
                userId: 'me',
                q: 'is:unread newer_than:1h',
                maxResults: 10,
            });

            if (!res.data.messages || res.data.messages.length === 0) return;

            const newEmails = [];
            for (const msg of res.data.messages) {
                // Skip if already notified
                if (db.hasPulseNotification(user.id, 'email', msg.id)) continue;

                const detail = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'metadata',
                    metadataHeaders: ['Subject', 'From', 'Date'],
                });

                const headers = detail.data.payload.headers;
                const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
                const from = headers.find(h => h.name === 'From')?.value || 'Unknown';

                newEmails.push({ id: msg.id, subject, from, snippet: detail.data.snippet });
            }

            // Filter out PRISMA's own emails (we send from the user's account)
            const filteredEmails = newEmails.filter(email => {
                const subj = (email.subject || '').toLowerCase();
                // Skip emails sent by PRISMA itself
                if (subj.includes('prisma') || subj.includes('push summary:') || subj.includes('security alert:') || subj.includes('pr for #')) {
                    return false;
                }
                return true;
            });

            if (filteredEmails.length === 0) return;

            for (const email of filteredEmails) {
                const priority = this._classifyEmailPriority(email);

                this._notify({
                    userId: user.id,
                    source: 'email',
                    sourceId: email.id,
                    priority,
                    title: priority === 'urgent' ? `[URGENT] ${email.subject}` : `[Email] ${email.subject}`,
                    body: `From: ${email.from}\n${email.snippet}`,
                    actions: [{ label: 'Open Gmail', type: 'open_url', url: `https://mail.google.com/mail/u/0/#inbox/${email.id}` }],
                });
            }

            if (filteredEmails.length > 1) {
                console.log(`[Pulse/Email] ${filteredEmails.length} new emails for ${user.name || user.email}`);
            }
        } catch (err) {
            // Token might be expired or user removed
            if (err.message?.includes('Token') || err.message?.includes('token')) {
                console.warn(`[Pulse/Email] Auth issue for ${user.id}: ${err.message}`);
            } else {
                console.error(`[Pulse/Email] Error for ${user.id}:`, err.message);
            }
        }
    }

    /**
     * Simple heuristic-based email priority classification.
     * Avoids costly AI calls for every email check.
     */
    _classifyEmailPriority(email) {
        const subject = (email.subject || '').toLowerCase();
        const from = (email.from || '').toLowerCase();

        // Urgent keywords
        const urgentKeywords = ['urgent', 'asap', 'emergency', 'critical', 'deadline', 'immediate', 'action required'];
        if (urgentKeywords.some(k => subject.includes(k))) return 'urgent';

        // Important: calendar invites, replies to your emails
        if (subject.includes('invitation') || subject.includes('re:') || subject.includes('meeting')) return 'important';

        // Everything else
        return 'info';
    }

    // -- Calendar Monitor -------------------------------------

    async _checkCalendar() {
        try {
            const users = db.getAllUsers();
            for (const user of users) {
                await this._checkCalendarForUser(user);
            }
        } catch (err) {
            console.error('[Pulse/Calendar] Monitor error:', err.message);
        }
    }

    async _checkCalendarForUser(user) {
        try {
            const auth = await getAuthenticatedClient(user.id);
            const calendar = google.calendar({ version: 'v3', auth });

            const now = new Date();
            const lookahead = new Date(now.getTime() + 20 * 60 * 1000); // 20 min ahead

            const res = await calendar.events.list({
                calendarId: 'primary',
                timeMin: now.toISOString(),
                timeMax: lookahead.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 5,
            });

            const events = res.data.items || [];

            for (const event of events) {
                const eventStart = new Date(event.start.dateTime || event.start.date);
                const minutesUntil = Math.round((eventStart.getTime() - now.getTime()) / 60000);

                // Notify for events 15 minutes away (+/-2 min window for polling tolerance)
                if (minutesUntil >= 0 && minutesUntil <= 17) {
                    const sourceId = `cal-${event.id}-${eventStart.toISOString().slice(0, 10)}`;

                    this._notify({
                        userId: user.id,
                        source: 'calendar',
                        sourceId,
                        priority: 'important',
                        title: `[Calendar] ${event.summary || 'Event'} in ${minutesUntil} min`,
                        body: this._buildMeetingBrief(event, minutesUntil),
                        actions: event.htmlLink ? [{ label: 'Open Calendar', type: 'open_url', url: event.htmlLink }] : [],
                    });
                }
            }
        } catch (err) {
            if (err.message?.includes('Token') || err.message?.includes('token')) {
                console.warn(`[Pulse/Calendar] Auth issue for ${user.id}: ${err.message}`);
            } else {
                console.error(`[Pulse/Calendar] Error for ${user.id}:`, err.message);
            }
        }
    }

    /**
     * Build a brief for an upcoming meeting.
     */
    _buildMeetingBrief(event, minutesUntil) {
        const parts = [`Starts in ${minutesUntil} minutes`];

        if (event.location) parts.push(`Location: ${event.location}`);

        if (event.hangoutLink) {
            parts.push(`Meet: ${event.hangoutLink}`);
        } else if (event.conferenceData?.entryPoints?.[0]?.uri) {
            parts.push(`Join: ${event.conferenceData.entryPoints[0].uri}`);
        }

        if (event.attendees && event.attendees.length > 0) {
            const names = event.attendees
                .filter(a => !a.self)
                .slice(0, 3)
                .map(a => a.displayName || a.email)
                .join(', ');
            if (names) parts.push(`With: ${names}`);
        }

        if (event.description) {
            parts.push(`Notes: ${event.description.substring(0, 150)}`);
        }

        return parts.join('\n');
    }

    // -- Scheduled Job Runner ---------------------------------

    async _runJobs() {
        try {
            const pendingJobs = db.getPendingJobs();
            for (const job of pendingJobs) {
                await this._executeJob(job);
            }
        } catch (err) {
            console.error('[Pulse/Jobs] Runner error:', err.message);
        }
    }

    async _executeJob(job) {
        console.log(`[Pulse/Jobs] Executing: ${job.type} (${job.id})`);
        db.updateJobStatus(job.id, 'running');

        try {
            switch (job.type) {
                case 'send_email':
                    await this._executeSendEmail(job);
                    break;
                case 'reminder':
                    this._notify({
                        userId: job.user_id,
                        source: 'job',
                        sourceId: job.id,
                        priority: 'important',
                        title: `[Reminder] ${job.payload.title || 'Scheduled Reminder'}`,
                        body: job.payload.body || job.payload.title || '',
                        actions: [],
                    });
                    break;
                default:
                    console.warn(`[Pulse/Jobs] Unknown job type: ${job.type}`);
            }

            // Handle recurring jobs
            if (job.recurring) {
                const nextRun = this._calculateNextRun(job.run_at, job.recurring);
                if (nextRun) {
                    db.rescheduleJob(job.id, nextRun);
                    console.log(`[Pulse/Jobs] Rescheduled recurring job ${job.id} for ${nextRun}`);
                    return;
                }
            }

            db.updateJobStatus(job.id, 'done');
        } catch (err) {
            console.error(`[Pulse/Jobs] Job ${job.id} failed:`, err.message);
            db.updateJobStatus(job.id, 'failed');

            this._notify({
                userId: job.user_id,
                source: 'job',
                sourceId: `${job.id}-error`,
                priority: 'important',
                title: `[FAILED] Scheduled task failed`,
                body: `${job.type}: ${err.message}`,
                actions: [],
            });
        }
    }

    async _executeSendEmail(job) {
        const { to, subject, body, cc } = job.payload;
        const auth = await getAuthenticatedClient(job.user_id);
        const gmail = google.gmail({ version: 'v1', auth });

        const headers = [
            `To: ${to}`,
            `Subject: ${subject}`,
            'Content-Type: text/plain; charset=utf-8',
            'MIME-Version: 1.0',
        ];
        if (cc) headers.push(`Cc: ${cc}`);

        const message = headers.join('\r\n') + '\r\n\r\n' + body;
        const encodedMessage = Buffer.from(message).toString('base64url');

        await gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw: encodedMessage },
        });

        this._notify({
            userId: job.user_id,
            source: 'job',
            sourceId: job.id,
            priority: 'info',
            title: `[OK] Scheduled email sent`,
            body: `To: ${to}\nSubject: ${subject}`,
            actions: [],
        });

        console.log(`[Pulse/Jobs] Email sent to ${to}: "${subject}"`);
    }

    /**
     * Calculate the next run time for a recurring job.
     */
    _calculateNextRun(lastRun, recurring) {
        const d = new Date(lastRun);
        switch (recurring) {
            case 'hourly':
                d.setHours(d.getHours() + 1);
                break;
            case 'daily':
                d.setDate(d.getDate() + 1);
                break;
            case 'weekly':
                d.setDate(d.getDate() + 7);
                break;
            default:
                return null;
        }
        return this._toSqliteDatetime(d);
    }

    /**
     * Convert a Date to SQLite-native format: YYYY-MM-DD HH:MM:SS (UTC)
     */
    _toSqliteDatetime(date) {
        return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    }

    /**
     * Recover jobs stuck in 'running' from a previous crash.
     */
    _recoverStuckJobs() {
        try {
            const stuck = db.db.prepare(
                "UPDATE scheduled_jobs SET status = 'pending' WHERE status = 'running'"
            ).run();
            if (stuck.changes > 0) {
                console.log(`[Pulse/Jobs] Recovered ${stuck.changes} stuck job(s) from previous session`);
            }
        } catch (err) {
            console.error('[Pulse/Jobs] Recovery error:', err.message);
        }
    }

    // -- Reminder Check (migrated from old scheduler) ---------

    _checkReminders() {
        try {
            const pending = db.getPendingReminders();
            for (const reminder of pending) {
                db.markReminderTriggered(reminder.id);
                this._notify({
                    userId: reminder.user_id,
                    source: 'reminder',
                    sourceId: reminder.id,
                    priority: 'important',
                    title: `[Reminder] ${reminder.title}`,
                    body: `Reminder: ${reminder.title}`,
                    actions: [],
                });
                this.emit('reminder', reminder);
            }
        } catch (err) {
            console.error('[Pulse/Reminders] Error:', err.message);
        }
    }

    // -- Cleanup ----------------------------------------------

    _cleanup() {
        try {
            db.cleanOldPulseLogs();
        } catch (err) {
            console.error('[Pulse/Cleanup] Error:', err.message);
        }
    }

    // -- GitHub Repo Monitor ----------------------------------

    /**
     * Check if gh CLI is available (cached).
     */
    _isGhAvailable() {
        if (this._ghAvailable !== null) return this._ghAvailable;
        try {
            execSync('gh auth status', {
                encoding: 'utf8', shell: true, timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            });
            this._ghAvailable = true;
        } catch (err) {
            const stderr = err.stderr
                ? (typeof err.stderr === 'string' ? err.stderr : err.stderr.toString('utf8'))
                : '';
            this._ghAvailable = !stderr.includes('not logged') && !stderr.includes('no accounts');
        }
        if (this._ghAvailable) {
            console.log('[Pulse/GitHub] GitHub CLI authenticated -- ready for webhooks');
        } else {
            console.log('[Pulse/GitHub] GitHub CLI not available -- webhooks disabled');
        }
        return this._ghAvailable;
    }

    /**
     * Send a styled HTML email to the user about a GitHub event.
     */
    async _sendGitHubEmail(userId, subject, bodyHtml) {
        try {
            const user = db.getAllUsers().find(u => u.id === userId);
            if (!user || !user.email) {
                console.warn('[Pulse/GitHub] No user email -- skipping email');
                return;
            }

            const auth = await getAuthenticatedClient(userId);
            const gmail = google.gmail({ version: 'v1', auth });

            const fullHtml = `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;">
                <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:20px 24px;border-radius:12px 12px 0 0;">
                    <h2 style="color:white;margin:0;font-size:18px;">PRISMA -- GitHub Agent</h2>
                </div>
                <div style="background:#1a1a2e;color:#e0e0e0;padding:24px;border-radius:0 0 12px 12px;line-height:1.6;">
                    ${bodyHtml}
                    <hr style="border:none;border-top:1px solid #333;margin:20px 0;">
                    <p style="color:#888;font-size:12px;margin:0;">Sent automatically by PRISMA</p>
                </div>
            </div>`;

            const headers = [
                `To: ${user.email}`,
                `Subject: ${subject}`,
                'Content-Type: text/html; charset=utf-8',
                'MIME-Version: 1.0',
            ];

            const message = headers.join('\r\n') + '\r\n\r\n' + fullHtml;
            const encodedMessage = Buffer.from(message).toString('base64url');

            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw: encodedMessage },
            });

            console.log(`[Pulse/GitHub] Email sent to ${user.email}: ${subject}`);
        } catch (err) {
            console.error(`[Pulse/GitHub] Email failed:`, err.message);
        }
    }

    /**
     * Auto-discover all user repos and register our ngrok webhook on them.
     */
    async _checkGitHubRepos() {
        try {
            if (!this._isGhAvailable()) return;

            const tunnelManager = require('./tunnel');
            const publicUrl = tunnelManager.getUrl();
            if (!publicUrl) {
                console.log('[Pulse/GitHub] Tunnel not ready yet, skipping webhook registration.');
                return;
            }

            const webhookUrl = `${publicUrl}/webhooks/github`;

            let repos;
            try {
                // Get all repos you own.
                const raw = execSync(
                    'gh repo list --json nameWithOwner --limit 50',
                    { encoding: 'utf8', shell: true, timeout: 30000, windowsHide: true }
                ).trim();
                if (!raw) return;
                repos = JSON.parse(raw);
            } catch { return; }

            if (!repos || repos.length === 0) return;

            for (const repo of repos) {
                this._registerWebhookForRepo(repo.nameWithOwner);
            }
        } catch (err) {
            console.error('[Pulse/GitHub] Webhook sync error:', err.message);
        }
    }

    /**
     * Register a webhook on a single repo. Reusable for both batch discovery and instant push triggers.
     */
    _registerWebhookForRepo(repoName) {
        try {
            if (!this._isGhAvailable()) return;

            const tunnelManager = require('./tunnel');
            const publicUrl = tunnelManager.getUrl();
            if (!publicUrl) return;

            const webhookUrl = `${publicUrl}/webhooks/github`;

            // Only register if we haven't already for this tunnel instance
            if (!this._registeredWebhooks) this._registeredWebhooks = new Set();
            if (this._registeredWebhooks.has(repoName)) return;

            // Check existing hooks to avoid duplicates
            const existingRaw = execSync(`gh api repos/${repoName}/hooks --jq .[].config.url`, {
                encoding: 'utf8', shell: true, timeout: 10000, windowsHide: true
            }).trim();

            // Check if any ngrok webhook already points to our endpoint
            if (existingRaw.includes('ngrok') && existingRaw.includes('/webhooks/github')) {
                if (existingRaw.includes(webhookUrl)) {
                    this._registeredWebhooks.add(repoName);
                    return;
                }
                // Delete old ngrok hooks before creating the new one
                try {
                    const hooksJson = execSync(`gh api repos/${repoName}/hooks`, {
                        encoding: 'utf8', shell: true, timeout: 10000, windowsHide: true
                    });
                    const hooks = JSON.parse(hooksJson);
                    for (const hook of hooks) {
                        if (hook.config?.url?.includes('ngrok') && hook.config?.url?.includes('/webhooks/github')) {
                            try {
                                execSync(`gh api repos/${repoName}/hooks/${hook.id} -X DELETE`, {
                                    encoding: 'utf8', shell: true, timeout: 10000, windowsHide: true
                                });
                            } catch { /* ignore */ }
                        }
                    }
                } catch { /* ignore cleanup errors */ }
            }

            // Create the hook
            const payload = {
                name: 'web',
                active: true,
                events: ['push', 'issues'],
                config: {
                    url: webhookUrl,
                    content_type: 'json',
                    insecure_ssl: '0'
                }
            };

            const tmpFile = require('path').join(require('os').tmpdir(), `prisma-hook-${Date.now()}.json`);
            require('fs').writeFileSync(tmpFile, JSON.stringify(payload), 'utf8');
            try {
                execSync(`gh api repos/${repoName}/hooks -X POST --input "${tmpFile}"`, {
                    encoding: 'utf8', shell: true, timeout: 15000, windowsHide: true
                });
            } finally {
                try { require('fs').unlinkSync(tmpFile); } catch { }
            }

            console.log(`[Pulse/GitHub] Registered Webhook on ${repoName} -> ${webhookUrl}`);
            this._registeredWebhooks.add(repoName);
        } catch (err) {
            const errMsg = err.message || '';
            if (errMsg.includes('422')) {
                if (!this._registeredWebhooks) this._registeredWebhooks = new Set();
                this._registeredWebhooks.add(repoName);
            } else if (!errMsg.includes('404') && !errMsg.includes('403')) {
                console.error(`[Pulse/GitHub] Hook error on ${repoName}:`, errMsg);
            }
        }
    }

    /**
     * Post-push local scan (from push_to_github tool). Sends email.
     */
    _runGuardianScan(folderPath, repoFullName, userId) {
        try {
            const { scanProject } = require('../tools/repoGuardian');
            const report = scanProject(folderPath);

            let emailBody;
            let subject;

            if (report.status === 'clean') {
                subject = `Clean push: ${repoFullName}`;
                emailBody = `<h3>Clean Push -- ${repoFullName}</h3>
                    <p>${report.summary}</p>
                    <p><strong>${report.stats.filesScanned}</strong> files scanned</p>
                    <p><a href="https://github.com/${repoFullName}" style="color:#667eea;">View Repository &rarr;</a></p>`;
            } else {
                subject = `Security alert: ${repoFullName} -- ${report.risks.length} issue(s)`;
                const riskList = report.risks
                    .map(r => `<li>${r.severity === 'critical' ? '&#x1F534;' : '&#x1F7E1;'} <strong>${r.severity.toUpperCase()}:</strong> ${r.message}<br><em style="color:#aaa;">Fix: ${r.fix}</em></li>`)
                    .join('');
                emailBody = `<h3>Security Issues -- ${repoFullName}</h3>
                    <p>${report.summary}</p>
                    <ul style="list-style:none;padding:0;">${riskList}</ul>
                    <p><a href="https://github.com/${repoFullName}" style="color:#667eea;">View Repository &rarr;</a></p>`;
            }

            this._sendGitHubEmail(userId, subject, emailBody);

            this._notify({
                userId: userId || 'system',
                source: 'github',
                sourceId: `guardian-${repoFullName}-${Date.now()}`,
                priority: report.status === 'critical' ? 'urgent' : report.status === 'warning' ? 'important' : 'info',
                title: `${report.status === 'clean' ? '[OK]' : '[ALERT]'} Repo Guardian: ${repoFullName}`,
                body: report.summary,
                actions: [{ label: 'View on GitHub', type: 'open_url', url: `https://github.com/${repoFullName}` }],
            });

            console.log(`[Pulse/Guardian] Scanned ${repoFullName}: ${report.status}`);
        } catch (err) {
            console.error(`[Pulse/Guardian] Scan error:`, err.message);
        }
    }

    /**
     * Remote guardian scan (external push detected via webhook). Sends email.
     */
    _runGuardianScanRemote(repoFullName, userId) {
        try {
            const risks = [];

            // Check .env
            try {
                execSync(`gh api repos/${repoFullName}/contents/.env --jq .name`, {
                    encoding: 'utf8', shell: true, timeout: 10000,
                    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
                });
                risks.push({ severity: 'critical', msg: '.env file is committed -- secrets may be exposed!' });
            } catch { /* good */ }

            // Check node_modules
            try {
                execSync(`gh api repos/${repoFullName}/contents/node_modules --jq .[0].name`, {
                    encoding: 'utf8', shell: true, timeout: 10000,
                    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
                });
                risks.push({ severity: 'warning', msg: 'node_modules/ is committed' });
            } catch { /* good */ }

            // Get commit info
            let commitMsg = '', commitAuthor = '', changedFiles = '';
            try {
                const raw = execSync(
                    `gh api repos/${repoFullName}/commits --jq ".[0] | [.commit.message, .commit.author.name] | @tsv"`,
                    { encoding: 'utf8', shell: true, timeout: 10000, windowsHide: true }
                ).trim();
                const parts = raw.split('\t');
                commitMsg = (parts[0] || '').substring(0, 120);
                commitAuthor = parts[1] || '';
            } catch { /* ignore */ }

            try {
                const sha = execSync(
                    `gh api repos/${repoFullName}/commits --jq ".[0].sha"`,
                    { encoding: 'utf8', shell: true, timeout: 10000, windowsHide: true }
                ).trim();
                if (sha) {
                    const stats = execSync(
                        `gh api repos/${repoFullName}/commits/${sha} --jq "[.stats.additions, .stats.deletions] | @tsv"`,
                        { encoding: 'utf8', shell: true, timeout: 10000, windowsHide: true }
                    ).trim();
                    const [add, del] = stats.split('\t');
                    changedFiles = `+${add || 0} / -${del || 0}`;
                }
            } catch { /* ignore */ }

            const isClean = risks.length === 0;
            let emailBody, subject;

            if (isClean) {
                subject = `Push summary: ${repoFullName}`;
                emailBody = `<h3>New Push -- ${repoFullName}</h3>
                    <table style="border-collapse:collapse;width:100%;">
                        <tr><td style="padding:6px 0;color:#aaa;width:80px;">Commit</td><td style="padding:6px 0;">${commitMsg || 'N/A'}</td></tr>
                        <tr><td style="padding:6px 0;color:#aaa;">Author</td><td style="padding:6px 0;">${commitAuthor || 'N/A'}</td></tr>
                        <tr><td style="padding:6px 0;color:#aaa;">Changes</td><td style="padding:6px 0;">${changedFiles || 'N/A'}</td></tr>
                        <tr><td style="padding:6px 0;color:#aaa;">Security</td><td style="padding:6px 0;color:#4ade80;">No risks</td></tr>
                    </table>
                    <p><a href="https://github.com/${repoFullName}" style="color:#667eea;">View Repository &rarr;</a></p>`;
            } else {
                subject = `Security alert: ${repoFullName}`;
                const riskList = risks.map(r => `<li>${r.severity === 'critical' ? '&#x1F534;' : '&#x1F7E1;'} ${r.msg}</li>`).join('');
                emailBody = `<h3>Security Issues -- ${repoFullName}</h3>
                    ${commitMsg ? `<p><strong>Commit:</strong> ${commitMsg}</p>` : ''}
                    <ul style="list-style:none;padding:0;">${riskList}</ul>
                    <p style="color:#f87171;"><strong>Action needed.</strong></p>
                    <p><a href="https://github.com/${repoFullName}" style="color:#667eea;">View Repository &rarr;</a></p>`;
            }

            // Use a STABLE sourceId based on repo + risk signature so the same
            // alert (e.g. .env committed) is only sent ONCE per repo, not on every push.
            const riskSignature = risks.map(r => r.msg).sort().join('|') || 'clean';

            // Deduplicate (Daily Hybrid): only send email if this exact alert hasn't been sent TODAY
            const today = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
            const alertKey = `email-guardian-${repoFullName}-${riskSignature}-${today}`;
            const sysUserId = userId || 'system';

            if (!db.hasPulseNotification(sysUserId, 'github-alert-email', alertKey)) {
                db.logPulseNotification({
                    id: `log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    userId: sysUserId,
                    source: 'github-alert-email',
                    sourceId: alertKey
                });
                this._sendGitHubEmail(userId, subject, emailBody);
            } else {
                console.log(`[Pulse/Guardian] Skipping duplicate daily alert email for ${repoFullName}`);
            }

            this._notify({
                userId: userId || 'system',
                source: 'github',
                sourceId: `guardian-remote-${repoFullName}-${riskSignature}`,
                priority: isClean ? 'info' : 'urgent',
                title: `${isClean ? '[OK]' : '[ALERT]'} Push detected: ${repoFullName}`,
                body: isClean ? `Clean push -- ${commitMsg}` : risks.map(r => r.msg).join(', '),
                actions: [{ label: 'View Repo', type: 'open_url', url: `https://github.com/${repoFullName}` }],
            });
        } catch (err) {
            console.error(`[Pulse/Guardian] Remote scan error:`, err.message);
        }
    }

    /**
     * Handle a SINGLE new issue from a webhook. Uses AI to solve it.
     */
    async _handleNewIssue(repoFullName, userId, issue) {
        try {
            const issueKey = `${repoFullName}#${issue.number}`;
            if (this._processedIssues.has(issueKey)) return;
            this._processedIssues.add(issueKey);

            const { solveIssueAndCreatePR } = require('../tools/issuePrTools');
            console.log(`[Pulse/IssueSolver] Solving issue #${issue.number} on ${repoFullName}...`);

            const result = await solveIssueAndCreatePR(repoFullName, issue);

            if (result.success) {
                const aiTag = result.aiGenerated ? 'AI-Solved' : 'Draft';
                const filesInfo = result.filesChanged > 0
                    ? `<p><strong>Files changed:</strong> ${result.filesChanged}</p>`
                    : '';

                const emailBody = `<h3>${aiTag} PR Created -- ${repoFullName}</h3>
                    <p><strong>Issue:</strong> #${result.issueNumber} -- ${issue.title}</p>
                    <p><strong>PR:</strong> ${result.prTitle}</p>
                    ${filesInfo}
                    <p>${result.aiGenerated
                        ? 'PRISMA analyzed the codebase and generated code changes to solve this issue.'
                        : 'A draft PR was created for manual implementation.'}</p>
                    <p>
                        <a href="https://github.com/${repoFullName}/pulls" style="color:#667eea;">View PRs &rarr;</a> &bull;
                        <a href="https://github.com/${repoFullName}/issues/${result.issueNumber}" style="color:#667eea;">View Issue &rarr;</a>
                    </p>`;

                this._sendGitHubEmail(userId, `${aiTag} PR for #${result.issueNumber} -- ${repoFullName}`, emailBody);

                this._notify({
                    userId: userId || 'system',
                    source: 'github',
                    sourceId: `pr-${repoFullName}-${result.issueNumber}-${Date.now()}`,
                    priority: 'info',
                    title: `[PR] ${aiTag} PR for issue #${result.issueNumber}`,
                    body: `${result.prTitle}\n${result.output}`,
                    actions: [{ label: 'View PRs', type: 'open_url', url: `https://github.com/${repoFullName}/pulls` }],
                });
            } else {
                console.warn(`[Pulse/IssueSolver] Failed for #${result.issueNumber}: ${result.error}`);
            }
        } catch (err) {
            console.error(`[Pulse/IssueSolver] Error for ${repoFullName} #${issue.number}:`, err.message);
        }
    }

    /**
     * Process ALL open issues for a repo (used by manual generate_pr_from_issue tool).
     */
    async _handleNewIssues(repoFullName, userId) {
        try {
            const { processNewIssues } = require('../tools/issuePrTools');
            const results = await processNewIssues(repoFullName, this._processedIssues);

            for (const result of results) {
                if (result.success) {
                    const aiTag = result.aiGenerated ? 'AI-Solved' : 'Draft';
                    const emailBody = `<h3>${aiTag} PR Created -- ${repoFullName}</h3>
                        <p><strong>Issue:</strong> #${result.issueNumber}</p>
                        <p><strong>PR:</strong> ${result.prTitle}</p>
                        <p>
                            <a href="https://github.com/${repoFullName}/pulls" style="color:#667eea;">View PRs &rarr;</a> &bull;
                            <a href="https://github.com/${repoFullName}/issues/${result.issueNumber}" style="color:#667eea;">View Issue &rarr;</a>
                        </p>`;

                    this._sendGitHubEmail(userId, `${aiTag} PR for #${result.issueNumber} -- ${repoFullName}`, emailBody);

                    this._notify({
                        userId: userId || 'system',
                        source: 'github',
                        sourceId: `pr-${repoFullName}-${result.issueNumber}-${Date.now()}`,
                        priority: 'info',
                        title: `[PR] ${aiTag} PR for issue #${result.issueNumber}`,
                        body: `${result.prTitle}\nRepo: ${repoFullName}`,
                        actions: [{ label: 'View PRs', type: 'open_url', url: `https://github.com/${repoFullName}/pulls` }],
                    });
                } else {
                    console.warn(`[Pulse/IssuePR] Failed PR for #${result.issueNumber}: ${result.error}`);
                }
            }
        } catch (err) {
            if (!err.message.includes('Cannot find module')) {
                console.error(`[Pulse/IssuePR] Error for ${repoFullName}:`, err.message);
            }
        }
    }
}

module.exports = new PulseEngine();
