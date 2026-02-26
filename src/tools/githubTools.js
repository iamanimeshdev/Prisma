// ============================================================
// PRISMA — GitHub Query Tools
// ============================================================
const { z } = require('zod');
const { execSync } = require('child_process');
const { registerTool } = require('../core/toolRegistry');

// ── Helper: Run gh command ──────────────────────────────────
function run(cmd) {
    try {
        return execSync(`gh ${cmd}`, {
            encoding: 'utf8',
            shell: true,
            timeout: 30000,
            windowsHide: true,
        }).trim();
    } catch (err) {
        const stderr = err.stderr
            ? (typeof err.stderr === 'string' ? err.stderr : err.stderr.toString('utf8'))
            : '';
        throw new Error(`GitHub CLI Error: ${stderr || err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// TOOL: list_github_repos
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'list_github_repos',
    description: 'List public (or authenticated private) repositories for a specific GitHub user. Supports returning "all" repos or a specific count.',
    schema: z.object({
        username: z.string().describe('The GitHub username to list repositories for. Use your own username if the user asks for "my" repos.'),
        limit: z.any().optional().describe('Number of repos to fetch, or "all" for everything (default: 10)'),
    }),
    async execute(args, context) {
        let limitArg = 10;
        if (args.limit === 'all') {
            limitArg = 1000; // max supported by gh cli is usually 1000 easily
        } else if (args.limit !== undefined && !isNaN(Number(args.limit))) {
            limitArg = Number(args.limit);
        }

        try {
            // gh repo list <user> --json nameWithOwner,description,stargazerCount,updatedAt --limit N
            const raw = run(`repo list ${args.username} --json nameWithOwner,description,stargazerCount,updatedAt --limit ${limitArg}`);
            if (!raw) return { repos: [] };

            const repos = JSON.parse(raw);
            return {
                count: repos.length,
                repos: repos.map(r => ({
                    name: r.nameWithOwner,
                    description: r.description || 'No description',
                    stars: r.stargazerCount,
                    updated_at: r.updatedAt,
                }))
            };
        } catch (err) {
            return { error: err.message };
        }
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: summarize_github_repo
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'summarize_github_repo',
    description: 'Provide a quick overview/summary of a specific GitHub repository.',
    schema: z.object({
        repoFullName: z.string().describe('The full repository name, e.g., "owner/repo"'),
    }),
    async execute(args, context) {
        try {
            // fetch basic stats + full description
            const raw = run(`repo view ${args.repoFullName} --json description,stargazerCount,forkCount,primaryLanguage,updatedAt,url`);
            const repo = JSON.parse(raw);

            // Fetch the README content to give the AI context to summarize
            let readme = '';
            try {
                // Try to get README.md
                readme = run(`api repos/${args.repoFullName}/readme -H "Accept: application/vnd.github.raw"`);
            } catch (err) {
                readme = 'No README available.';
            }

            return {
                repo: {
                    name: args.repoFullName,
                    url: repo.url,
                    description: repo.description,
                    language: repo.primaryLanguage?.name || 'Unknown',
                    stars: repo.stargazerCount,
                    forks: repo.forkCount,
                    last_updated: repo.updatedAt,
                },
                readme_snippet: readme.substring(0, 3000), // Limit README to 3000 chars for context
                instruction: 'Based on the repository metadata and README snippet provided, write a concise summary explaining what this repository does, its tech stack, and its purpose.'
            };
        } catch (err) {
            return { error: err.message };
        }
    },
});

// ════════════════════════════════════════════════════════════
// TOOL: search_github
// ════════════════════════════════════════════════════════════
registerTool({
    name: 'search_github',
    description: 'Search across all public GitHub repositories for specific topics, code, or users.',
    schema: z.object({
        query: z.string().describe('The search query (e.g., "react framework", "user:iamanimeshdev")'),
        type: z.enum(['repositories', 'code']).optional().describe('Type of search: repositories (default) or code'),
        limit: z.number().optional().describe('Results to return (default: 5)'),
    }),
    async execute(args, context) {
        const type = args.type || 'repositories';
        const limit = args.limit || 5;

        try {
            if (type === 'repositories') {
                const raw = run(`search repos "${args.query}" --json fullName,description,stargazersCount,updatedAt --limit ${limit}`);
                const repos = JSON.parse(raw);
                return {
                    results: repos.map(r => ({
                        repo: r.fullName,
                        description: r.description,
                        stars: r.stargazersCount,
                        updated: r.updatedAt
                    }))
                };
            } else {
                // Not supported well by JSON natively in all GH CLI versions, falling back to text
                const raw = run(`search code "${args.query}" --limit ${limit}`);
                return { results: raw };
            }
        } catch (err) {
            return { error: err.message };
        }
    },
});

module.exports = {};
