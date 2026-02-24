// ============================================================
// PRISMA — Tool Registry (Central Tool Management)
// ============================================================
const { z } = require('zod');

/** @type {Map<string, object>} */
const tools = new Map();

/**
 * Register a tool in the registry.
 * @param {{ name: string, description: string, schema: z.ZodObject, execute: Function }} tool
 */
function registerTool(tool) {
    if (!tool.name || !tool.description || !tool.schema || !tool.execute) {
        throw new Error(`Invalid tool definition: ${tool.name || 'unnamed'}`);
    }
    tools.set(tool.name, tool);
    console.log(`[ToolRegistry] Registered: ${tool.name}`);
}

/**
 * Get a tool by name.
 */
function getTool(name) {
    return tools.get(name) || null;
}

/**
 * Get all registered tools.
 */
function getAllTools() {
    return Array.from(tools.values());
}

/**
 * Convert a Zod schema to JSON Schema format (OpenAI-compatible).
 */
function zodToJsonSchema(schema) {
    const shape = schema.shape;
    const properties = {};
    const required = [];

    for (const [key, value] of Object.entries(shape)) {
        const prop = {};

        // Determine type
        if (value instanceof z.ZodString) {
            prop.type = 'string';
            if (value.description) prop.description = value.description;
        } else if (value instanceof z.ZodNumber) {
            prop.type = 'number';
            if (value.description) prop.description = value.description;
        } else if (value instanceof z.ZodBoolean) {
            prop.type = 'boolean';
            if (value.description) prop.description = value.description;
        } else if (value instanceof z.ZodArray) {
            prop.type = 'array';
            prop.items = { type: 'string' };
            if (value.description) prop.description = value.description;
        } else if (value instanceof z.ZodOptional) {
            // Unwrap optional
            const inner = value._def.innerType;
            if (inner instanceof z.ZodString) prop.type = 'string';
            else if (inner instanceof z.ZodNumber) prop.type = 'number';
            else if (inner instanceof z.ZodBoolean) prop.type = 'boolean';
            else prop.type = 'string';
            if (value.description) prop.description = value.description;
        } else {
            prop.type = 'string';
        }

        properties[key] = prop;

        // Check if required (not optional)
        if (!(value instanceof z.ZodOptional)) {
            required.push(key);
        }
    }

    return { type: 'object', properties, required };
}

/**
 * Get OpenAI-compatible tool declarations for all registered tools.
 */
function getToolDeclarations() {
    return getAllTools().map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: zodToJsonSchema(tool.schema),
        },
    }));
}

/**
 * Execute a tool by name with validated arguments.
 */
async function executeTool(name, args, context) {
    const tool = getTool(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);

    // Validate arguments with Zod
    const validated = tool.schema.parse(args);
    console.log(`[ToolRegistry] Executing: ${name}`, validated);

    const result = await tool.execute(validated, context);
    return result;
}

module.exports = {
    registerTool,
    getTool,
    getAllTools,
    getToolDeclarations,
    executeTool,
};
