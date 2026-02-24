// ============================================================
// PRISMA -- Issue Solver (AI-Powered PRs from Issues)
// ============================================================
// When a new issue is opened, PRISMA reads the repo codebase,
// sends it to the LLM along with the issue, gets code changes
// back, commits them to a fix branch, and opens a PR.
// ============================================================
const { z } = require('zod');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { registerTool } = require('../core/toolRegistry');

// -- Shell helper ---------------------------------------------
function run(cmd, cwd, timeoutMs = 60000) {
    try {
        return (execSync(cmd, {
            cwd: cwd || undefined,
            encoding: 'utf8',
            shell: true,
            timeout: timeoutMs,
            windowsHide: true,
        }) || '').trim();
    } catch (err) {
        const stderr = err.stderr
            ? (typeof err.stderr === 'string' ? err.stderr : err.stderr.toString('utf8'))
            : '';
        const error = new Error(stderr || err.message);
        error.stderr = stderr;
        throw error;
    }
}

// -- Temp file helper -----------------------------------------
function withTempFile(data, fn) {
    const tmpFile = path.join(os.tmpdir(), `prisma-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf8');
    try {
        return fn(tmpFile);
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { }
    }
}

// =============================================================
// Step 1: Get repo context (file tree + key source files)
// =============================================================
function getRepoContext(repoFullName, defaultBranch) {
    // Get the file tree
    let tree = [];
    try {
        const treeSha = run(
            `gh api repos/${repoFullName}/git/trees/${defaultBranch}?recursive=1 --jq ".tree | map(select(.type==\\"blob\\")) | map({path: .path, size: .size})"`,
        );
        tree = JSON.parse(treeSha || '[]');
    } catch (err) {
        console.error('[IssueSolver] Failed to get file tree:', err.message);
        return { tree: [], files: [] };
    }

    // Filter to relevant source files (skip binaries, huge files, etc.)
    const codeExtensions = [
        '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rb', '.rs',
        '.c', '.cpp', '.h', '.cs', '.php', '.swift', '.kt', '.dart',
        '.html', '.css', '.scss', '.vue', '.svelte',
        '.json', '.yaml', '.yml', '.toml', '.md',
    ];

    const skipPaths = ['node_modules/', 'dist/', 'build/', '.git/', 'vendor/', '__pycache__/', '.next/'];
    const MAX_FILE_SIZE = 50000; // 50KB max per file
    const MAX_FILES_TO_READ = 15;

    const relevantFiles = tree
        .filter(f => {
            const ext = path.extname(f.path).toLowerCase();
            if (!codeExtensions.includes(ext)) return false;
            if (f.size > MAX_FILE_SIZE) return false;
            if (skipPaths.some(skip => f.path.includes(skip))) return false;
            return true;
        })
        .sort((a, b) => {
            // Prioritize: README > config files > source files
            const priority = (p) => {
                if (p.toLowerCase().includes('readme')) return 0;
                if (p === 'package.json' || p === 'pyproject.toml' || p === 'cargo.toml') return 1;
                if (p.includes('/') === false) return 2; // root files
                return 3;
            };
            return priority(a.path) - priority(b.path);
        })
        .slice(0, MAX_FILES_TO_READ);

    // Read file contents
    const files = [];
    for (const file of relevantFiles) {
        try {
            const content = run(
                `gh api repos/${repoFullName}/contents/${file.path} --jq .content`,
            );
            if (content) {
                const decoded = Buffer.from(content, 'base64').toString('utf8');
                files.push({ path: file.path, content: decoded });
            }
        } catch {
            // Skip files we can't read
        }
    }

    return {
        tree: tree.map(f => f.path),
        files,
    };
}

// =============================================================
// Step 2: Call LLM to generate a solution
// =============================================================
async function callLLMForSolution(issue, repoContext, repoFullName) {
    // Check if API key is available
    if (!process.env.OPENROUTER_API_KEY) {
        console.warn('[IssueSolver] No OpenRouter API key -- falling back to template PR');
        return null;
    }

    const fileList = repoContext.tree.join('\n');
    const fileContents = repoContext.files
        .map(f => `--- ${f.path} ---\n${f.content}`)
        .join('\n\n');

    const prompt = `You are an expert software engineer. A new issue has been opened on the GitHub repository "${repoFullName}".

## Issue #${issue.number}: ${issue.title}

${issue.body || '(no description)'}

## Repository File Tree
\`\`\`
${fileList}
\`\`\`

## Source Files
${fileContents}

## Your Task
Analyze this issue and generate the code changes needed to solve it. You must respond with ONLY a valid JSON array of file changes. Each entry should have:
- "path": the file path (relative to repo root)
- "content": the complete new content of the file
- "action": either "create" or "update"

If no code changes make sense (e.g., the issue is a question or discussion), respond with an empty array: []

Example response:
[
  {"path": "src/utils.js", "content": "// file content here...", "action": "update"},
  {"path": "src/newFile.js", "content": "// new file content...", "action": "create"}
]

IMPORTANT:
- Only output the JSON array, nothing else
- Include the COMPLETE file content, not just the changes
- Make minimal, focused changes to solve the issue
- Follow the existing code style and conventions`;

    try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'PRISMA Issue Solver',
            },
            body: JSON.stringify({
                model: 'arcee-ai/trinity-large-preview:free',
                messages: [
                    { role: 'system', content: 'You are an expert code generator. Respond only with valid JSON arrays of file changes. No markdown, no explanation, just the JSON array.' },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.3,
                max_tokens: 8192,
            }),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error(`[IssueSolver] LLM API error (${res.status}):`, errText.substring(0, 200));
            return null;
        }

        const data = await res.json();
        const responseText = data.choices?.[0]?.message?.content?.trim();

        if (!responseText) {
            console.warn('[IssueSolver] LLM returned empty response');
            return null;
        }

        // Parse JSON from response (handle markdown code blocks)
        let cleanJson = responseText;
        if (cleanJson.startsWith('```')) {
            cleanJson = cleanJson.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        }

        const changes = JSON.parse(cleanJson);

        if (!Array.isArray(changes)) {
            console.warn('[IssueSolver] LLM response is not an array');
            return null;
        }

        console.log(`[IssueSolver] LLM generated ${changes.length} file change(s) for issue #${issue.number}`);
        return changes;
    } catch (err) {
        console.error('[IssueSolver] LLM call failed:', err.message);
        return null;
    }
}

