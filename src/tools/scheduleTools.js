// ============================================================
// PRISMA — Schedule Tools (Delayed & Recurring Actions)
// ============================================================
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const { registerTool } = require('../core/toolRegistry');
const db = require('../core/database');

// ════════════════════════════════════════════════════════════
// TOOL: schedule_email
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'schedule_email',
    description: `Schedule an email to be sent automatically at a specific date and time. Use this when the user says things like "email X tomorrow at 9 AM" or "send this email at 5 PM". The email will be sent automatically by PRISMA's background engine.`,
    schema: z.object({
        to: z.string().describe('Recipient email address'),
        subject: z.string().describe('Email subject line'),
        body: z.string().describe('Email body text'),
        date: z.string().describe('Send date in YYYY-MM-DD format'),
        time: z.string().describe('Send time in HH:MM format (24-hour)'),
        cc: z.string().optional().describe('CC email address (optional)'),
    }),
    async execute(args, context) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(args.to)) {
            return { success: false, error: 'Invalid recipient email address' };
        }

        const runAt = new Date(`${args.date}T${args.time}:00`);
        if (isNaN(runAt.getTime())) {
            return { success: false, error: 'Invalid date or time format. Use YYYY-MM-DD and HH:MM.' };
        }

        if (runAt.getTime() < Date.now()) {
            return { success: false, error: 'Scheduled time is in the past. Please provide a future date/time.' };
        }

        const id = uuidv4();
        db.createJob({
            id,
            userId: context.userId,
            type: 'send_email',
            payload: {
                to: args.to,
                subject: args.subject,
                body: args.body,
                cc: args.cc || null,
            },
            runAt: runAt.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
        });

        return {
            success: true,
            jobId: id,
            type: 'send_email',
            to: args.to,
            subject: args.subject,
            scheduledFor: runAt.toLocaleString(),
            message: `Email to ${args.to} scheduled for ${runAt.toLocaleString()}. PRISMA will send it automatically.`,
        };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: schedule_action
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'schedule_action',
    description: `Schedule a generic action to happen at a specific time. Supports one-time and recurring actions. Use for reminders with custom payloads, scheduled checks, etc.`,
    schema: z.object({
        title: z.string().describe('Description of what should happen'),
        date: z.string().describe('Date in YYYY-MM-DD format'),
        time: z.string().describe('Time in HH:MM format (24-hour)'),
        recurring: z.string().optional().describe('Recurrence: "daily", "weekly", "hourly", or omit for one-time'),
    }),
    async execute(args, context) {
        const runAt = new Date(`${args.date}T${args.time}:00`);
        if (isNaN(runAt.getTime())) {
            return { success: false, error: 'Invalid date or time format.' };
        }

        const validRecurring = ['daily', 'weekly', 'hourly'];
        if (args.recurring && !validRecurring.includes(args.recurring)) {
            return { success: false, error: `Invalid recurring value. Use: ${validRecurring.join(', ')}` };
        }

        const id = uuidv4();
        db.createJob({
            id,
            userId: context.userId,
            type: 'reminder',
            payload: { title: args.title, body: args.title },
            runAt: runAt.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
            recurring: args.recurring,
        });

        const recurLabel = args.recurring ? ` (repeats ${args.recurring})` : '';
        return {
            success: true,
            jobId: id,
            scheduledFor: runAt.toLocaleString(),
            recurring: args.recurring || null,
            message: `Action scheduled for ${runAt.toLocaleString()}${recurLabel}`,
        };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: list_scheduled_jobs
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'list_scheduled_jobs',
    description: `List all pending scheduled jobs for the current user. Shows scheduled emails, reminders, and other automated actions.`,
    schema: z.object({}),
    async execute(args, context) {
        const jobs = db.getJobsByUser(context.userId);

        if (jobs.length === 0) {
            return { jobs: [], message: 'No pending scheduled jobs.' };
        }

        return {
            jobs: jobs.map(j => ({
                id: j.id,
                type: j.type,
                scheduledFor: new Date(j.run_at).toLocaleString(),
                recurring: j.recurring || null,
                details: j.type === 'send_email'
                    ? `To: ${j.payload.to}, Subject: ${j.payload.subject}`
                    : j.payload.title || j.payload.body || '',
            })),
            count: jobs.length,
        };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: cancel_scheduled_job
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'cancel_scheduled_job',
    description: `Cancel a pending scheduled job by its ID. Use list_scheduled_jobs first to get the job ID.`,
    schema: z.object({
        job_id: z.string().describe('The ID of the scheduled job to cancel'),
    }),
    async execute(args, context) {
        const jobs = db.getJobsByUser(context.userId);
        const job = jobs.find(j => j.id === args.job_id);

        if (!job) {
            return { success: false, error: 'Job not found or already completed.' };
        }

        db.deleteJob(args.job_id);
        return {
            success: true,
            message: `Cancelled scheduled ${job.type}: ${job.payload.title || job.payload.subject || job.id}`,
        };
    },
});
