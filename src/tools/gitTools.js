// ============================================================
// PRISMA — Git Tools (Smart GitHub Integration)
// ============================================================
const { z } = require('zod');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { registerTool } = require('../core/toolRegistry');

// ── Pulse Engine reference (lazy-loaded to avoid circular deps) ──
let pulse = null;
function getPulse() {
    if (!pulse) pulse = require('../services/pulse');
    return pulse;
}

// ── Shell command helper (Windows-compatible) ──────────────
function run(cmd, cwd, timeoutMs = 120000) {
    try {
        const result = execSync(cmd, {
            cwd,
            encoding: 'utf8',
            shell: true,
            timeout: timeoutMs,
            windowsHide: true,
        });
        return (result || '').trim();
    } catch (err) {
        const stderr = err.stderr
            ? (typeof err.stderr === 'string' ? err.stderr : err.stderr.toString('utf8'))
            : '';
        const stdout = err.stdout
            ? (typeof err.stdout === 'string' ? err.stdout : err.stdout.toString('utf8'))
            : '';
        const error = new Error(stderr || stdout || err.message);
        error.stderr = stderr;
        error.stdout = stdout;
        error.status = err.status;
        throw error;
    }
}

function commandExists(cmd) {
    try {
        execSync(`${cmd} --version`, {
            encoding: 'utf8', shell: true, timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        return true;
    } catch { return false; }
}

// ═══════════════════════════════════════════════════════════
// TECH STACK DETECTION
// ═══════════════════════════════════════════════════════════
const STACK_MARKERS = [
    { files: ['package.json'], name: 'Node.js', icon: '🟢', lang: 'JavaScript/TypeScript' },
    { files: ['requirements.txt', 'Pipfile', 'setup.py', 'pyproject.toml'], name: 'Python', icon: '🐍', lang: 'Python' },
    { files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], name: 'Java', icon: '☕', lang: 'Java' },
    { files: ['go.mod'], name: 'Go', icon: '🔷', lang: 'Go' },
    { files: ['Cargo.toml'], name: 'Rust', icon: '🦀', lang: 'Rust' },
    { files: ['Gemfile'], name: 'Ruby', icon: '💎', lang: 'Ruby' },
    { files: ['composer.json'], name: 'PHP', icon: '🐘', lang: 'PHP' },
    { files: ['*.csproj', '*.sln'], name: '.NET', icon: '🟣', lang: 'C#' },
    { files: ['pubspec.yaml'], name: 'Flutter/Dart', icon: '🎯', lang: 'Dart' },
    { files: ['Dockerfile', 'docker-compose.yml'], name: 'Docker', icon: '🐳', lang: '' },
    { files: ['index.html'], name: 'Web', icon: '🌐', lang: 'HTML/CSS/JS' },
];

function detectTechStack(folderPath) {
    const detected = [];
    for (const stack of STACK_MARKERS) {
        for (const marker of stack.files) {
            if (marker.includes('*')) {
                // Glob-like check
                const ext = marker.replace('*', '');
                const files = fs.readdirSync(folderPath);
                if (files.some(f => f.endsWith(ext))) {
                    detected.push(stack);
                    break;
                }
            } else if (fs.existsSync(path.join(folderPath, marker))) {
                detected.push(stack);
                break;
            }
        }
    }
    return detected.length > 0 ? detected : [{ name: 'Generic', icon: '📁', lang: '' }];
}

// ═══════════════════════════════════════════════════════════
// .GITIGNORE TEMPLATES
// ═══════════════════════════════════════════════════════════
const GITIGNORE_TEMPLATES = {
    'Node.js': `# Dependencies
node_modules/
.pnp/
.pnp.js

# Build
dist/
build/
.next/
out/

# Environment
.env
.env.local
.env.*.local

# Debug / Logs
npm-debug.log*
yarn-debug.log*
*.log

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo
`,
    'Python': `# Virtual environments
venv/
.venv/
env/
__pycache__/
*.py[cod]
*.egg-info/
dist/
build/

# Environment
.env

# IDE
.vscode/
.idea/
*.swp

# OS
.DS_Store
Thumbs.db
`,
    'Java': `# Build
target/
build/
*.class
*.jar
*.war

# IDE
.idea/
*.iml
.classpath
.project
.settings/

# Environment
.env

# OS
.DS_Store
Thumbs.db
`,
    'Go': `# Binaries
*.exe
*.exe~
*.dll
*.so
*.dylib
/bin/
/vendor/

# Environment
.env

# IDE
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
`,
    'Rust': `/target/
Cargo.lock
*.pdb

.env
.DS_Store
Thumbs.db
`,
    'Generic': `.env
node_modules/
dist/
build/
*.log
.DS_Store
Thumbs.db
.vscode/
.idea/
`,
};

function generateGitignore(stacks) {
    const seen = new Set();
    let content = '';
    for (const stack of stacks) {
        const tmpl = GITIGNORE_TEMPLATES[stack.name] || GITIGNORE_TEMPLATES['Generic'];
        for (const line of tmpl.split('\n')) {
            if (!seen.has(line)) {
                seen.add(line);
                content += line + '\n';
            }
        }
    }
    return content;
}

// ═══════════════════════════════════════════════════════════
// README GENERATOR
// ═══════════════════════════════════════════════════════════
function generateDirectoryTree(dirPath, prefix = '', depth = 0, maxDepth = 2) {
    if (depth >= maxDepth) return '';
    let tree = '';
    const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', 'venv', '.venv', 'target', '.idea', '.vscode']);

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
            .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
            .sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            })
            .slice(0, 20);

        entries.forEach((entry, i) => {
            const isLast = i === entries.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const icon = entry.isDirectory() ? '📂' : '📄';
            tree += `${prefix}${connector}${icon} ${entry.name}\n`;
            if (entry.isDirectory()) {
                const childPrefix = prefix + (isLast ? '    ' : '│   ');
                tree += generateDirectoryTree(path.join(dirPath, entry.name), childPrefix, depth + 1, maxDepth);
            }
        });
    } catch { /* skip unreadable dirs */ }
    return tree;
}