// =============================================================
// Step 3: Commit ALL changes to the fix branch in a SINGLE commit
// Uses the Git Trees API to batch everything at once.
// =============================================================
function commitSolution(repoFullName, branchName, changes, issue) {
    const validChanges = changes.filter(c => c.path && c.content);
    if (validChanges.length === 0) return 0;

    try {
        // Get the current HEAD of the branch
        const branchSha = run(
            `gh api repos/${repoFullName}/git/ref/heads/${branchName} --jq .object.sha`,
        ).trim();

        // Get the base tree SHA
        const baseTreeSha = run(
            `gh api repos/${repoFullName}/git/commits/${branchSha} --jq .tree.sha`,
        ).trim();

        // Create blobs for each file and build tree entries
        const treeEntries = [];
        for (const change of validChanges) {
            try {
                // Create a blob for this file's content
                const blobResult = withTempFile(
                    { content: Buffer.from(change.content).toString('base64'), encoding: 'base64' },
                    (tmpFile) => run(
                        `gh api repos/${repoFullName}/git/blobs -X POST --input "${tmpFile}" --jq .sha`,
                        undefined, 30000,
                    ),
                );

                treeEntries.push({
                    path: change.path,
                    mode: '100644', // regular file
                    type: 'blob',
                    sha: blobResult.trim(),
                });
            } catch (err) {
                console.error(`[IssueSolver] Failed to create blob for ${change.path}:`, err.message);
            }
        }

        if (treeEntries.length === 0) return 0;

        // Create a new tree with all changes at once
        const newTreeSha = withTempFile(
            { base_tree: baseTreeSha, tree: treeEntries },
            (tmpFile) => run(
                `gh api repos/${repoFullName}/git/trees -X POST --input "${tmpFile}" --jq .sha`,
                undefined, 30000,
            ),
        ).trim();

        // Create a single commit with all changes
        const fileList = validChanges.map(c => c.path).join(', ');
        const commitSha = withTempFile(
            {
                message: `fix(#${issue.number}): ${issue.title}\n\nFiles: ${fileList}\nAuto-generated by PRISMA`,
                tree: newTreeSha,
                parents: [branchSha],
            },
            (tmpFile) => run(
                `gh api repos/${repoFullName}/git/commits -X POST --input "${tmpFile}" --jq .sha`,
                undefined, 30000,
            ),
        ).trim();

        // Update the branch to point to the new commit
        withTempFile(
            { sha: commitSha, force: false },
            (tmpFile) => run(
                `gh api repos/${repoFullName}/git/refs/heads/${branchName} -X PATCH --input "${tmpFile}"`,
                undefined, 15000,
            ),
        );

        console.log(`[IssueSolver] Committed ${treeEntries.length} file(s) in one commit for issue #${issue.number}`);
        return treeEntries.length;
    } catch (err) {
        console.error(`[IssueSolver] Batch commit failed:`, err.message);

        // Fallback: try individual commits
        console.log('[IssueSolver] Falling back to individual commits...');
        let committed = 0;
        for (const change of validChanges) {
            try {
                const payload = {
                    message: `fix(#${issue.number}): update ${change.path}`,
                    content: Buffer.from(change.content).toString('base64'),
                    branch: branchName,
                };

                // Check if file exists (need SHA for update)
                try {
                    const sha = run(
                        `gh api "repos/${repoFullName}/contents/${change.path}?ref=${branchName}" --jq .sha`,
                    ).trim();
                    if (sha) payload.sha = sha;
                } catch { }

                withTempFile(payload, (tmpFile) => {
                    run(`gh api repos/${repoFullName}/contents/${change.path} -X PUT --input "${tmpFile}"`, undefined, 30000);
                });
                committed++;
            } catch (e) {
                console.error(`[IssueSolver] Failed: ${change.path}:`, e.message);
            }
        }
        return committed;
    }
}

