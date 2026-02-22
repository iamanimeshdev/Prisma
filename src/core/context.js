// ============================================================
// PRISMA — Context Manager (Conversation Memory)
// ============================================================
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

/**
 * Build the system prompt for a user session.
 * Injects global memories so Gemini knows stored facts.
 */
function getSystemPrompt(user) {
    const name = user?.name || 'User';
    const email = user?.email || '';

    // Load global memories for this user
    let memoryBlock = '';
    if (user?.id) {
        const memories = db.getAllMemories(user.id);
        if (memories.length > 0) {
            const memLines = memories.map((m) => `- ${m.key}: ${m.value}`).join('\n');
            memoryBlock = `\n\nYour Long-Term Memory (facts you've remembered about this user):\n${memLines}\nUse these facts naturally. When the user tells you new facts (names, emails, preferences), use the store_memory tool to save them.\n`;
        } else {
            memoryBlock = `\n\nYou have no stored memories yet. When the user tells you important facts (like "Dinesh's email is xyz@gmail.com", or their preferences), use the store_memory tool to remember them for future conversations.\n`;
        }
    }

    return `You are PRISMA — Personal Research & Intelligent System Manager Assistant.
You are a helpful, intelligent AI assistant running locally on the user's desktop.

Current user: ${name} (${email})
Current date/time: ${new Date().toLocaleString()}

Your capabilities:
- Read and send emails via the user's Gmail
- Manage Google Calendar events
- Create local reminders
- Answer questions and have conversations
- Execute tools when appropriate
- Remember facts about the user across conversations (use store_memory / recall_memory tools)

Guidelines:
- Be concise but thorough
- When the user asks about emails, use the email tools
- When the user asks about calendar or scheduling, use the calendar tools
- When creating events from emails, confirm details with the user first
- Always be helpful and proactive
- If a tool call fails, explain the issue clearly
- Never fabricate data — only return real results from tools
- When the user tells you someone's contact info, preferences, or important facts, ALWAYS use store_memory to save it immediately.
- BE PROACTIVE: If you ask for an email address and the user provides it, call store_memory to save it (e.g., "Dinesh's email") AND then proceed with the original task.
- When you see a new email address linked to a name (like "send email to animeshkrish@gmail.com"), save that relationship to memory automatically.
- When the user mentions a name and you have their info in memory, use it naturally without asking again.
${memoryBlock}
Future capabilities (not yet active): document knowledge base, meeting transcription.
`;
}

/**
 * Load conversation messages for a specific conversation.
 */
function loadContext(conversationId) {
    if (!conversationId) return [];

    const messages = db.getConversationMessages(conversationId);
    const mapped = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : m.role,
        parts: [{ text: m.content }],
    }));

    // Gemini requires history to start with 'user' role
    const firstUserIdx = mapped.findIndex((m) => m.role === 'user');
    if (firstUserIdx > 0) {
        return mapped.slice(firstUserIdx);
    }
    return mapped;
}

/**
 * Append a message to a conversation.
 */
function appendMessage(userId, conversationId, role, content) {
    db.saveMessage({
        id: uuidv4(),
        userId,
        conversationId,
        role,
        content,
    });
}

module.exports = { getSystemPrompt, loadContext, appendMessage };