function generateReadme(folderPath, stacks, repoName) {
    const projectName = repoName || path.basename(folderPath);
    const stackNames = stacks.map(s => `${s.icon} ${s.name}`).join(' • ');
    const tree = generateDirectoryTree(folderPath);

    // Detect setup instructions per stack
    const setupSteps = [];
    for (const stack of stacks) {
        switch (stack.name) {
            case 'Node.js':
                setupSteps.push('```bash\nnpm install\nnpm start\n```');
                break;
            case 'Python':
                setupSteps.push('```bash\npip install -r requirements.txt\npython main.py\n```');
                break;
            case 'Java':
                setupSteps.push('```bash\nmvn clean install\njava -jar target/*.jar\n```');
                break;
            case 'Go':
                setupSteps.push('```bash\ngo build\n./$(basename $(pwd))\n```');
                break;
            case 'Rust':
                setupSteps.push('```bash\ncargo build --release\ncargo run\n```');
                break;
            default:
                break;
        }
    }

    // Try to get description from package.json etc
    let description = '';
    const pkgPath = path.join(folderPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            description = pkg.description || '';
        } catch { /* ignore */ }
    }

    return `# ${projectName}

${description ? `> ${description}\n` : ''}
## Tech Stack

${stackNames}

## Project Structure

\`\`\`
${tree || 'No files to display.'}\`\`\`

## Getting Started

### Prerequisites

${stacks.map(s => `- ${s.icon} ${s.name}${s.lang ? ` (${s.lang})` : ''}`).join('\n')}

### Installation

${setupSteps.length > 0 ? setupSteps.join('\n\n') : '```bash\n# Clone and run\ngit clone <repo-url>\ncd ${projectName}\n```'}

## License

This project is open source.

---