// =============================================================
// Main: Solve an issue and create a PR
// =============================================================
async function solveIssueAndCreatePR(repoFullName, issue) {
    const branchName = `fix-issue-${issue.number}`;

    try {
        // Step 1: Get default branch + HEAD SHA
        let defaultBranch, headSha;
        try {
            defaultBranch = run(
                `gh api repos/${repoFullName} --jq .default_branch`,
            ).trim();
        } catch (err) {
            return { success: false, issueNumber: issue.number, error: `Repo not accessible: ${err.message}` };
        }

        try {
            headSha = run(
                `gh api repos/${repoFullName}/git/ref/heads/${defaultBranch} --jq .object.sha`,
            ).trim();
        } catch {
            return { success: false, issueNumber: issue.number, error: 'Repo has no commits -- skipping' };
        }

        if (!headSha || !defaultBranch) {
            return { success: false, issueNumber: issue.number, error: 'Empty repo -- skipping' };
        }

        // Step 2: Get repo context
        console.log(`[IssueSolver] Reading codebase for ${repoFullName}...`);
        const repoContext = getRepoContext(repoFullName, defaultBranch);

        // Step 3: Call LLM for solution
        console.log(`[IssueSolver] Asking LLM to solve issue #${issue.number}: "${issue.title}"...`);
        const changes = await callLLMForSolution(issue, repoContext, repoFullName);

        const hasCodeChanges = changes && changes.length > 0;

        // Step 4: Create the fix branch
        const branchPayload = { ref: `refs/heads/${branchName}`, sha: headSha };
        try {
            withTempFile(branchPayload, (tmpFile) => {
                run(`gh api repos/${repoFullName}/git/refs -X POST --input "${tmpFile}"`, undefined, 15000);
            });
        } catch (branchErr) {
            if (!branchErr.message?.includes('422')) {
                return { success: false, issueNumber: issue.number, error: `Branch creation failed: ${branchErr.message}` };
            }
            // 422 = branch already exists, fine
        }

        // Step 5: Commit the solution (if LLM provided changes)
        let committedCount = 0;
        if (hasCodeChanges) {
            committedCount = commitSolution(repoFullName, branchName, changes, issue);
        }

        // Step 6: Create the PR
        const prTitle = hasCodeChanges
            ? `[PRISMA] Fix #${issue.number}: ${issue.title}`
            : `[PRISMA][Draft] Fix #${issue.number}: ${issue.title}`;

        let prBody;
        if (hasCodeChanges) {
            const changeList = changes.map(c => `- **${c.action}** \`${c.path}\``).join('\n');
            prBody = `## AI-Generated Fix\n\n`
                + `**Linked Issue:** Closes #${issue.number}\n\n`
                + `### Issue\n${issue.title}\n${(issue.body || '').substring(0, 500)}\n\n`
                + `### Changes Made\n${changeList}\n\n`
                + `### Files Modified: ${committedCount}\n\n`
                + `> This PR was auto-generated by PRISMA's AI Issue Solver. `
                + `The LLM analyzed the codebase and generated these changes to address the issue. `
                + `Please review the changes carefully before merging.\n\n`
                + `---\n*Auto-generated by PRISMA*`;
        } else {
            prBody = `## Draft PR\n\n`
                + `**Linked Issue:** Closes #${issue.number}\n\n`
                + `### Issue\n${issue.title}\n${(issue.body || '').substring(0, 500)}\n\n`
                + `> The AI could not auto-generate code changes for this issue. `
                + `This draft PR is linked to the issue for tracking. `
                + `Please implement the changes manually.\n\n`
                + `---\n*Auto-generated by PRISMA*`;
        }

        const prPayload = {
            title: prTitle,
            body: prBody,
            head: branchName,
            base: defaultBranch,
            draft: !hasCodeChanges, // Only draft if no code changes
        };

        let prUrl = '';
        try {
            const prResult = withTempFile(prPayload, (tmpFile) => {
                return run(`gh api repos/${repoFullName}/pulls -X POST --input "${tmpFile}"`, undefined, 30000);
            });
            // Try to extract PR URL from response
            try {
                const prData = JSON.parse(prResult);
                prUrl = prData.html_url || '';
            } catch { }
        } catch (prErr) {
            if (prErr.message?.includes('422')) {
                // PR already exists
                return { success: true, prTitle, issueNumber: issue.number, output: 'PR already exists', filesChanged: committedCount };
            }
            throw prErr;
        }

        return {
            success: true,
            prTitle,
            issueNumber: issue.number,
            filesChanged: committedCount,
            aiGenerated: hasCodeChanges,
            prUrl,
            output: hasCodeChanges
                ? `AI solved issue #${issue.number} with ${committedCount} file change(s)`
                : `Draft PR created (AI could not generate changes)`,
        };
    } catch (err) {
        return {
            success: false,
            issueNumber: issue.number,
            error: err.stderr || err.message,
        };
    }
}

