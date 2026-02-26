// ============================================================
// PRISMA — Telegram Bot Integration (Webhook Mode)
// ============================================================
// Connects PRISMA to Telegram using webhooks via the existing
// ngrok tunnel. Instant delivery — no polling overhead.
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const { callAI } = require('../core/ai');
const { loadContext, appendMessage } = require('../core/context');
const db = require('../core/database');

let bot = null;

// Map Telegram chatId → PRISMA conversationId
const chatConversations = new Map();

/**
 * Start the Telegram bot using webhooks.
 * @param {Express} app - Express app to mount webhook route on
 */
function startTelegramBot(app) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.log('[Telegram] No TELEGRAM_BOT_TOKEN — bot disabled');
        return;
    }

    const ownerId = process.env.TELEGRAM_OWNER_ID;
    if (!ownerId) {
        console.warn('[Telegram] No TELEGRAM_OWNER_ID — anyone can message this bot!');
    }

    // Create bot WITHOUT polling — we'll use webhooks
    bot = new TelegramBot(token, { polling: false });

    // Mount the webhook endpoint on Express
    const webhookPath = `/webhooks/telegram/${token}`;
    app.post(webhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });

    // Register webhook when ngrok tunnel is ready
    const tunnel = require('./tunnel');
    tunnel.onReady(async (publicUrl) => {
        const webhookUrl = `${publicUrl}${webhookPath}`;
        try {
            await bot.setWebHook(webhookUrl);
            const me = await bot.getMe();
            console.log(`[Telegram] Bot active: @${me.username} (webhook)`);
            console.log(`[Telegram] Webhook: ${webhookUrl}`);
        } catch (err) {
            console.error('[Telegram] Webhook setup failed:', err.message);
            console.log('[Telegram] Falling back to polling...');
            bot.startPolling();
        }
    });

    // If tunnel is already ready
    if (tunnel.getUrl()) {
        const webhookUrl = `${tunnel.getUrl()}${webhookPath}`;
        bot.setWebHook(webhookUrl).then(async () => {
            const me = await bot.getMe();
            console.log(`[Telegram] Bot active: @${me.username} (webhook)`);
            console.log(`[Telegram] Webhook: ${webhookUrl}`);
        }).catch((err) => {
            console.error('[Telegram] Webhook setup failed:', err.message);
            console.log('[Telegram] Falling back to polling...');
            bot.startPolling();
        });
    }

    // ── Message handler ────────────────────────────────────
    bot.on('message', async (msg) => {
        if (!msg.text && !msg.voice) return;

        const chatId = msg.chat.id;

        // Security: only allow the owner
        if (ownerId && String(chatId) !== String(ownerId)) {
            bot.sendMessage(chatId, '🔒 Unauthorized. This bot is private.');
            return;
        }

        if (msg.voice) {
            await handleVoiceMessage(chatId, msg);
            return;
        }

        if (msg.text.startsWith('/')) {
            await handleCommand(chatId, msg.text);
            return;
        }

        await handleTextMessage(chatId, msg.text, msg.from);
    });

    bot.on('polling_error', (err) => {
        if (err.code !== 'ETELEGRAM') {
            console.error('[Telegram] Polling error:', err.message);
        }
    });
}

/**
 * Handle text messages — send to AI and reply.
 */
async function handleTextMessage(chatId, text, from) {
    const typing = setTyping(chatId);

    try {
        const user = getOrCreateUser(chatId, from);
        const convId = getConversationId(chatId);

        appendMessage(user.id, convId, 'user', text.trim());
        const context = loadContext(convId);
        const reply = await callAI(context, user);
        appendMessage(user.id, convId, 'assistant', reply);

        await sendLongMessage(chatId, reply);
    } catch (err) {
        console.error('[Telegram] Error:', err.message);
        bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    } finally {
        clearInterval(typing);
    }
}

/**
 * Handle voice messages — download, transcribe, then process as text.
 */
async function handleVoiceMessage(chatId, msg) {
    const typing = setTyping(chatId);

    try {
        const user = getOrCreateUser(chatId, msg.from);

        bot.sendMessage(chatId, '🎤 Transcribing your voice...');

        // Download the voice file (OGG from Telegram)
        const fileId = msg.voice.file_id;
        const filePath = await bot.downloadFile(fileId, os.tmpdir());

        // Convert OGG → WAV
        const wavPath = filePath.replace(/\.\w+$/, '.wav');
        await convertAudio(filePath, wavPath);

        // Transcribe
        const text = await transcribeAudio(wavPath);

        // Cleanup
        try { fs.unlinkSync(filePath); } catch (e) { }
        try { fs.unlinkSync(wavPath); } catch (e) { }

        if (!text || text.trim().length === 0) {
            bot.sendMessage(chatId, "🤷 Couldn't understand the voice message. Try again?");
            clearInterval(typing);
            return;
        }

        bot.sendMessage(chatId, `🗣️ *You said:* ${text}`, { parse_mode: 'Markdown' });
        await handleTextMessage(chatId, text, msg.from);
    } catch (err) {
        console.error('[Telegram] Voice error:', err.message);
        bot.sendMessage(chatId, `❌ Voice processing failed: ${err.message}`);
    } finally {
        clearInterval(typing);
    }
}

