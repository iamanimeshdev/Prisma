// ============================================================
// PRISMA — Repo Guardian (Proactive Security Scanner)
// ============================================================
// Scans repositories for security/hygiene risks automatically
// after every push and when triggered manually.
// ============================================================
const { z } = require('zod');
const path = require('path');
const fs = require('fs');
const { registerTool } = require('../core/toolRegistry');

// ── Secret Patterns (regex) ─────────────────────────────────
const SECRET_PATTERNS = [
    { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g },
    { name: 'AWS Secret Key', regex: /(?:aws_secret|secret_access_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi },
    { name: 'Generic API Key', regex: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]([A-Za-z0-9_\-]{20,})['"]?/gi },
    { name: 'Generic Secret', regex: /(?:secret|token|password|passwd|pwd)\s*[:=]\s*['"]([^'"]{8,})['"]?/gi },
    { name: 'Private Key Header', regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g },
    { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
    { name: 'Bearer Token', regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g },
];

// Files to scan for secrets
const SCANNABLE_EXTENSIONS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go',
    '.java', '.rs', '.php', '.json', '.yaml', '.yml',
    '.toml', '.xml', '.properties', '.cfg', '.ini', '.conf',
]);

// Known credential files
const CREDENTIAL_FILES = new Set([
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
    '.pem', '.p12', '.pfx', '.key',
    'credentials.json', 'service-account.json',
    'keystore.jks', '.keystore',
]);

// Large file threshold (5MB)
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024;

// ═══════════════════════════════════════════════════════════
// CORE SCANNER
// ═══════════════════════════════════════════════════════════

/**
 * Scan a project folder for security/hygiene risks.
 * Returns a structured report.
 */
function scanProject(folderPath) {
    const risks = [];
    const stats = { filesScanned: 0, totalFiles: 0, dirsScanned: 0 };

    const IGNORE_DIRS = new Set([
        'node_modules', '.git', '.next', 'dist', 'build',
        '__pycache__', 'venv', '.venv', 'target', '.idea',
        '.vscode', 'vendor', 'bower_components',
    ]);

    // ── Check 1: .env file leaked ───────────────────────
    const envPath = path.join(folderPath, '.env');
    if (fs.existsSync(envPath)) {
        const gitignorePath = path.join(folderPath, '.gitignore');
        let envIgnored = false;
        if (fs.existsSync(gitignorePath)) {
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            envIgnored = gitignoreContent.split('\n').some(line =>
                line.trim() === '.env' || line.trim() === '.env*' || line.trim() === '*.env'
            );
        }
        if (!envIgnored) {
            risks.push({
                severity: 'critical',
                type: 'env_leaked',
                message: '.env file exists but is NOT in .gitignore — secrets may be exposed!',
                file: '.env',
                fix: 'Add ".env" to your .gitignore file',
            });
        }
    }

    // ── Check 2: Missing .gitignore ─────────────────────
    if (!fs.existsSync(path.join(folderPath, '.gitignore'))) {
        risks.push({
            severity: 'warning',
            type: 'missing_gitignore',
            message: 'No .gitignore file found — sensitive files may be committed',
            fix: 'Create a .gitignore file for your project',
        });
    }

    // ── Check 3: node_modules tracked ───────────────────
    const nmPath = path.join(folderPath, 'node_modules');
    if (fs.existsSync(nmPath)) {
        // Check if it's in .gitignore
        const gitignorePath = path.join(folderPath, '.gitignore');
        let nmIgnored = false;
        if (fs.existsSync(gitignorePath)) {
            const content = fs.readFileSync(gitignorePath, 'utf8');
            nmIgnored = content.split('\n').some(line =>
                line.trim() === 'node_modules/' || line.trim() === 'node_modules'
            );
        }
        if (!nmIgnored) {
            risks.push({
                severity: 'warning',
                type: 'node_modules_tracked',
                message: 'node_modules/ exists and may not be properly ignored',
                fix: 'Add "node_modules/" to .gitignore',
            });
        }
    }

    // ── Recursive file scan ─────────────────────────────
    function walkDir(dir, depth = 0) {
        if (depth > 6) return; // Don't go too deep
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(folderPath, fullPath);

            if (entry.isDirectory()) {
                if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
                stats.dirsScanned++;
                walkDir(fullPath, depth + 1);
                continue;
            }

            stats.totalFiles++;

            // Check 4: Credential files
            const baseName = entry.name.toLowerCase();
            const ext = path.extname(entry.name).toLowerCase();
            if (CREDENTIAL_FILES.has(baseName) || CREDENTIAL_FILES.has(ext)) {
                risks.push({
                    severity: 'critical',
                    type: 'credential_file',
                    message: `Credential file found: ${relativePath}`,
                    file: relativePath,
                    fix: `Add "${entry.name}" to .gitignore and remove from tracking`,
                });
            }

            // Check 5: Large binary files
            try {
                const stat = fs.statSync(fullPath);
                if (stat.size > LARGE_FILE_THRESHOLD) {
                    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
                    risks.push({
                        severity: 'warning',
                        type: 'large_file',
                        message: `Large file (${sizeMB}MB): ${relativePath}`,
                        file: relativePath,
                        fix: 'Consider using Git LFS or adding to .gitignore',
                    });
                }
            } catch { /* skip */ }

            // Check 6: Hardcoded secrets in source files
            if (SCANNABLE_EXTENSIONS.has(ext)) {
                stats.filesScanned++;
                try {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    // Skip files larger than 500KB for performance
                    if (content.length > 500000) continue;

                    for (const pattern of SECRET_PATTERNS) {
                        const matches = content.match(pattern.regex);
                        if (matches && matches.length > 0) {
                            // Filter false positives (placeholder values, examples)
                            const real = matches.filter(m =>
                                !m.includes('example') &&
                                !m.includes('placeholder') &&
                                !m.includes('your_') &&
                                !m.includes('xxx') &&
                                !m.includes('TODO')
                            );
                            if (real.length > 0) {
                                risks.push({
                                    severity: 'critical',
                                    type: 'hardcoded_secret',
                                    message: `Possible ${pattern.name} found in ${relativePath}`,
                                    file: relativePath,
                                    fix: 'Move secrets to .env file and add .env to .gitignore',
                                });
                                break; // One finding per file is enough
                            }
                        }
                    }
                } catch { /* skip unreadable files */ }
            }
        }
    }

    walkDir(folderPath);

    // Build summary
    const criticalCount = risks.filter(r => r.severity === 'critical').length;
    const warningCount = risks.filter(r => r.severity === 'warning').length;

    let status;
    if (criticalCount > 0) status = 'critical';
    else if (warningCount > 0) status = 'warning';
    else status = 'clean';

    return {
        status,
        risks,
        stats,
        summary: status === 'clean'
            ? `✅ Clean — ${stats.filesScanned} files scanned, 0 risks found`
            : `${criticalCount > 0 ? '🔴' : '🟡'} Found ${criticalCount} critical, ${warningCount} warning issues across ${stats.filesScanned} files`,
    };
}

// ═══════════════════════════════════════════════════════════
// TOOL: scan_repo
// ═══════════════════════════════════════════════════════════
registerTool({
    name: 'scan_repo',
    description: `Scan a local project folder for security and hygiene risks. Checks for: leaked .env files, hardcoded secrets/API keys, credential files, large binaries, missing .gitignore, and node_modules being tracked. Returns a full security report.`,
    schema: z.object({
        folderPath: z.string().describe('Absolute path to the project folder to scan'),
    }),
    async execute(args, context) {
        const folderPath = path.resolve(args.folderPath);
        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
            return { success: false, error: `Path "${folderPath}" does not exist or is not a directory.` };
        }

        const report = scanProject(folderPath);
        return {
            success: true,
            ...report,
            folderPath,
            projectName: path.basename(folderPath),
        };
    },
});

// Export scanner for use by Pulse Engine
module.exports = { scanProject };
