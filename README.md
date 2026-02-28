# PRISMA 💎

### Personal Research & Intelligent System Manager Assistant

> 🏆 **AMD Slingshot Hackathon Submission**

PRISMA is a locally-hosted, AI-powered developer productivity assistant that lives on your desktop and in your pocket. It combines a premium **Electron** desktop app, a **Telegram bot**, and a **voice interface** into one unified system — powered by an LLM with **22 autonomous AI tools** that can chain together to complete complex multi-step workflows without human intervention.

Built with **Node.js**, **Express**, **Electron**, and **SQLite**. Runs entirely on your local machine. Your data never leaves your device.

---

## 🎯 What Makes PRISMA Different?

| Traditional AI Assistants | PRISMA |
|---------------------------|--------|
| Reactive — waits for you to ask | **Proactive** — monitors, scans, and alerts autonomously |
| Forgets everything between chats | **Persistent memory** — remembers your contacts, preferences, projects |
| Text-only, browser-only | **Desktop app + Telegram + Voice** (wake word "Prisma") |
| Can only chat | **22 tools** — sends emails, pushes code, creates PRs, scans for secrets |
| No background processing | **Pulse Engine** — 6 autonomous loops running 24/7 |

---

## ✨ Key Features

### 🧠 Persistent Memory System
PRISMA proactively learns and remembers facts about you — contacts, preferences, GitHub usernames, project details — across all conversations. Stored locally in SQLite.

### 📧 Gmail Integration
Read, send, and schedule emails through natural language. Proactively monitors specific senders and pushes urgent Telegram alerts when they email you.

### 📅 Google Calendar
Create events, check your schedule, and get **automatic meeting briefs 10 minutes before** each event via desktop notification and Telegram.

### 🔧 Smart GitHub Push
Drag & drop any project folder and PRISMA will:
- Auto-detect the tech stack (Node, Python, Java, Go, Rust, etc.)
- Generate a professional `README.md` with directory tree
- Generate a stack-specific `.gitignore`
- Init git, create the repo, commit, and push — all in one step

### 🛡️ Repo Guardian — Proactive Security Scanner
Every push is automatically scanned for **leaked secrets**: AWS keys, API tokens, `.env` files, private keys, and more. Results are emailed as a styled HTML security report.

### 🤖 AI-Powered Issue → PR Generation
When a new GitHub issue is opened, PRISMA reads the entire codebase, sends it to an LLM, generates file changes, commits to a new branch via the Git Trees API, and opens a draft Pull Request — **fully autonomously**.

### 🔍 GitHub Discovery Tools
List repositories for any GitHub user, get repo summaries with stats, and search across all public GitHub repos for code or topics.

### ⏰ Job Scheduler
Schedule emails for future delivery, set up recurring actions (daily/weekly/hourly), and manage all pending jobs through natural language.

### 🎙️ Voice Interface
- **Wake word detection** — Say "Prisma" to activate (Porcupine)
- **Speech-to-Text** — Local Whisper server for high-accuracy transcription
- **Text-to-Speech** — Microsoft Edge neural voices for natural responses
- Full hands-free conversation loop

### 💬 Telegram Bot
Access PRISMA from anywhere. Text messages, voice notes, and tool execution indicators. Commands: `/start`, `/new`, `/emailcheck`, `/emailstop`, `/syncrepos`, `/help`.

### 🫀 Pulse Engine — Autonomous Background Agent
The heartbeat of PRISMA. Runs 6 parallel monitoring loops:

| Loop | Interval | Purpose |
|------|----------|---------|
| 📧 Email | 5 min | Checks Gmail, alerts for monitored senders |
| 📅 Calendar | 5 min | Sends meeting briefs before events |
| ⏰ Reminders | 10 sec | Fires desktop + Telegram notifications |
| 🔧 Repo Sync | 10 min | Discovers repos, registers GitHub webhooks |
| ⚙️ Jobs | 10 sec | Executes scheduled emails and recurring tasks |
| 🧹 Cleanup | 1 hour | Purges old notification logs |

### 🌐 GitHub Webhooks (Instant Notifications)
Auto-creates an **ngrok tunnel**, registers webhooks on all your repos, and handles `push`, `issues`, `pull_request`, `pull_request_review`, and `issue_comment` events with instant Telegram alerts.

---

## 🏗️ Architecture

