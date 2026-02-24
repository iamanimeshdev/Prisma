// ============================================================
// PRISMA — Electron Main Process
// ============================================================
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const voiceEngine = require('../src/voice/engine');

// Prevent sox/voice errors from crashing the entire app
let voiceAvailable = false;
process.on('uncaughtException', (err) => {
    if (err.message && err.message.includes('sox')) {
        console.warn('[Electron] Sox error caught (voice disabled):', err.message);
        voiceAvailable = false;
    } else {
        console.error('[Electron] Uncaught exception:', err);
    }
});

let mainWindow = null;
let server = null;
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

// ── Authenticated user state (persisted to disk) ───────────
let currentUser = null; // { id, email, name, picture }

function getUserFilePath() {
    return path.join(app.getPath('userData'), 'current-user.json');
}

function saveUser(user) {
    try {
        fs.writeFileSync(getUserFilePath(), JSON.stringify(user, null, 2));
    } catch (e) { /* ignore */ }
}

function loadSavedUser() {
    try {
        const data = fs.readFileSync(getUserFilePath(), 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        return null;
    }
}

function clearSavedUser() {
    try {
        fs.unlinkSync(getUserFilePath());
    } catch (e) { /* ignore */ }
}

// ── Create Main Window ─────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        minWidth: 800,
        minHeight: 600,
        frame: false,
        titleBarStyle: 'hidden',
        backgroundColor: '#0a0a0f',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        icon: path.join(__dirname, 'icon.png'),
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // Open DevTools for debugging (remove in production)
    // mainWindow.webContents.openDevTools({ mode: 'detach' });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ── Helper: make authenticated fetch to backend ────────────
async function apiFetch(urlPath, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (currentUser) {
        headers['x-user-id'] = currentUser.id;
    }
    const res = await fetch(`${BASE_URL}${urlPath}`, {
        ...options,
        headers,
    });
    return res;
}

// ── IPC Handlers ───────────────────────────────────────────

// Window controls
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
});
ipcMain.handle('window:close', () => mainWindow?.close());

// Folder picker dialog
ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Project Folder to Push to GitHub',
    });
    if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
    }
    return { canceled: false, folderPath: result.filePaths[0] };
});

// Auth — open in system browser (Google blocks embedded WebViews)
let authPollInterval = null;

ipcMain.handle('auth:login', async () => {
    console.log('[Auth IPC] auth:login handler called');

    // Open Google auth in the system browser
    shell.openExternal(`${BASE_URL}/auth/google`);

    // Poll the server to check when auth completes
    // The server stores the latest authenticated user after OAuth callback
    if (authPollInterval) clearInterval(authPollInterval);

    authPollInterval = setInterval(async () => {
        try {
            const res = await fetch(`${BASE_URL}/auth/electron-check`);
            const data = await res.json();

            if (data.user) {
                clearInterval(authPollInterval);
                authPollInterval = null;
                currentUser = data.user;
                saveUser(currentUser);
                console.log('[Auth] Logged in as:', currentUser.name);
                mainWindow?.webContents.send('auth:success', currentUser);
            }
        } catch (err) {
            // Server not ready yet, keep polling
        }
    }, 1500);

    // Stop polling after 2 minutes
    setTimeout(() => {
        if (authPollInterval) {
            clearInterval(authPollInterval);
            authPollInterval = null;
            console.log('[Auth] Auth polling timed out');
        }
    }, 120000);

    return { success: true };
});

ipcMain.handle('auth:status', async () => {
    // Try to restore saved user from disk if not in memory
    if (!currentUser) {
        currentUser = loadSavedUser();
        if (currentUser) {
            console.log('[Auth] Restored saved session for:', currentUser.name);
        }
    }

    if (currentUser) {
        return {
            authenticated: true,
            user: currentUser,
        };
    }
    return { authenticated: false };
});

ipcMain.handle('auth:logout', async () => {
    currentUser = null;
    clearSavedUser();
    return { success: true };
});

// Chat (conversation-scoped)
ipcMain.handle('chat:send', async (event, { message, conversationId }) => {
    if (!currentUser) return { error: 'Not authenticated' };

    try {
        const res = await apiFetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, conversationId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Chat request failed');
        return data;
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('chat:history', async (event, conversationId) => {
    if (!currentUser || !conversationId) return { messages: [] };

    try {
        const res = await apiFetch(`/api/messages/${conversationId}`);
        return await res.json();
    } catch {
        return { messages: [] };
    }
});

// Streaming chat (SSE via IPC events)
ipcMain.handle('chat:sendStream', async (event, { message, conversationId }) => {
    if (!currentUser) return { error: 'Not authenticated' };

    try {
        const res = await apiFetch('/api/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, conversationId }),
        });

        if (!res.ok) {
            const data = await res.json();
            return { error: data.error || 'Stream request failed' };
        }

        // Read SSE stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line in buffer

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('chat:stream', event);
                        }
                    } catch { /* ignore parse errors */ }
                }
            }
        }

        return { success: true };
    } catch (err) {
        return { error: err.message };
    }
});

// Conversations
ipcMain.handle('conversations:list', async () => {
    if (!currentUser) return { conversations: [] };
    try {
        const res = await apiFetch('/api/conversations');
        return await res.json();
    } catch {
        return { conversations: [] };
    }
});

