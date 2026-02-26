// ============================================================
// PRISMA — Email Tools (Gmail Integration)
// ============================================================
const { z } = require('zod');
const { google } = require('googleapis');
const { getAuthenticatedClient } = require('../services/auth');
const { registerTool } = require('../core/toolRegistry');

// ── Helper: Get Gmail client ───────────────────────────────
async function getGmail(userId) {
    const auth = await getAuthenticatedClient(userId);
    return google.gmail({ version: 'v1', auth });
}

// ── Helper: Decode email body ──────────────────────────────
function decodeBody(payload) {
    let body = '';

    if (payload.body && payload.body.data) {
        body = Buffer.from(payload.body.data, 'base64').toString('utf8');
    } else if (payload.parts) {
        for (const part of payload.parts) {
            if (part.mimeType === 'text/plain' && part.body && part.body.data) {
                body = Buffer.from(part.body.data, 'base64').toString('utf8');
                break;
            }
        }
        // Fallback to HTML if no plain text
        if (!body) {
            for (const part of payload.parts) {
                if (part.mimeType === 'text/html' && part.body && part.body.data) {
                    body = Buffer.from(part.body.data, 'base64').toString('utf8');
                    // Strip HTML tags for plain text
                    body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    break;
                }
            }
        }
    }
    return body;
}

// ── Helper: Get header value ───────────────────────────────
function getHeader(headers, name) {
    const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return header ? header.value : '';
}

// ════════════════════════════════════════════════════════════
// TOOL: get_unread_emails
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'get_unread_emails',
    description: 'Get the top 5 unread emails from the user\'s Gmail inbox. Returns subject, sender, date, and a snippet for each.',
    schema: z.object({
        count: z.number().optional().describe('Number of emails to fetch (default 5, max 10)'),
    }),
    async execute(args, context) {
        const count = Math.min(args.count || 5, 10);
        const gmail = await getGmail(context.userId);

        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread',
            maxResults: count,
        });

        if (!res.data.messages || res.data.messages.length === 0) {
            return { emails: [], message: 'No unread emails found.' };
        }

        const emails = [];
        for (const msg of res.data.messages) {
            const detail = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'metadata',
                metadataHeaders: ['Subject', 'From', 'Date'],
            });

            emails.push({
                id: msg.id,
                subject: getHeader(detail.data.payload.headers, 'Subject') || '(No Subject)',
                from: getHeader(detail.data.payload.headers, 'From'),
                date: getHeader(detail.data.payload.headers, 'Date'),
                snippet: detail.data.snippet,
            });
        }

        return { emails, count: emails.length };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: summarize_email
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'summarize_email',
    description: 'Fetch and summarize recent emails. Returns the full content of recent emails for the AI to summarize.',
    schema: z.object({
        count: z.number().optional().describe('Number of recent emails to summarize (default 5)'),
    }),
    async execute(args, context) {
        const count = Math.min(args.count || 5, 10);
        const gmail = await getGmail(context.userId);

        const res = await gmail.users.messages.list({
            userId: 'me',
            maxResults: count,
        });

        if (!res.data.messages || res.data.messages.length === 0) {
            return { emails: [], message: 'No emails found.' };
        }

        const emails = [];
        for (const msg of res.data.messages) {
            const detail = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'full',
            });

            const subject = getHeader(detail.data.payload.headers, 'Subject') || '(No Subject)';
            const from = getHeader(detail.data.payload.headers, 'From');
            const date = getHeader(detail.data.payload.headers, 'Date');
            const body = decodeBody(detail.data.payload);

            emails.push({
                subject,
                from,
                date,
                body: body.substring(0, 1000), // Limit body length
            });
        }

        return {
            emails,
            instruction: 'Please provide a concise summary of each email above.',
        };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: extract_event_from_email
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'extract_event_from_email',
    description: 'Extract potential calendar event details from a specific email. If an event is detected from a trusted source, it can be added to the calendar.',
    schema: z.object({
        email_id: z.string().describe('The Gmail message ID to extract event from'),
    }),
    async execute(args, context) {
        const gmail = await getGmail(context.userId);

        const detail = await gmail.users.messages.get({
            userId: 'me',
            id: args.email_id,
            format: 'full',
        });

        const subject = getHeader(detail.data.payload.headers, 'Subject') || '';
        const from = getHeader(detail.data.payload.headers, 'From');
        const body = decodeBody(detail.data.payload);

        return {
            email_id: args.email_id,
            subject,
            from,
            body: body.substring(0, 2000),
            instruction: 'Analyze this email and extract any event details. Return: event_detected (boolean), title, date, time, confidence (0-1). If the sender appears to be a trusted source (known contacts, organizations, services), note that as well.',
        };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: send_email
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'send_email',
    description: 'Send an email IMMEDIATELY from the user\'s Gmail account. WARNING: This sends INSTANTLY. If the user wants to send an email later, at a specific time, or in X minutes, use the schedule_email tool instead — NOT this one.',
    schema: z.object({
        to: z.string().describe('Recipient email address'),
        subject: z.string().describe('Email subject line'),
        body: z.string().describe('Email body text'),
        cc: z.string().optional().describe('CC email address (optional)'),
    }),
    async execute(args, context) {
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(args.to)) {
            return { success: false, error: 'Invalid recipient email address' };
        }
        if (args.cc && !emailRegex.test(args.cc)) {
            return { success: false, error: 'Invalid CC email address' };
        }

        const gmail = await getGmail(context.userId);

        // Build RFC 2822 message
        const headers = [
            `To: ${args.to}`,
            `Subject: ${args.subject}`,
            'Content-Type: text/plain; charset=utf-8',
            'MIME-Version: 1.0',
        ];
        if (args.cc) headers.push(`Cc: ${args.cc}`);

        const message = headers.join('\r\n') + '\r\n\r\n' + args.body;
        const encodedMessage = Buffer.from(message).toString('base64url');

        const res = await gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw: encodedMessage },
        });

        return {
            success: true,
            messageId: res.data.id,
            to: args.to,
            subject: args.subject,
        };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: monitor_email_sender
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'monitor_email_sender',
    description: 'Proactively monitor all incoming emails from a specific sender. The AI will instantly notify the user if an email arrives from this address.',
    schema: z.object({
        sender: z.string().describe('The email address to monitor (e.g., boss@company.com)'),
    }),
    async execute(args, context) {
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(args.sender)) {
            return { success: false, error: 'Invalid email address format' };
        }

        const db = require('../core/database');
        try {
            db.addMonitoredEmail(context.userId, args.sender);
            return {
                success: true,
                message: `Now monitoring incoming emails from ${args.sender}. You will be alerted instantly when they email you.`
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: stop_monitoring_sender
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'stop_monitoring_sender',
    description: 'Stop proactively monitoring a specific sender.',
    schema: z.object({
        sender: z.string().describe('The email address to stop monitoring'),
    }),
    async execute(args, context) {
        const db = require('../core/database');
        try {
            db.removeMonitoredEmail(context.userId, args.sender);
            return {
                success: true,
                message: `Stopped monitoring incoming emails from ${args.sender}.`
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    },
});
