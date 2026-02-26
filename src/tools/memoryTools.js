// ============================================================
// PRISMA — Memory Tools (Cross-Chat Persistent Memory)
// ============================================================
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const { registerTool } = require('../core/toolRegistry');
const db = require('../core/database');

// ════════════════════════════════════════════════════════════
// TOOL: store_memory
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'store_memory',
    description: `Save a fact or preference about the user to long-term memory. BE PROACTIVE: You should call this automatically whenever you learn new information. NOTE: You can and should call this tool MULTIPLE times or ALONGSIDE other tools (like send_email) in the same turn if you learn a fact while performing another task.
Examples:
- "Dinesh's email is..." -> call store_memory + proceed with email.
- "I prefer dark mode" -> call store_memory.`,
    schema: z.object({
        key: z.string().describe('Short descriptive label, e.g. "Dinesh email" or "preferred timezone"'),
        value: z.string().describe('The actual fact to remember, e.g. "dinesh@example.com" or "IST (Asia/Kolkata)"'),
        category: z.string().optional().describe('Category: "contact", "preference", "schedule", or "fact" (default: "fact")'),
    }),
    async execute(args, context) {
        const id = uuidv4();
        db.upsertMemory({
            id,
            userId: context.userId,
            key: args.key.toLowerCase().trim(),
            value: args.value.trim(),
            category: args.category || 'fact',
        });

        return {
            success: true,
            key: args.key,
            value: args.value,
            message: `Remembered: "${args.key}" = "${args.value}"`,
        };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: recall_memory
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'recall_memory',
    description: `Search long-term memory for stored facts about the user. Use this when you need to look up something the user previously told you, like a contact's email, a preference, or a scheduled event.`,
    schema: z.object({
        query: z.string().describe('Search query — can be a name, topic, or keyword, e.g. "Dinesh" or "timezone"'),
    }),
    async execute(args, context) {
        const results = db.searchMemories(context.userId, args.query.trim());

        if (results.length === 0) {
            return {
                found: false,
                message: `No memories found matching "${args.query}".`,
            };
        }

        return {
            found: true,
            memories: results,
            count: results.length,
        };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: forget_memory
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'forget_memory',
    description: `Delete a specific fact from long-term memory. Use when the user asks you to forget something or when information is outdated.`,
    schema: z.object({
        key: z.string().describe('The key of the memory to delete, e.g. "Dinesh email"'),
    }),
    async execute(args, context) {
        const existing = db.getMemory(context.userId, args.key.toLowerCase().trim());
        if (!existing) {
            return { success: false, message: `No memory found with key "${args.key}".` };
        }

        db.deleteMemory(context.userId, args.key.toLowerCase().trim());
        return {
            success: true,
            message: `Forgot: "${args.key}"`,
        };
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: update_memory
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'update_memory',
    description: `Update an existing fact in long-term memory with a new value. Use when the user provides updated information about something you already know, e.g. a new email address, changed preference, or corrected fact. If the key doesn't exist yet, it will be stored as new.`,
    schema: z.object({
        key: z.string().describe('The key of the memory to update, e.g. "Dinesh email" or "preferred language"'),
        newValue: z.string().describe('The updated value, e.g. "dinesh.new@example.com"'),
        category: z.string().optional().describe('Category: "contact", "preference", "schedule", or "fact" (default: keeps existing)'),
    }),
    async execute(args, context) {
        const keyNorm = args.key.toLowerCase().trim();
        const existing = db.getMemory(context.userId, keyNorm);
        const oldValue = existing ? existing.value : null;

        db.upsertMemory({
            id: existing ? existing.id : uuidv4(),
            userId: context.userId,
            key: keyNorm,
            value: args.newValue.trim(),
            category: args.category || (existing ? existing.category : 'fact'),
        });

        if (oldValue) {
            return {
                success: true,
                message: `Updated: "${args.key}" from "${oldValue}" → "${args.newValue}"`,
                oldValue,
                newValue: args.newValue,
            };
        }

        return {
            success: true,
            message: `Stored (new): "${args.key}" = "${args.newValue}"`,
            newValue: args.newValue,
        };
    },
});