ipcMain.handle('conversations:create', async (event, title) => {
    if (!currentUser) return { error: 'Not authenticated' };
    try {
        const res = await apiFetch('/api/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title }),
        });
        return await res.json();
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('conversations:delete', async (event, id) => {
    if (!currentUser) return { error: 'Not authenticated' };
    try {
        const res = await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
        return await res.json();
    } catch (err) {
        return { error: err.message };
    }
});

// Voice
ipcMain.handle('voice:toggle', () => {
    const enabled = voiceEngine.toggle();
    return { enabled };
});

ipcMain.handle('voice:trigger', () => {
    voiceEngine.manualTrigger();
    return { triggered: true };
});

ipcMain.handle('voice:state', () => {
    return voiceEngine.getState();
});

// ── Voice Engine Events → Renderer ─────────────────────────
function setupVoiceEvents() {
    voiceEngine.on('stateChange', (state) => {
        mainWindow?.webContents.send('voice:stateChange', state);
    });

    voiceEngine.on('userSpeech', (text) => {
        mainWindow?.webContents.send('voice:userSpeech', text);
    });

    voiceEngine.on('assistantResponse', (text) => {
        mainWindow?.webContents.send('voice:assistantResponse', text);
    });

    voiceEngine.on('error', (err) => {
        mainWindow?.webContents.send('voice:error', err.message);
    });

    // Connect voice engine to backend chat
    voiceEngine.setChatHandler(async (text) => {
        if (!currentUser) return 'Not authenticated. Please sign in first.';

        try {
            const res = await apiFetch('/api/voice-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
            });
            const data = await res.json();
            return data.reply || data.error || 'No response';
        } catch (err) {
            return 'Voice chat error: ' + err.message;
        }
    });
}

// ── App Lifecycle ──────────────────────────────────────────
app.whenReady().then(async () => {
    try {
        // Start backend server as a child process using SYSTEM Node.js (not Electron's)
        // fork() would use Electron's Node.js (process.execPath), causing native module mismatch
        const serverScript = path.join(__dirname, '..', 'src', 'server.js');
        server = spawn('node', [serverScript], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
            shell: true,
        });
        server.stdout.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));
        server.stderr.on('data', (d) => console.error(`[Server] ${d.toString().trim()}`));
        server.on('error', (err) => console.error('[Server] Process error:', err));
        server.on('exit', (code) => console.log(`[Server] Exited with code ${code}`));

        // Wait for server to be ready
        await new Promise((resolve) => {
            const check = setInterval(async () => {
                try {
                    const res = await fetch(`http://localhost:${PORT}/api/health`);
                    if (res.ok) { clearInterval(check); resolve(); }
                } catch { /* not ready yet */ }
            }, 500);
            // Timeout after 15 seconds
            setTimeout(() => { clearInterval(check); resolve(); }, 15000);
        });
        console.log('[Electron] Backend server started');

        // Initialize voice engine (needs sox)
        try {
            // Add sox directory to PATH so all child processes can find it
            const soxPath = process.env.SOX_PATH;
            if (soxPath) {
                const soxDir = path.dirname(soxPath);
                process.env.PATH = soxDir + path.delimiter + (process.env.PATH || '');
                // Verify sox is now reachable
                execSync(`"${soxPath}" --version`, { stdio: 'ignore' });
                console.log('[Electron] Sox found at:', soxPath);
            } else {
                execSync('sox --version', { stdio: 'ignore' });
            }
            await voiceEngine.initialize();
            voiceAvailable = true;
            setupVoiceEvents();
            console.log('[Electron] Voice engine ready');
        } catch (voiceErr) {
            voiceAvailable = false;
            console.warn('[Electron] Voice engine disabled:', voiceErr.message);
        }

        // Create window
        createWindow();

        // Windows: Set AppUserModelId for notifications
        if (process.platform === 'win32') {
            app.setAppUserModelId('com.iamanimeshdev.prisma');
        }

        // Start polling for triggered reminders (Pulse)
        startPulsePolling();
    } catch (err) {
        console.error('[Electron] Startup error:', err);
    }
});

let pulsePollTimer = null;
function startPulsePolling() {
    if (pulsePollTimer) return;
    console.log('[Pulse] Notification polling started');

    // Poll every 5 seconds for all pulse notifications
    pulsePollTimer = setInterval(async () => {
        if (!currentUser) return;

        try {
            // Poll pulse notifications (emails, calendar, jobs, reminders)
            const pulseRes = await fetch(`${BASE_URL}/api/pulse/notifications`);
            if (pulseRes.ok) {
                const { notifications } = await pulseRes.json();
                if (notifications && notifications.length > 0) {
                    for (const notif of notifications) {
                        // Native OS notification for urgent/important
                        if (notif.priority === 'urgent' || notif.priority === 'important') {
                            const { Notification } = require('electron');
                            if (Notification.isSupported()) {
                                const iconPath = path.join(__dirname, 'icon.png');
                                const nativeNotif = new Notification({
                                    title: notif.title,
                                    body: notif.body?.substring(0, 200) || '',
                                    icon: fs.existsSync(iconPath) ? iconPath : undefined,
                                });
                                // Handle click — open URL if action exists
                                const urlAction = notif.actions?.find(a => a.type === 'open_url');
                                if (urlAction) {
                                    nativeNotif.on('click', () => shell.openExternal(urlAction.url));
                                }
                                nativeNotif.show();
                            }
                        }

                        // In-app toast (always)
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('pulse:notify', notif);
                        }
                    }
                }
            }

            // Also poll reminders (legacy support)
            const remRes = await apiFetch('/api/reminders/triggered');
            if (remRes.ok) {
                const { reminders } = await remRes.json();
                if (reminders && reminders.length > 0) {
                    for (const reminder of reminders) {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('reminder:trigger', reminder);
                        }
                    }
                }
            }
        } catch (err) {
            // Server not ready, ignore
        }
    }, 5000);
}

app.on('window-all-closed', () => {
    voiceEngine.destroy();
    if (server && !server.killed) server.kill();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
