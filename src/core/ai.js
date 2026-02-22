// ============================================================
// PRISMA — Gemini Integration (AI Gateway)
// ============================================================
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getGeminiFunctionDeclarations, executeTool } = require('./toolRegistry');
const { getSystemPrompt } = require('./context');

let genAI = null;

function initGemini() {
    if (!process.env.GEMINI_API_KEY) {
        console.warn('[Gemini] No API key configured — AI features disabled');
        return;
    }
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log('[Gemini] Initialized');
}

/**
 * Call Gemini with conversation history and optional tools.
 * Handles multi-step tool execution loops.
 *
 * @param {Array} messages - Conversation history [{role, parts}]
 * @param {object} user - User object {id, email, name}
 * @param {object} [options] - { enableTools: boolean }
 * @returns {string} Final assistant text response
 */
async function callGemini(messages, user, options = {}) {
    if (!genAI) {
        throw new Error('Gemini is not configured. Please set GEMINI_API_KEY in .env');
    }

    const { enableTools = true } = options;

    // Build function declarations from registered tools
    const functionDeclarations = enableTools ? getGeminiFunctionDeclarations() : [];

    // Create model with tools
    const modelConfig = {
        model: 'gemini-3-flash-preview',
        systemInstruction: getSystemPrompt(user),
    };

    if (functionDeclarations.length > 0 && enableTools) {
        modelConfig.tools = [{ functionDeclarations }];
    }

    const model = genAI.getGenerativeModel(modelConfig);

    // Start chat with history
    const chat = model.startChat({
        history: messages.slice(0, -1), // all but last message
    });

    // Send the latest user message
    const lastMessage = messages[messages.length - 1];
    let result = await chat.sendMessage(lastMessage.parts);
    let response = result.response;

    // ── Tool execution loop (max 5 iterations to prevent infinite loops) ──
    const MAX_TOOL_LOOPS = 5;
    let loopCount = 0;

    while (loopCount < MAX_TOOL_LOOPS) {
        const candidate = response.candidates?.[0];
        if (!candidate) break;

        const parts = candidate.content?.parts || [];
        const functionCall = parts.find((p) => p.functionCall);

        if (!functionCall) break; // No tool call — we have the final response

        const { name, args } = functionCall.functionCall;
        console.log(`[Gemini] Tool call: ${name}`, args);

        let toolResult;
        try {
            toolResult = await executeTool(name, args, {
                userId: user.id,
                userEmail: user.email,
            });
        } catch (err) {
            console.error(`[Gemini] Tool execution error:`, err.message);
            toolResult = { error: err.message };
        }

        // Send tool result back to Gemini
        result = await chat.sendMessage([
            {
                functionResponse: {
                    name,
                    response: { result: toolResult },
                },
            },
        ]);
        response = result.response;
        loopCount++;
    }

    // Extract final text response
    const text = response.text();
    return text || 'I processed your request but have no additional response.';
}

module.exports = { initGemini, callGemini };
