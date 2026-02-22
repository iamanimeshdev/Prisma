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
        model: 'gemini-2.5-flash',
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

    // ── Tool execution loop (handles parallel tool calls) ──
    const MAX_TOOL_LOOPS = 5;
    let loopCount = 0;
    const startTime = Date.now();

    while (loopCount < MAX_TOOL_LOOPS) {
        const candidate = response.candidates?.[0];
        if (!candidate) break;

        const parts = candidate.content?.parts || [];
        const functionCalls = parts.filter((p) => p.functionCall);

        if (functionCalls.length === 0) break; // No tool calls — final response

        // Execute ALL tool calls in this response (parallel)
        const toolResponses = await Promise.all(
            functionCalls.map(async (fc) => {
                const { name, args } = fc.functionCall;
                console.log(`[Gemini] Tool call: ${name}`, args);

                let toolResult;
                try {
                    toolResult = await executeTool(name, args, {
                        userId: user.id,
                        userEmail: user.email,
                    });
                } catch (err) {
                    console.error(`[Gemini] Tool error (${name}):`, err.message);
                    toolResult = { error: err.message };
                }

                return {
                    functionResponse: {
                        name,
                        response: { result: toolResult },
                    },
                };
            })
        );

        // Send ALL tool results back to Gemini in one batch
        result = await chat.sendMessage(toolResponses);
        response = result.response;
        loopCount++;
    }

    console.log(`[Gemini] Response in ${Date.now() - startTime}ms (${loopCount} tool loops)`);

    // Extract final text response
    const text = response.text();
    return text || 'I processed your request but have no additional response.';
}

/**
 * Streaming variant of callGemini.
 * Tool calls are handled non-streaming, but the final text response
 * is streamed chunk-by-chunk via the onChunk callback.
 *
 * @param {Array} messages - Conversation history [{role, parts}]
 * @param {object} user - User object {id, email, name}
 * @param {function} onChunk - Called with each text chunk as it arrives
 * @param {function} [onToolCall] - Called when a tool is being executed (name)
 * @returns {string} Complete final response text
 */
async function callGeminiStreaming(messages, user, onChunk, onToolCall) {
    if (!genAI) {
        throw new Error('Gemini is not configured. Please set GEMINI_API_KEY in .env');
    }

    const functionDeclarations = getGeminiFunctionDeclarations();

    const modelConfig = {
        model: 'gemini-2.5-flash',
        systemInstruction: getSystemPrompt(user),
    };

    if (functionDeclarations.length > 0) {
        modelConfig.tools = [{ functionDeclarations }];
    }

    const model = genAI.getGenerativeModel(modelConfig);
    const chat = model.startChat({
        history: messages.slice(0, -1),
    });

    const lastMessage = messages[messages.length - 1];
    const startTime = Date.now();

    // First call: non-streaming to check for tool calls
    let result = await chat.sendMessage(lastMessage.parts);
    let response = result.response;

    // Tool execution loop (non-streaming — we need full response to detect tools)
    const MAX_TOOL_LOOPS = 5;
    let loopCount = 0;

    while (loopCount < MAX_TOOL_LOOPS) {
        const candidate = response.candidates?.[0];
        if (!candidate) break;

        const parts = candidate.content?.parts || [];
        const functionCalls = parts.filter((p) => p.functionCall);

        if (functionCalls.length === 0) break;

        // Execute all tool calls in parallel
        const toolResponses = await Promise.all(
            functionCalls.map(async (fc) => {
                const { name, args } = fc.functionCall;
                console.log(`[Gemini Stream] Tool call: ${name}`, args);
                if (onToolCall) onToolCall(name);

                let toolResult;
                try {
                    toolResult = await executeTool(name, args, {
                        userId: user.id,
                        userEmail: user.email,
                    });
                } catch (err) {
                    console.error(`[Gemini Stream] Tool error (${name}):`, err.message);
                    toolResult = { error: err.message };
                }

                return {
                    functionResponse: {
                        name,
                        response: { result: toolResult },
                    },
                };
            })
        );

        // Check if this is likely the last tool loop — if so, stream the response
        result = await chat.sendMessage(toolResponses);
        response = result.response;
        loopCount++;

        // Check if next response has more tool calls
        const nextParts = response.candidates?.[0]?.content?.parts || [];
        const hasMoreTools = nextParts.some((p) => p.functionCall);

        if (!hasMoreTools && loopCount > 0) {
            // Final response after tools — already have the full text
            const text = response.text() || '';
            console.log(`[Gemini Stream] Done in ${Date.now() - startTime}ms (${loopCount} tool loops)`);
            // Send it all as one chunk (tools already gave us the complete response)
            if (text) onChunk(text);
            return text || 'I processed your request but have no additional response.';
        }
    }

    // No tool calls at all — re-do with streaming for the initial response
    // We already have the full response from the non-streaming call above
    const text = response.text() || '';

    if (text) {
        // Simulate streaming by splitting into words for smooth UX
        const words = text.split(' ');
        let accumulated = '';
        for (let i = 0; i < words.length; i++) {
            accumulated += (i > 0 ? ' ' : '') + words[i];
            onChunk(accumulated);
            // Small delay for visual streaming effect
            await new Promise((r) => setTimeout(r, 15));
        }
    }

    console.log(`[Gemini Stream] Done in ${Date.now() - startTime}ms (${loopCount} tool loops)`);
    return text || 'I processed your request but have no additional response.';
}

module.exports = { initGemini, callGemini, callGeminiStreaming };
