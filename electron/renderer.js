// ============================================================
// PRISMA — Electron Renderer (UI Logic)
// ============================================================

// `prisma` is exposed as a global by contextBridge in preload.js
console.log('[Renderer] Script loaded, prisma API available:', !!prisma);

// ── State ──────────────────────────────────────────────────
let isAuthenticated = false;
let currentUser = null;
let isProcessing = false;
let activeConversationId = null;

// ── DOM References ─────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const loginScreen = $('#login-screen');
const chatScreen = $('#chat-screen');
const messagesContainer = $('#messages');
const chatInput = $('#chat-input');
const btnSend = $('#btn-send');
const btnLogin = $('#btn-login');
const btnLogout = $('#btn-logout');
const btnMic = $('#btn-mic');
const btnVoiceToggle = $('#btn-voice-toggle');
const btnNewChat = $('#btn-new-chat');
const voiceLabel = $('#voice-label');
const voiceBar = $('#voice-bar');
const voiceStatusText = $('#voice-status-text');
const toolIndicator = $('#tool-indicator');
const toolIndicatorText = $('#tool-indicator-text');
const userAvatar = $('#user-avatar');
const userName = $('#user-name');
const userEmail = $('#user-email');
const conversationList = $('#conversation-list');

// ── Window Controls ────────────────────────────────────────
$('#btn-minimize').addEventListener('click', () => prisma.window.minimize());
$('#btn-maximize').addEventListener('click', () => prisma.window.maximize());
$('#btn-close').addEventListener('click', () => prisma.window.close());

// ── Authentication ─────────────────────────────────────────
btnLogin.addEventListener('click', async () => {
    btnLogin.disabled = true;
    btnLogin.querySelector('span').textContent = 'Opening Google...';
    await prisma.auth.login();

    setTimeout(() => {
        if (!isAuthenticated) {
            btnLogin.disabled = false;
            btnLogin.querySelector('span').textContent = 'Sign in with Google';
        }
    }, 60000);
});

prisma.auth.onAuthSuccess((user) => {
    handleLogin(user);
});

btnLogout.addEventListener('click', async () => {
    await prisma.auth.logout();
    handleLogout();
});

function handleLogin(user) {
    isAuthenticated = true;
    currentUser = user;

    userAvatar.src = user.picture || '';
    userAvatar.style.display = user.picture ? 'block' : 'none';
    userName.textContent = user.name || 'User';
    userEmail.textContent = user.email || '';

    loginScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');

    loadConversations();
}

function handleLogout() {
    isAuthenticated = false;
    currentUser = null;
    activeConversationId = null;
    chatScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    messagesContainer.innerHTML = getWelcomeHTML();
    btnLogin.disabled = false;
    btnLogin.querySelector('span').textContent = 'Sign in with Google';
}

// ── Conversation Management ────────────────────────────────
async function loadConversations() {
    const data = await prisma.conversations.list();
    renderConversationList(data.conversations || []);

    // Auto-select first conversation or show welcome
    if (data.conversations && data.conversations.length > 0) {
        await switchConversation(data.conversations[0].id);
    } else {
        activeConversationId = null;
        messagesContainer.innerHTML = getWelcomeHTML();
    }
}

function renderConversationList(conversations) {
    if (conversations.length === 0) {
        conversationList.innerHTML = '<div class="conv-empty">No conversations yet.<br>Click <strong>New Chat</strong> to start!</div>';
        return;
    }

    conversationList.innerHTML = conversations.map((c) => `
        <div class="conv-item ${c.id === activeConversationId ? 'active' : ''}" data-id="${c.id}">
            <span class="conv-item-title">${escapeHTML(c.title)}</span>
            <button class="conv-item-delete" data-id="${c.id}" title="Delete">✕</button>
        </div>
    `).join('');
}

// Click handlers for conversation list
conversationList.addEventListener('click', async (e) => {
    // Delete button
    const deleteBtn = e.target.closest('.conv-item-delete');
    if (deleteBtn) {
        e.stopPropagation();
        const id = deleteBtn.dataset.id;
        await prisma.conversations.delete(id);
        if (id === activeConversationId) activeConversationId = null;
        await loadConversations();
        return;
    }

    // Select conversation
    const item = e.target.closest('.conv-item');
    if (item) {
        await switchConversation(item.dataset.id);
    }
});

async function switchConversation(conversationId) {
    if (conversationId === activeConversationId) return;
    activeConversationId = conversationId;

    // Highlight active in sidebar
    document.querySelectorAll('.conv-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.id === conversationId);
    });

    // Load messages
    messagesContainer.innerHTML = '';
    await loadHistory(conversationId);
}