// =============================================================
// Process ALL open issues (used by manual tool only)
// =============================================================
function fetchOpenIssues(repoFullName, limit = 20) {
    try {
        const raw = run(
            `gh issue list --repo ${repoFullName} --state open --limit ${limit} --json number,title,body,labels,createdAt`,
        );
        if (!raw) return [];
        return JSON.parse(raw);
    } catch (err) {
        console.error(`[IssueSolver] Failed to fetch issues for ${repoFullName}:`, err.message);
        return [];
    }
}

function fetchExistingPRs(repoFullName) {
    try {
        const raw = run(
            `gh pr list --repo ${repoFullName} --state all --limit 100 --json title,body`,
        );
        if (!raw) return [];
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

async function processNewIssues(repoFullName, processedIssueIds) {
    const issues = fetchOpenIssues(repoFullName);
    const existingPRs = fetchExistingPRs(repoFullName);
    const results = [];

    for (const issue of issues) {
        if (processedIssueIds.has(`${repoFullName}#${issue.number}`)) continue;

        const alreadyHasPR = existingPRs.some(pr =>
            (pr.body || '').includes(`#${issue.number}`) ||
            (pr.title || '').includes(`#${issue.number}`)
        );
        if (alreadyHasPR) {
            processedIssueIds.add(`${repoFullName}#${issue.number}`);
            continue;
        }

        const result = await solveIssueAndCreatePR(repoFullName, issue);
        processedIssueIds.add(`${repoFullName}#${issue.number}`);
        results.push(result);
    }

    return results;
}

// =============================================================
// TOOL: generate_pr_from_issue
// =============================================================
registerTool({
    name: 'generate_pr_from_issue',
    description: `Scan a GitHub repository for open issues and automatically solve them using AI. For each issue, PRISMA reads the codebase, generates a solution using the LLM, commits the changes to a fix branch, and creates a Pull Request.

Prerequisites: gh (GitHub CLI) installed and authenticated. OpenRouter API key for AI-powered solutions.`,
    schema: z.object({
        repoFullName: z.string().describe('Full repo name, e.g. "owner/MyProject"'),
    }),
    async execute(args, context) {
        const { repoFullName } = args;

        try {
            run('gh auth status');
        } catch (err) {
            const stderr = err.stderr || '';
            if (stderr.includes('not logged') || stderr.includes('no accounts')) {
                return { success: false, error: 'GitHub CLI not authenticated. Run "gh auth login".' };
            }
        }

        const issues = fetchOpenIssues(repoFullName);
        if (issues.length === 0) {
            return { success: true, message: `No open issues found in ${repoFullName}`, prsCreated: 0 };
        }

        const existingPRs = fetchExistingPRs(repoFullName);
        const results = [];
        let created = 0;
        let skipped = 0;

        for (const issue of issues) {
            const alreadyHasPR = existingPRs.some(pr =>
                (pr.body || '').includes(`#${issue.number}`) ||
                (pr.title || '').includes(`#${issue.number}`)
            );

            if (alreadyHasPR) {
                skipped++;
                continue;
            }

            const result = await solveIssueAndCreatePR(repoFullName, issue);
            results.push(result);
            if (result.success) created++;
        }

        return {
            success: true,
            repo: repoFullName,
            totalIssues: issues.length,
            prsCreated: created,
            skipped,
            details: results,
            message: `Created ${created} PR(s) for ${repoFullName}. Skipped ${skipped} (already have PRs).`,
        };
    },
});

// Export for Pulse Engine
module.exports = { fetchOpenIssues, processNewIssues, solveIssueAndCreatePR };
