// ============================================================
// PRISMA — Express Server (Local API Gateway)
// ============================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');

const { mountAuthRoutes, requireAuth } = require('./services/auth');
const { initGemini, callGemini, callGeminiStreaming } = require('./core/ai');
const { loadContext, appendMessage } = require('./core/context');
const db = require('./core/database');
const scheduler = require('./services/scheduler');

// Memory queue for triggered reminders (to be polled by frontend)
const triggeredRemindersQueue = [];

// Register tools (side-effect: populates tool registry)
require('./tools/emailTools');
require('./tools/calendarTools');
require('./tools/memoryTools');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────
app.use(cors({
    origin: ['http://localhost:3000', 'app://./'],
    credentials: true,
}));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'prisma-default-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // localhost
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
}));

// ── Auth Routes ────────────────────────────────────────────
mountAuthRoutes(app);

// ── Conversation CRUD ──────────────────────────────────────
app.get('/api/conversations', requireAuth, (req, res) => {
    const conversations = db.getConversations(req.session.userId);
    res.json({ conversations });
});

app.post('/api/conversations', requireAuth, (req, res) => {
    const id = uuidv4();
    const title = req.body.title || 'New Chat';
    db.createConversation({ id, userId: req.session.userId, title });
    res.json({ id, title });
});

app.patch('/api/conversations/:id', requireAuth, (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    db.updateConversationTitle(req.params.id, title);
    res.json({ success: true });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
    db.deleteConversation(req.params.id);
    res.json({ success: true });
});

// ── Chat Endpoint (conversation-scoped) ────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
    try {
        const { message, conversationId } = req.body;
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message is required' });
        }
        if (!conversationId) {
            return res.status(400).json({ error: 'conversationId is required' });
        }

        const userId = req.session.userId;
        const user = db.getUser(userId);
        if (!user) {
            return res.status(401).json({ error: 'User not found. Please re-authenticate.' });
        }

        // Save user message
        appendMessage(userId, conversationId, 'user', message.trim());

        // Load conversation context
        const context = loadContext(conversationId);

        // Call Gemini with tools
        const reply = await callGemini(context, user);

        // Save assistant response
        appendMessage(userId, conversationId, 'assistant', reply);

        // Auto-title: if conversation is still "New Chat" and this is the first user message,
        // use the first few words as the title
        const conv = db.getConversation(conversationId);
        if (conv && conv.title === 'New Chat') {
            const autoTitle = message.trim().substring(0, 40) + (message.length > 40 ? '...' : '');
            db.updateConversationTitle(conversationId, autoTitle);
        }

        res.json({ reply });
    } catch (err) {
        console.error('[Chat] Error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// ── Streaming Chat Endpoint (SSE) ──────────────────────────
app.post('/api/chat/stream', requireAuth, async (req, res) => {
    try {
        const { message, conversationId } = req.body;
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message is required' });
        }
        if (!conversationId) {
            return res.status(400).json({ error: 'conversationId is required' });
        }

        const userId = req.session.userId;
        const user = db.getUser(userId);
        if (!user) {
            return res.status(401).json({ error: 'User not found. Please re-authenticate.' });
        }

        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        appendMessage(userId, conversationId, 'user', message.trim());
        const context = loadContext(conversationId);

        const reply = await callGeminiStreaming(
            context,
            user,
            (chunk) => {
                res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
            },
            (toolName) => {
                res.write(`data: ${JSON.stringify({ type: 'tool', name: toolName })}\n\n`);
            }
        );

        appendMessage(userId, conversationId, 'assistant', reply);

        // Auto-title
        const conv = db.getConversation(conversationId);
        if (conv && conv.title === 'New Chat') {
            const autoTitle = message.trim().substring(0, 40) + (message.length > 40 ? '...' : '');
            db.updateConversationTitle(conversationId, autoTitle);
        }

        res.write(`data: ${JSON.stringify({ type: 'done', text: reply })}\n\n`);
        res.end();
    } catch (err) {
        console.error('[Chat Stream] Error:', err);
        try {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            res.end();
        } catch {
            // Response already ended
        }
    }
});

// ── Voice Chat Endpoint (same logic, different source tag) ─
app.post('/api/voice-chat', requireAuth, async (req, res) => {
    try {
        const { message, conversationId } = req.body;
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const userId = req.session.userId;
        const user = db.getUser(userId);
        if (!user) {
            return res.status(401).json({ error: 'User not found.' });
        }

        // Use provided conversationId or create a voice conversation
        let activeConvId = conversationId;
        if (!activeConvId) {
            activeConvId = uuidv4();
            db.createConversation({ id: activeConvId, userId, title: `Voice: ${message.trim().substring(0, 30)}` });
        }

        appendMessage(userId, activeConvId, 'user', `[voice] ${message.trim()}`);
        const context = loadContext(activeConvId);
        const reply = await callGemini(context, user);
        appendMessage(userId, activeConvId, 'assistant', reply);

        res.json({ reply, conversationId: activeConvId });
    } catch (err) {
        console.error('[VoiceChat] Error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// ── Reminders ──────────────────────────────────────────────
app.get('/api/reminders/triggered', requireAuth, (req, res) => {
    const list = [...triggeredRemindersQueue];
    triggeredRemindersQueue.length = 0; // Clear queue
    res.json({ reminders: list });
});

// ── Message History (conversation-scoped) ──────────────────
app.get('/api/messages/:conversationId', requireAuth, (req, res) => {
    const messages = db.getConversationMessages(req.params.conversationId);
    res.json({ messages });
});

// ── Health Check ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
    });
});

// ── Start Server ───────────────────────────────────────────
function startServer() {
    initGemini();
    scheduler.start();

    // Listen for triggered reminders
    scheduler.on('reminder', (reminder) => {
        console.log(`[Reminder] (!!) "${reminder.title}" - User: ${reminder.user_id}`);
        triggeredRemindersQueue.push(reminder);
    });

    return new Promise((resolve) => {
        const server = app.listen(PORT, () => {
            console.log(`\n  +--------------------------------------+`);
            console.log(`  |   PRISMA Server running on :${PORT}     |`);
            console.log(`  +--------------------------------------+\n`);
            resolve(server);
        });
    });
}

// If run directly (not imported by Electron)
if (require.main === module) {
    startServer();
}

module.exports = { app, startServer };