btnNewChat.addEventListener('click', async () => {
    const data = await prisma.conversations.create('New Chat');
    if (data.id) {
        activeConversationId = data.id;
        await loadConversations();
        messagesContainer.innerHTML = getWelcomeHTML();
        chatInput.focus();
    }
});

// ── Chat ───────────────────────────────────────────────────
btnSend.addEventListener('click', sendMessage);

chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

async function sendMessage() {
    const message = chatInput.value.trim();
    if (!message || isProcessing) return;

    // Auto-create a conversation if none is active
    if (!activeConversationId) {
        const data = await prisma.conversations.create('New Chat');
        if (data.id) {
            activeConversationId = data.id;
        } else {
            addMessage('assistant', '⚠️ Failed to create conversation.');
            return;
        }
    }

    isProcessing = true;
    btnSend.disabled = true;
    chatInput.value = '';
    chatInput.style.height = 'auto';

    const welcome = messagesContainer.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    addMessage('user', message);
    const typingEl = addTypingIndicator();
    showToolIndicator('Processing your request...');

    // Create an empty assistant message bubble for streaming
    const streamBubble = createStreamBubble();
    let typingRemoved = false;

    // Set up stream listener
    let actualListener = null;

    const cleanup = () => {
        if (actualListener) {
            prisma.chat.removeStreamListener(actualListener);
            actualListener = null;
        }
    };

    const streamHandler = (event) => {
        if (event.type === 'chunk') {
            if (!typingRemoved) {
                typingEl.remove();
                typingRemoved = true;
            }
            updateStreamBubble(streamBubble, event.text);
        } else if (event.type === 'tool') {
            showToolIndicator(`Using ${event.name.replace(/_/g, ' ')}...`);
        } else if (event.type === 'done') {
            hideToolIndicator();
            if (!typingRemoved) typingEl.remove();
            // Final update with formatted content
            updateStreamBubble(streamBubble, event.text, true);
            refreshConversationList();
            cleanup();
            isProcessing = false;
            btnSend.disabled = false;
            chatInput.focus();
        } else if (event.type === 'error') {
            hideToolIndicator();
            if (!typingRemoved) typingEl.remove();
            updateStreamBubble(streamBubble, `⚠️ ${event.error}`, true);
            cleanup();
            isProcessing = false;
            btnSend.disabled = false;
            chatInput.focus();
        }
    };

    actualListener = prisma.chat.onStream(streamHandler);

    try {
        const result = await prisma.chat.sendStream({
            message,
            conversationId: activeConversationId,
        });

        if (result.error) {
            hideToolIndicator();
            if (!typingRemoved) typingEl.remove();
            updateStreamBubble(streamBubble, `⚠️ ${result.error}`, true);
            cleanup();
            isProcessing = false;
            btnSend.disabled = false;
            chatInput.focus();
        }
    } catch (err) {
        hideToolIndicator();
        if (!typingRemoved) typingEl.remove();
        updateStreamBubble(streamBubble, `⚠️ Error: ${err.message}`, true);
        cleanup();
        isProcessing = false;
        btnSend.disabled = false;
        chatInput.focus();
    }
}

function createStreamBubble() {
    const msgEl = document.createElement('div');
    msgEl.className = 'message assistant';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = '◆';

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    contentEl.innerHTML = '';

    msgEl.appendChild(avatar);
    msgEl.appendChild(contentEl);
    messagesContainer.appendChild(msgEl);
    // Don't add to DOM yet — only visible once first chunk arrives
    msgEl.style.display = 'none';

    return { element: msgEl, content: contentEl };
}

function updateStreamBubble(bubble, text, isFinal = false) {
    bubble.element.style.display = 'flex';
    if (isFinal) {
        bubble.content.innerHTML = formatMessage(text);
    } else {
        // During streaming, show raw text with cursor
        bubble.content.innerHTML = formatMessage(text) + '<span class="stream-cursor">▌</span>';
    }
    scrollToBottom();
}

async function refreshConversationList() {
    const data = await prisma.conversations.list();
    renderConversationList(data.conversations || []);
}

// ── Quick Actions ──────────────────────────────────────────
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('quick-btn')) {
        chatInput.value = e.target.dataset.msg;
        sendMessage();
    }
});

// ── Message Rendering ──────────────────────────────────────
function addMessage(role, content) {
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';

    if (role === 'user') {
        avatar.textContent = currentUser?.name?.[0]?.toUpperCase() || 'U';
    } else {
        avatar.textContent = '◆';
    }

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    contentEl.innerHTML = formatMessage(content);

    msgEl.appendChild(avatar);
    msgEl.appendChild(contentEl);
    messagesContainer.appendChild(msgEl);

    scrollToBottom();
}

