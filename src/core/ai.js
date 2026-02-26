// ============================================================
// PRISMA — AI Gateway (OpenRouter / Meta Llama)
// ============================================================
const { getToolDeclarations, executeTool } = require('./toolRegistry');
const { getSystemPrompt } = require('./context');

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'arcee-ai/trinity-large-preview:free';


let apiKey = null;

function initAI() {
    if (!process.env.OPENROUTER_API_KEY) {
        console.warn('[AI] No OpenRouter API key configured — AI features disabled');
        return;
    }
    apiKey = process.env.OPENROUTER_API_KEY;
    console.log('[AI] OpenRouter initialized (model: ' + MODEL + ')');
}

/**
 * Make a chat completion request to OpenRouter.
 */
async function openRouterRequest(messages, tools, toolChoice) {
    const body = {
        model: MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 4096,
    };

    if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = toolChoice || 'auto';
    }

    const res = await fetch(OPENROUTER_BASE, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'PRISMA Assistant',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenRouter API error (${res.status}): ${errText}`);
    }

    return res.json();
}

/**
 * Call AI with conversation history and optional tools.
 * Handles multi-step tool execution loops.
 *
 * @param {Array} messages - Conversation history [{role, content}]
 * @param {object} user - User object {id, email, name}
 * @param {object} [options] - { enableTools: boolean }
 * @returns {string} Final assistant text response
 */
async function callAI(messages, user, options = {}) {
    if (!apiKey) {
        throw new Error('AI is not configured. Please set OPENROUTER_API_KEY in .env');
    }

    const { enableTools = true } = options;
    const tools = enableTools ? getToolDeclarations() : [];

    // Build messages array with system prompt
    const systemMessage = { role: 'system', content: getSystemPrompt(user) };
    let chatMessages = [systemMessage, ...messages];

    const startTime = Date.now();
    const MAX_TOOL_LOOPS = 5;
    let loopCount = 0;

    while (loopCount <= MAX_TOOL_LOOPS) {
        const data = await openRouterRequest(chatMessages, tools);
        const choice = data.choices?.[0];

        if (!choice) {
            throw new Error('No response from AI');
        }

        const assistantMessage = choice.message;

        // Check for tool calls
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
            // Ensure all tool calls have an arguments string (API requires it)
            assistantMessage.tool_calls.forEach(tc => {
                if (!tc.function.arguments) {
                    tc.function.arguments = '{}';
                }
            });

            // Add the assistant's message (with tool_calls) to conversation
            chatMessages.push(assistantMessage);

            // Execute all tool calls
            const toolResults = await Promise.all(
                assistantMessage.tool_calls.map(async (tc) => {
                    const { name, arguments: argsStr } = tc.function;
                    let args;
                    try {
                        args = JSON.parse(argsStr);
                    } catch {
                        args = {};
                    }
                    console.log(`[AI] Tool call: ${name}`, args);

                    let toolResult;
                    try {
                        toolResult = await executeTool(name, args, {
                            userId: user.id,
                            userEmail: user.email,
                        });
                    } catch (err) {
                        console.error(`[AI] Tool error (${name}):`, err.message);
                        toolResult = { error: err.message };
                    }

                    return {
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: JSON.stringify(toolResult),
                    };
                })
            );

            // Add all tool results to conversation
            chatMessages.push(...toolResults);
            loopCount++;
            continue;
        }

        // No tool calls — we have the final text response
        const text = assistantMessage.content || '';
        console.log(`[AI] Response in ${Date.now() - startTime}ms (${loopCount} tool loops)`);
        return text || 'I processed your request but have no additional response.';
    }

    return 'Maximum tool execution loops reached. Please try again.';
}

/**
 * Streaming variant of callAI.
 * Tool calls are handled non-streaming, but the final text response
 * is streamed chunk-by-chunk via the onChunk callback.
 *
 * @param {Array} messages - Conversation history [{role, content}]
 * @param {object} user - User object {id, email, name}
 * @param {function} onChunk - Called with each text chunk as it arrives
 * @param {function} [onToolCall] - Called when a tool is being executed (name)
 * @returns {string} Complete final response text
 */
async function callAIStreaming(messages, user, onChunk, onToolCall) {
    if (!apiKey) {
        throw new Error('AI is not configured. Please set OPENROUTER_API_KEY in .env');
    }

    const tools = getToolDeclarations();
    const systemMessage = { role: 'system', content: getSystemPrompt(user) };
    let chatMessages = [systemMessage, ...messages];
    const startTime = Date.now();

    // Tool execution loop (non-streaming)
    const MAX_TOOL_LOOPS = 5;
    let loopCount = 0;

    while (loopCount < MAX_TOOL_LOOPS) {
        const data = await openRouterRequest(chatMessages, tools);
        const choice = data.choices?.[0];
        if (!choice) break;

        const assistantMessage = choice.message;

        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
            // No tool calls — stream the final text response
            const text = assistantMessage.content || '';

            if (text) {
                // Simulate streaming by splitting into words
                const words = text.split(' ');
                let accumulated = '';
                for (let i = 0; i < words.length; i++) {
                    accumulated += (i > 0 ? ' ' : '') + words[i];
                    onChunk(accumulated);
                    await new Promise((r) => setTimeout(r, 15));
                }
            }

            console.log(`[AI Stream] Done in ${Date.now() - startTime}ms (${loopCount} tool loops)`);
            return text || 'I processed your request but have no additional response.';
        }

        // Handle tool calls
        assistantMessage.tool_calls.forEach(tc => {
            if (!tc.function.arguments) {
                tc.function.arguments = '{}';
            }
        });
        chatMessages.push(assistantMessage);

        const toolResults = await Promise.all(
            assistantMessage.tool_calls.map(async (tc) => {
                const { name, arguments: argsStr } = tc.function;
                let args;
                try {
                    args = JSON.parse(argsStr);
                } catch {
                    args = {};
                }
                console.log(`[AI Stream] Tool call: ${name}`, args);
                if (onToolCall) onToolCall(name);

                let toolResult;
                try {
                    toolResult = await executeTool(name, args, {
                        userId: user.id,
                        userEmail: user.email,
                    });
                } catch (err) {
                    console.error(`[AI Stream] Tool error (${name}):`, err.message);
                    toolResult = { error: err.message };
                }

                return {
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify(toolResult),
                };
            })
        );

        chatMessages.push(...toolResults);
        loopCount++;
    }

    console.log(`[AI Stream] Done in ${Date.now() - startTime}ms (${loopCount} tool loops)`);
    return 'Maximum tool execution loops reached.';
}

module.exports = { initAI, callAI, callAIStreaming };
