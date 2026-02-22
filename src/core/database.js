// ============================================================
// PRISMA — Database Layer (SQLite via better-sqlite3)
// ============================================================
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'prisma.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// ── Schema Initialization ──────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    picture TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New Chat',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    conversation_id TEXT,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS google_tokens (
    user_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expiry_date INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    datetime TEXT NOT NULL,
    triggered INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    category TEXT DEFAULT 'fact',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, key)
  );

  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT,
    content TEXT,
    embedding BLOB,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    transcript TEXT,
    summary TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ── Database Migration ─────────────────────────────────────
// Ensure messages table has conversation_id column (for users with existing DBs)
const tableInfo = db.prepare("PRAGMA table_info(messages)").all();
const hasConversationId = tableInfo.some(col => col.name === 'conversation_id');
if (!hasConversationId) {
  console.log('[Database] Migrating: Adding conversation_id to messages table');
  try {
    db.exec("ALTER TABLE messages ADD COLUMN conversation_id TEXT REFERENCES conversations(id)");
  } catch (err) {
    console.error('[Database] Migration failed:', err.message);
  }
}

// ── Prepared Statements ────────────────────────────────────
const stmts = {
  // Users
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  upsertUser: db.prepare(`
    INSERT INTO users (id, email, name, picture)
    VALUES (@id, @email, @name, @picture)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      name  = excluded.name,
      picture = excluded.picture
  `),

  // Conversations
  createConversation: db.prepare(`
    INSERT INTO conversations (id, user_id, title) VALUES (@id, @userId, @title)
  `),
  getConversations: db.prepare(`
    SELECT id, title, created_at, updated_at FROM conversations
    WHERE user_id = ? ORDER BY updated_at DESC
  `),
  getConversation: db.prepare('SELECT * FROM conversations WHERE id = ?'),
  updateConversationTitle: db.prepare(`
    UPDATE conversations SET title = @title, updated_at = datetime('now') WHERE id = @id
  `),
  touchConversation: db.prepare(`
    UPDATE conversations SET updated_at = datetime('now') WHERE id = ?
  `),
  deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),
  deleteConversationMessages: db.prepare('DELETE FROM messages WHERE conversation_id = ?'),

  // Messages (conversation-scoped)
  saveMessage: db.prepare(`
    INSERT INTO messages (id, user_id, conversation_id, role, content)
    VALUES (@id, @userId, @conversationId, @role, @content)
  `),
  getConversationMessages: db.prepare(`
    SELECT role, content FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
    LIMIT 50
  `),

  // Tokens
  saveTokens: db.prepare(`
    INSERT INTO google_tokens (user_id, access_token, refresh_token, expiry_date)
    VALUES (@userId, @accessToken, @refreshToken, @expiryDate)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, google_tokens.refresh_token),
      expiry_date   = excluded.expiry_date
  `),
  getTokens: db.prepare('SELECT * FROM google_tokens WHERE user_id = ?'),

  // Reminders
  createReminder: db.prepare(`
    INSERT INTO reminders (id, user_id, title, datetime) VALUES (@id, @userId, @title, @datetime)
  `),
  getPendingReminders: db.prepare(`
    SELECT * FROM reminders WHERE triggered = 0 AND datetime <= datetime('now')
  `),
  markReminderTriggered: db.prepare('UPDATE reminders SET triggered = 1 WHERE id = ?'),

  // Memories (global, cross-chat)
  upsertMemory: db.prepare(`
    INSERT INTO memories (id, user_id, key, value, category)
    VALUES (@id, @userId, @key, @value, @category)
    ON CONFLICT(user_id, key) DO UPDATE SET
      value = excluded.value,
      category = excluded.category,
      updated_at = datetime('now')
  `),
  getMemory: db.prepare('SELECT * FROM memories WHERE user_id = ? AND key = ?'),
  searchMemories: db.prepare(`
    SELECT key, value, category FROM memories
    WHERE user_id = ? AND (key LIKE '%' || @query || '%' OR value LIKE '%' || @query || '%')
    ORDER BY updated_at DESC LIMIT 10
  `),
  getAllMemories: db.prepare(`
    SELECT key, value, category FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50
  `),
  deleteMemory: db.prepare('DELETE FROM memories WHERE user_id = ? AND key = ?'),
};

// ── Exported Helpers ───────────────────────────────────────
module.exports = {
  db,

  // Users
  getUser(id) {
    return stmts.getUser.get(id);
  },
  upsertUser({ id, email, name, picture }) {
    return stmts.upsertUser.run({ id, email, name, picture });
  },

  // Conversations
  createConversation({ id, userId, title }) {
    return stmts.createConversation.run({ id, userId, title: title || 'New Chat' });
  },
  getConversations(userId) {
    return stmts.getConversations.all(userId);
  },
  getConversation(id) {
    return stmts.getConversation.get(id);
  },
  updateConversationTitle(id, title) {
    return stmts.updateConversationTitle.run({ id, title });
  },
  touchConversation(id) {
    return stmts.touchConversation.run(id);
  },
  deleteConversation(id) {
    stmts.deleteConversationMessages.run(id);
    stmts.deleteConversation.run(id);
  },

  // Messages
  saveMessage({ id, userId, conversationId, role, content }) {
    stmts.saveMessage.run({ id, userId, conversationId, role, content });
    // Touch conversation timestamp
    if (conversationId) {
      stmts.touchConversation.run(conversationId);
    }
  },
  getConversationMessages(conversationId) {
    return stmts.getConversationMessages.all(conversationId);
  },

  // Tokens
  saveTokens({ userId, accessToken, refreshToken, expiryDate }) {
    return stmts.saveTokens.run({ userId, accessToken, refreshToken: refreshToken || null, expiryDate });
  },
  getTokens(userId) {
    return stmts.getTokens.get(userId);
  },

  // Reminders
  createReminder({ id, userId, title, datetime }) {
    return stmts.createReminder.run({ id, userId, title, datetime });
  },
  getPendingReminders() {
    return stmts.getPendingReminders.all();
  },
  markReminderTriggered(id) {
    return stmts.markReminderTriggered.run(id);
  },

  // Memories
  upsertMemory({ id, userId, key, value, category }) {
    return stmts.upsertMemory.run({ id, userId, key, value, category: category || 'fact' });
  },
  getMemory(userId, key) {
    return stmts.getMemory.get(userId, key);
  },
  searchMemories(userId, query) {
    return stmts.searchMemories.all(userId, { query });
  },
  getAllMemories(userId) {
    return stmts.getAllMemories.all(userId);
  },
  deleteMemory(userId, key) {
    return stmts.deleteMemory.run(userId, key);
  },
};
