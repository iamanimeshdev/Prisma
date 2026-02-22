// ============================================================
// PRISMA — Electron Preload Script (Secure IPC Bridge)
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prisma', {
    // ── Window Controls ─────────────────────────
    window: {
        minimize: () => ipcRenderer.invoke('window:minimize'),
        maximize: () => ipcRenderer.invoke('window:maximize'),
        close: () => ipcRenderer.invoke('window:close'),
    },

    // ── Authentication ──────────────────────────
    auth: {
        login: () => ipcRenderer.invoke('auth:login'),
        logout: () => ipcRenderer.invoke('auth:logout'),
        getStatus: () => ipcRenderer.invoke('auth:status'),
        onAuthSuccess: (callback) => {
            ipcRenderer.on('auth:success', (_, user) => callback(user));
        },
    },

    // ── Conversations ───────────────────────────
    conversations: {
        list: () => ipcRenderer.invoke('conversations:list'),
        create: (title) => ipcRenderer.invoke('conversations:create', title),
        delete: (id) => ipcRenderer.invoke('conversations:delete', id),
    },

    // ── Chat (conversation-scoped) ──────────────
    chat: {
        send: ({ message, conversationId }) => ipcRenderer.invoke('chat:send', { message, conversationId }),
        getHistory: (conversationId) => ipcRenderer.invoke('chat:history', conversationId),
    },

    // ── Voice ───────────────────────────────────
    voice: {
        toggle: () => ipcRenderer.invoke('voice:toggle'),
        trigger: () => ipcRenderer.invoke('voice:trigger'),
        getState: () => ipcRenderer.invoke('voice:state'),
        onStateChange: (callback) => {
            ipcRenderer.on('voice:stateChange', (_, state) => callback(state));
        },
        onUserSpeech: (callback) => {
            ipcRenderer.on('voice:userSpeech', (_, text) => callback(text));
        },
        onAssistantResponse: (callback) => {
            ipcRenderer.on('voice:assistantResponse', (_, text) => callback(text));
        },
        onError: (callback) => {
            ipcRenderer.on('voice:error', (_, error) => callback(error));
        },
    },
});