*Auto-generated by [PRISMA](https://github.com) — AI-powered assistant.*
`;
}

// ═══════════════════════════════════════════════════════════
// TOOL: push_to_github
// ═══════════════════════════════════════════════════════════
registerTool({
    name: 'push_to_github',
    description: `Push a local project folder to the user's GitHub account with smart features.

IMPORTANT WORKFLOW — follow these steps every time:
1. First, use recall_memory to search for "github username". 
   - If NOT found, ask the user for their GitHub username (e.g. "iamanimeshdev") and then call store_memory with key "github username" to save it. Then call this tool again.
   - If found, pass the username to this tool.
2. Call this tool with the folderPath, the github username, and optionally a repoName.

This tool will automatically:
- Detect the project's tech stack
- Generate a professional README.md
- Generate a stack-specific .gitignore
- Initialise git, commit, create the repo, and push
- Trigger a post-push security scan

Prerequisites: git and gh (GitHub CLI) installed and authenticated.`,
    schema: z.object({
        folderPath: z.string().describe('Absolute path to the project folder to push'),
        githubUsername: z.string().describe('The GitHub username of the user'),
        repoName: z.string().optional().describe('Repository name on GitHub. Defaults to the folder name.'),
        isPrivate: z.boolean().optional().describe('Whether the repo should be private (default: false)'),
        commitMessage: z.string().optional().describe('Custom commit message (default: "Initial commit by PRISMA")'),
    }),
    async execute(args, context) {
        const folderPath = path.resolve(args.folderPath);
        const steps = [];

        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
            return { success: false, error: `Path "${folderPath}" does not exist or is not a directory.` };
        }

        const repoName = args.repoName || path.basename(folderPath);
        const visibility = args.isPrivate ? '--private' : '--public';
        const commitMsg = args.commitMessage || 'Initial commit by PRISMA';
        const username = args.githubUsername;

        try {
            // ── 1. Prerequisites ────────────────────────────
            if (!commandExists('git')) {
                return { success: false, error: 'Git is not installed. Please install Git first.' };
            }
            if (!commandExists('gh')) {
                return { success: false, error: 'GitHub CLI (gh) not installed. Install from https://cli.github.com' };
            }

            try {
                execSync('gh auth status', { encoding: 'utf8', shell: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            } catch (authErr) {
                const stderr = authErr.stderr ? (typeof authErr.stderr === 'string' ? authErr.stderr : authErr.stderr.toString('utf8')) : '';
                if (stderr.includes('not logged') || stderr.includes('no accounts')) {
                    return { success: false, error: 'GitHub CLI not authenticated. Run "gh auth login" first.' };
                }
            }
            steps.push('Prerequisites verified');

            // ── 2. Detect tech stack ────────────────────────
            const stacks = detectTechStack(folderPath);
            steps.push(`Detected stack: ${stacks.map(s => s.name).join(', ')}`);

            // ── 3. Generate .gitignore ──────────────────────
            const gitignorePath = path.join(folderPath, '.gitignore');
            if (!fs.existsSync(gitignorePath)) {
                fs.writeFileSync(gitignorePath, generateGitignore(stacks), 'utf8');
                steps.push('Generated stack-specific .gitignore');
            } else {
                steps.push('.gitignore already exists — kept as-is');
            }

            // ── 4. Generate README.md ───────────────────────
            const readmePath = path.join(folderPath, 'README.md');
            if (!fs.existsSync(readmePath)) {
                fs.writeFileSync(readmePath, generateReadme(folderPath, stacks, repoName), 'utf8');
                steps.push('Generated professional README.md');
            } else {
                steps.push('README.md already exists — kept as-is');
            }

            // ── 5. Init git ─────────────────────────────────
            const isGitRepo = fs.existsSync(path.join(folderPath, '.git'));
            if (!isGitRepo) {
                run('git init', folderPath);
                steps.push('Initialised new Git repository');
            }

            // ── 6. Git config ───────────────────────────────
            try { run('git config user.email', folderPath); } catch {
                run('git config user.email "prisma@local"', folderPath);
                run('git config user.name "PRISMA"', folderPath);
            }

            // ── 7. Stage & commit ───────────────────────────
            run('git add -A', folderPath);
            try {
                run(`git commit -m "${commitMsg}"`, folderPath);
                steps.push(`Committed: "${commitMsg}"`);
            } catch (e) {
                const msg = e.stderr || e.message || '';
                if (msg.includes('nothing to commit') || msg.includes('working tree clean')) {
                    steps.push('Nothing new to commit');
                } else {
                    return { success: false, error: `Commit failed: ${msg}`, steps };
                }
            }

            // ── 8. Create repo & push ────────────────────
            const repoFullName = `${username}/${repoName}`;
            const targetUrl = `https://github.com/${repoFullName}.git`;

            // Always ensure the GitHub repo exists first
            let repoCreated = false;
            try {
                run(`gh repo create ${repoFullName} ${visibility} --confirm`, folderPath, 60000);
                steps.push(`Created repo: ${repoFullName} (${args.isPrivate ? 'private' : 'public'})`);
                repoCreated = true;
            } catch (ghErr) {
                const errMsg = ghErr.stderr || ghErr.message || '';
                if (errMsg.includes('already exists') || errMsg.includes('Name already exists')) {
                    steps.push(`Repo ${repoFullName} already exists on GitHub`);
                } else if (errMsg.includes('is not available') || errMsg.includes('could not be created')) {
                    return { success: false, error: `Failed to create repo "${repoName}": ${errMsg}`, steps };
                } else {
                    // Might be a different error — log but continue
                    console.warn(`[GitTools] gh repo create warning: ${errMsg}`);
                    steps.push('Repo may already exist — continuing');
                }
            }

            // Ensure origin remote is correct
            let hasOrigin = false;
            let originUrl = '';
            try {
                const remotes = run('git remote -v', folderPath);
                hasOrigin = remotes.includes('origin');
                if (hasOrigin) {
                    const match = remotes.match(/origin\s+(\S+)\s+\(push\)/);
                    originUrl = match ? match[1] : '';
                }
            } catch { hasOrigin = false; }

            if (hasOrigin && originUrl !== targetUrl && originUrl !== `https://github.com/${repoFullName}`) {
                // Origin points to wrong repo — fix it
                try {
                    run('git remote remove origin', folderPath);
                    steps.push('Removed stale origin remote');
                } catch { /* ignore */ }
                hasOrigin = false;
            }

            if (!hasOrigin) {
                run(`git remote add origin ${targetUrl}`, folderPath);
                steps.push('Set remote origin');
            }

            // Push
            try {
                run('git push -u origin HEAD', folderPath, 180000);
                steps.push('Pushed successfully');
            } catch (pushErr) {
                const pushMsg = pushErr.stderr || pushErr.message || '';
                if (pushMsg.includes('Repository not found')) {
                    return { success: false, error: `Repository "${repoFullName}" not found on GitHub. Check that your username "${username}" is correct and that you have permission to push.`, steps };
                }
                // Try force-setting upstream if branch tracking is off
                if (pushMsg.includes('no upstream') || pushMsg.includes('does not match')) {
                    run('git push -u origin HEAD --force', folderPath, 180000);
                    steps.push('Pushed (force set upstream)');
                } else {
                    return { success: false, error: `Push failed: ${pushMsg}`, steps };
                }
            }

            const repoUrl = `https://github.com/${repoFullName}`;
            steps.push('Push complete!');

            // ── 9. Emit repo:pushed event for guardian ──────
            try {
                getPulse().emit('repo:pushed', {
                    userId: context.userId,
                    repoFullName,
                    folderPath,
                    repoUrl,
                });
            } catch (pulseErr) { console.error('[GitTools] repo:pushed emit failed:', pulseErr.message); }

            return {
                success: true,
                repoUrl,
                repoName: repoFullName,
                techStack: stacks.map(s => s.name),
                steps,
                message: `Successfully pushed "${path.basename(folderPath)}" to ${repoUrl}`,
            };
        } catch (err) {
            console.error('[GitTools] Error:', err);
            return { success: false, error: err.message || String(err), steps };
        }
    },
});