function addTypingIndicator() {
    const el = document.createElement('div');
    el.className = 'message assistant';
    el.innerHTML = `
    <div class="message-avatar">◆</div>
    <div class="message-content">
      <div class="typing-indicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>
  `;
    messagesContainer.appendChild(el);
    scrollToBottom();
    return el;
}

function formatMessage(text) {
    if (!text) return '';

    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/^[-•] (.+)/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
    html = html.replace(/^\d+\. (.+)/gm, '<li>$1</li>');

    return html;
}

function escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ── Message History ────────────────────────────────────────
async function loadHistory(conversationId) {
    try {
        const data = await prisma.chat.getHistory(conversationId);
        if (data.messages && data.messages.length > 0) {
            const welcome = messagesContainer.querySelector('.welcome-msg');
            if (welcome) welcome.remove();

            data.messages.forEach((msg) => {
                addMessage(msg.role, msg.content);
            });
        } else {
            messagesContainer.innerHTML = getWelcomeHTML();
        }
    } catch (err) {
        console.error('Failed to load history:', err);
    }
}

// ── Tool Indicator ─────────────────────────────────────────
function showToolIndicator(text) {
    toolIndicatorText.textContent = text;
    toolIndicator.classList.remove('hidden');
}

function hideToolIndicator() {
    toolIndicator.classList.add('hidden');
}

// ── Voice Controls ─────────────────────────────────────────
btnVoiceToggle.addEventListener('click', async () => {
    const result = await prisma.voice.toggle();
    updateVoiceUI(result.enabled);
});

btnMic.addEventListener('click', async () => {
    await prisma.voice.trigger();
});

function updateVoiceUI(enabled) {
    if (enabled) {
        btnVoiceToggle.classList.add('active');
        voiceLabel.textContent = 'Voice On';
        voiceBar.classList.remove('hidden');
    } else {
        btnVoiceToggle.classList.remove('active');
        voiceLabel.textContent = 'Voice Off';
        voiceBar.classList.add('hidden');
    }
}

// ── Voice Events ───────────────────────────────────────────
prisma.voice.onStateChange((state) => {
    const stateMap = {
        idle: 'Voice idle',
        listening_wake: 'Listening for wake word...',
        recording: '🔴 Recording your speech...',
        processing: 'Processing...',
        speaking: '🔊 Speaking response...',
    };
    voiceStatusText.textContent = stateMap[state] || state;
});

prisma.voice.onUserSpeech((text) => {
    const welcome = messagesContainer.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    addMessage('user', `🎤 ${text}`);
});

prisma.voice.onAssistantResponse((text) => {
    addMessage('assistant', text);
});

prisma.voice.onError((error) => {
    console.error('Voice error:', error);
});

// ── Welcome HTML ───────────────────────────────────────────
function getWelcomeHTML() {
    return `
    <div class="welcome-msg">
      <div class="welcome-prism">
        <svg viewBox="0 0 60 60" width="48" height="48">
          <polygon points="30,5 55,50 5,50" fill="none" stroke="url(#prismGrad)" stroke-width="1.5" opacity="0.6"/>
          <polygon points="30,15 45,45 15,45" fill="url(#prismGrad)" opacity="0.1"/>
        </svg>
      </div>
      <h2>Hello! I'm PRISMA</h2>
      <p>Your personal AI assistant. I can help you with emails, calendar, reminders, and more.</p>
      <div class="quick-actions">
        <button class="quick-btn" data-msg="Show my unread emails">📧 Unread Emails</button>
        <button class="quick-btn" data-msg="What are my upcoming events?">📅 Upcoming Events</button>
        <button class="quick-btn" data-msg="What can you do?">💡 Your Capabilities</button>
      </div>
    </div>
  `;
}

// ── Initial Auth Check ─────────────────────────────────────
(async () => {
    try {
        const status = await prisma.auth.getStatus();
        if (status.authenticated) {
            handleLogin(status.user);
        }
    } catch (err) {
        console.log('Initial auth check — not authenticated');
    }
})();

// ── Pulse Reminders ──────────────────────────────────────────
function showToast(title, message) {
    const toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        console.warn('[Pulse] Toast container not found in DOM');
        return;
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
    <div class="toast-icon">⏰</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
  `;

    toastContainer.appendChild(toast);

    // Auto-hide after 10 seconds
    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 400); // Wait for transition
    }, 10000);
}

prisma.reminders.onTrigger((reminder) => {
    showToast('PRISMA Reminder', reminder.title);
    // Also add to chat if active
    if (activeConversationId) {
        // Optional: you could add a specialized "system" message bubble here
        // addMessage('assistant', `⏰ Reminder: ${reminder.title}`);
    }
});
