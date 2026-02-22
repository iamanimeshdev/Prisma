// ============================================================
// PRISMA — Calendar Tools (Google Calendar Integration)
// ============================================================
const { z } = require('zod');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const { getAuthenticatedClient } = require('../services/auth');
const { registerTool } = require('../core/toolRegistry');
const db = require('../core/database');

// ── Helper: Get Calendar client ────────────────────────────
async function getCalendar(userId) {
    const auth = await getAuthenticatedClient(userId);
    return google.calendar({ version: 'v3', auth });
}

// ════════════════════════════════════════════════════════════
// TOOL: create_calendar_event
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'create_calendar_event',
    description: 'Create a new event on the user\'s Google Calendar. Default duration is 1 hour.',
    schema: z.object({
        title: z.string().describe('Event title / summary'),
        date: z.string().describe('Event date in YYYY-MM-DD format'),
        time: z.string().describe('Event start time in HH:MM format (24-hour)'),
        duration_minutes: z.number().optional().describe('Duration in minutes (default 60)'),
        description: z.string().optional().describe('Event description'),
        location: z.string().optional().describe('Event location'),
    }),
    async execute(args, context) {
        const calendar = await getCalendar(context.userId);
        const duration = args.duration_minutes || 60;

        const startDateTime = new Date(`${args.date}T${args.time}:00`);
        const endDateTime = new Date(startDateTime.getTime() + duration * 60 * 1000);

        if (isNaN(startDateTime.getTime())) {
            return { success: false, error: 'Invalid date or time format. Use YYYY-MM-DD and HH:MM.' };
        }

        const event = {
            summary: args.title,
            start: {
                dateTime: startDateTime.toISOString(),
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            end: {
                dateTime: endDateTime.toISOString(),
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
        };

        if (args.description) event.description = args.description;
        if (args.location) event.location = args.location;

        const res = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: event,
        });

        return {
            success: true,
            eventId: res.data.id,
            title: args.title,
            start: startDateTime.toISOString(),
            end: endDateTime.toISOString(),
            link: res.data.htmlLink,
        };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: get_upcoming_events
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'get_upcoming_events',
    description: 'Get the next upcoming events from the user\'s Google Calendar.',
    schema: z.object({
        count: z.number().optional().describe('Number of events to fetch (default 5, max 15)'),
    }),
    async execute(args, context) {
        const count = Math.min(args.count || 5, 15);
        const calendar = await getCalendar(context.userId);

        const res = await calendar.events.list({
            calendarId: 'primary',
            timeMin: new Date().toISOString(),
            maxResults: count,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = (res.data.items || []).map((e) => ({
            id: e.id,
            title: e.summary || '(No Title)',
            start: e.start.dateTime || e.start.date,
            end: e.end.dateTime || e.end.date,
            location: e.location || null,
            description: e.description ? e.description.substring(0, 200) : null,
            link: e.htmlLink,
        }));

        if (events.length === 0) {
            return { events: [], message: 'No upcoming events found.' };
        }

        return { events, count: events.length };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: create_reminder
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'create_reminder',
    description: 'Create a local reminder that will notify the user at the specified date and time.',
    schema: z.object({
        title: z.string().describe('Reminder title / description'),
        date: z.string().describe('Reminder date in YYYY-MM-DD format'),
        time: z.string().describe('Reminder time in HH:MM format (24-hour)'),
    }),
    async execute(args, context) {
        const datetime = `${args.date}T${args.time}:00`;
        const parsed = new Date(datetime);

        if (isNaN(parsed.getTime())) {
            return { success: false, error: 'Invalid date or time format.' };
        }

        const id = uuidv4();
        db.createReminder({
            id,
            userId: context.userId,
            title: args.title,
            datetime,
        });

        return {
            success: true,
            reminderId: id,
            title: args.title,
            datetime,
            message: `Reminder set for ${parsed.toLocaleString()}`,
        };
    },
});