```
┌─────────────────────┐      ┌──────────────────┐
│  Electron Desktop   │─IPC─▶│   Express API    │
│  (Glassmorphism UI) │      │   (server.js)    │
└─────────────────────┘      └────────┬─────────┘
                                      │
┌─────────────────────┐               │
│   Telegram Bot      │───────────────┤
│  (Text + Voice)     │               │
└─────────────────────┘        ┌──────▼──────┐
                               │  AI Engine  │──▶ OpenRouter LLM
┌─────────────────────┐        │  (ai.js)    │
│  GitHub Webhooks    │───────▶│             │
│  (via ngrok)        │        └──────┬──────┘
└─────────────────────┘               │
                               ┌──────▼──────┐
┌─────────────────────┐        │   22 Tools  │
│   Pulse Engine      │───────▶│  Registry   │
│  (6 bg loops)       │        └──────┬──────┘
└─────────────────────┘               │
                               ┌──────▼──────┐
┌─────────────────────┐        │  SQLite DB  │
│   Voice Engine      │───────▶│  (Local)    │
│ (Wake + STT + TTS)  │        └─────────────┘
└─────────────────────┘
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop App | Electron, HTML/CSS/JS |
| Backend | Node.js, Express |
| AI Model | OpenRouter API (LLM) |
| Database | SQLite (better-sqlite3) |
| Auth | Google OAuth 2.0 |
| Email/Calendar | Gmail & Calendar API (googleapis) |
| Voice STT | Whisper (Python FastAPI server) |
| Voice TTS | Microsoft Edge TTS (edge-tts) |
| Wake Word | Porcupine (Picovoice) |
| Telegram | node-telegram-bot-api |
| Tunneling | ngrok (for webhooks) |
| Validation | Zod |
| GitHub | GitHub CLI (gh) |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** v18+
- **Python** 3.8+ (for Whisper STT server)
- **GitHub CLI** (`gh`) installed and authenticated
- **SoX** (for voice recording on Windows)
- **ngrok** (for GitHub webhooks)

### Installation

```bash
# Clone the repository
git clone https://github.com/iamanimeshdev/Prisma.git
cd Prisma

# Install dependencies
npm install

# Python setup (for voice)
pip install faster-whisper edge-tts fastapi uvicorn
```

### Configuration

Create a `.env` file in the root directory:

```env
# AI
OPENROUTER_API_KEY=your_openrouter_api_key

# Google OAuth (Register at Google Cloud Console)
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback

# Telegram Bot
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_OWNER_ID=your_telegram_user_id

# Voice
PORCUPINE_ACCESS_KEY=your_picovoice_access_key
TTS_VOICE=en-US-AvaNeural
SOX_PATH=C:/Program Files (x86)/sox-14-4-2/sox.exe
PYTHON_PATH=python

# Server
PORT=3000
SESSION_SECRET=prisma_secure_random_string
```

### Run

```bash
# Start everything (Electron + Backend server)
npx electron .
```

---

## 📁 Project Structure

```
Prisma/
├── electron/                # Electron app (frontend)
│   ├── main.js              # Main process + IPC handlers
│   ├── preload.js           # Secure IPC bridge
│   ├── renderer.js          # UI logic + streaming
│   ├── index.html           # App shell
│   └── styles.css           # Glassmorphism dark theme
├── src/
│   ├── core/
│   │   ├── ai.js            # LLM gateway (streaming + tool loops)
│   │   ├── context.js       # System prompt + conversation context
│   │   ├── database.js      # SQLite schema + helpers
│   │   └── toolRegistry.js  # Dynamic tool registration
│   ├── services/
│   │   ├── auth.js          # Google OAuth 2.0
│   │   ├── pulse.js         # Background agent (958 lines)
│   │   ├── scheduler.js     # Job execution engine
│   │   ├── telegramBot.js   # Telegram integration
│   │   └── tunnel.js        # ngrok tunnel manager
│   ├── tools/
│   │   ├── emailTools.js    # Gmail read/send/monitor
│   │   ├── calendarTools.js # Google Calendar
│   │   ├── memoryTools.js   # Persistent memory CRUD
│   │   ├── gitTools.js      # Smart GitHub push
│   │   ├── githubTools.js   # Repo search/list/summarize
│   │   ├── repoGuardian.js  # Security scanner
│   │   ├── issuePrTools.js  # AI issue→PR generator
│   │   └── scheduleTools.js # Job scheduler
│   ├── voice/
│   │   ├── engine.js        # Voice conversation loop
│   │   ├── wakeWord.js      # Porcupine wake word
│   │   ├── stt.js           # Speech-to-text client
│   │   ├── tts.js           # Text-to-speech (Edge TTS)
│   │   └── voiceServer.js   # Local Whisper FastAPI server
│   ├── routes/
│   │   └── webhookRoutes.js # GitHub webhook handlers
│   └── server.js            # Express API + SSE streaming
├── prisma.db                # Local SQLite database
├── package.json
└── .env                     # Configuration (not committed)
```

---

## 🔒 Privacy & Security

PRISMA is **local-first** by design:
- All data stored in a local SQLite file (`prisma.db`) — nothing leaves your machine
- Google OAuth uses secure system browser (not embedded webviews)
- API calls are only made with user-requested context
- No telemetry, no tracking, no cloud storage

---

## 🧰 All 22 AI Tools

| Category | Tools |
|----------|-------|
| **Email** | `get_unread_emails`, `summarize_email`, `extract_event_from_email`, `send_email`, `monitor_email_sender`, `stop_monitoring_sender` |
| **Calendar** | `create_calendar_event`, `get_upcoming_events`, `create_reminder` |
| **Memory** | `store_memory`, `recall_memory`, `update_memory`, `forget_memory` |
| **GitHub** | `push_to_github`, `list_github_repos`, `summarize_github_repo`, `search_github`, `generate_pr_from_issue` |
| **Security** | `scan_repo` |
| **Scheduler** | `schedule_email`, `schedule_action`, `list_scheduled_jobs`, `cancel_scheduled_job` |

---

## 📝 License

Distributed under the MIT License.

---

<p align="center">
  <b>PRISMA</b> — Built with ❤️ for the <b>AMD Slingshot Hackathon</b>
</p>