/**
 * Handle bot commands.
 */
async function handleCommand(chatId, text) {
    const cmd = text.split(' ')[0].toLowerCase();

    switch (cmd) {
        case '/start':
            bot.sendMessage(chatId,
                `👋 *Hi! I'm PRISMA* — your Personal AI Assistant.\n\n` +
                `I can help with:\n` +
                `📧 Emails — read, send, schedule\n` +
                `📅 Calendar — create events\n` +
                `⏰ Reminders\n` +
                `🧠 Memory — I remember things about you\n` +
                `🔧 GitHub — push repos, scan for security\n\n` +
                `Just type a message or send a voice note!`,
                { parse_mode: 'Markdown' }
            );
            break;

        case '/new':
            chatConversations.delete(chatId);
            bot.sendMessage(chatId, '🔄 New conversation started.');
            break;

        case '/help':
            bot.sendMessage(chatId,
                `*Commands:*\n` +
                `/new — Start a fresh conversation\n` +
                `/help — Show this message\n\n` +
                `Or just type/speak naturally!`,
                { parse_mode: 'Markdown' }
            );
            break;

        default:
            await handleTextMessage(chatId, text, null);
    }
}

// ── Helpers ────────────────────────────────────────────────

function getOrCreateUser(chatId, from) {
    // Reuse the primary desktop user so Telegram shares the same
    // memories, emails, and calendar access
    const allUsers = db.getAllUsers();
    if (allUsers.length > 0) {
        return allUsers[0];
    }

    const tgUserId = `telegram_${chatId}`;
    let user = db.getUser(tgUserId);
    if (!user) {
        const name = from
            ? [from.first_name, from.last_name].filter(Boolean).join(' ')
            : 'Telegram User';
        db.upsertUser({ id: tgUserId, email: '', name, picture: '' });
        user = db.getUser(tgUserId);
    }
    return user;
}

function getConversationId(chatId) {
    if (chatConversations.has(chatId)) {
        return chatConversations.get(chatId);
    }

    const convId = uuidv4();
    db.createConversation({
        id: convId,
        userId: getOrCreateUser(chatId).id,
        title: 'Telegram Chat',
    });
    chatConversations.set(chatId, convId);
    return convId;
}

function setTyping(chatId) {
    bot.sendChatAction(chatId, 'typing');
    return setInterval(() => {
        bot.sendChatAction(chatId, 'typing').catch(() => { });
    }, 4000);
}

async function sendLongMessage(chatId, text) {
    const MAX_LEN = 4096;
    if (text.length <= MAX_LEN) {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() => {
            bot.sendMessage(chatId, text);
        });
        return;
    }

    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= MAX_LEN) { chunks.push(remaining); break; }
        let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN);
        if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', MAX_LEN);
        if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', MAX_LEN);
        if (splitAt <= 0) splitAt = MAX_LEN;
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt).trim();
    }

    for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(() => {
            bot.sendMessage(chatId, chunk);
        });
    }
}

function convertAudio(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', [
            '-i', inputPath, '-ar', '16000', '-ac', '1', '-y', outputPath,
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg failed')));
        proc.on('error', (err) => reject(err));
    });
}

async function transcribeAudio(wavPath) {
    const { isReady, getBaseUrl } = require('../voice/voiceServer');

    if (isReady()) {
        const res = await fetch(`${getBaseUrl()}/stt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio_path: wavPath }),
        });
        const data = await res.json();
        if (data.ok) return data.text;
        throw new Error(data.error || 'Transcription failed');
    }

    // Fallback: spawn Python
    return new Promise((resolve, reject) => {
        const pythonPath = process.env.PYTHON_PATH || 'python';
        const script = `import sys,warnings\nwarnings.filterwarnings("ignore")\nfrom faster_whisper import WhisperModel\nm=WhisperModel("small",device="cpu",compute_type="int8")\ns,i=m.transcribe(sys.argv[1],language="en",beam_size=5)\nprint(" ".join([x.text for x in s]).strip())`;
        const p = spawn(pythonPath, ['-c', script, wavPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', (c) => c === 0 ? resolve(out.trim()) : reject(new Error('STT failed')));
        p.on('error', (e) => reject(e));
    });
}

function stopTelegramBot() {
    if (bot) {
        bot.deleteWebHook().catch(() => { });
        bot = null;
    }
}

module.exports = { startTelegramBot, stopTelegramBot };
