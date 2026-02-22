# PRISMA — Personal Research & Intelligent System Manager Assistant 💎

PRISMA is a premium, state-of-the-art AI assistant built with **Electron**, **Node.js**, and the **Gemini 1.5 Flash** model. It lives on your desktop, integrating deeply with your workflow through voice commands, multi-chat support, and a cross-conversation global memory system.

![PRISMA Preview](https://via.placeholder.com/800x450/0a0a0f/7c5cfc?text=PRISMA+AI+Desktop+Assistant)

## ✨ Core Features

- **🗣️ Advanced Voice Engine**: Wake word detection ("Prisma") and high-accuracy speech-to-text using `faster-whisper`.
- **🧠 Global Memory System**: Proactive learning that remembers contact info, preferences, and facts about you across different chat sessions.
- **💬 Multi-Chat Integration**: Manage independent conversations with persistent history and auto-titling logic.
- **📧 Workspace Tools**: 
  - **Email**: Read, summarize, and proactively send emails via Gmail.
  - **Calendar**: Create events and check your schedule.
  - **Reminders**: Local notifications that trigger at specified times.
- **🎨 Premium UX/UI**: A sleek, dark-themed glassmorphism interface with smooth animations and responsive design.

---

## 🚀 Getting Started

### Prerequisites

1.  **Node.js**: v18 or higher.
2.  **SoX (Sound eXchange)**: Required for voice recording.
    - **Windows**: Download [SoX v14.4.2](https://sourceforge.net/projects/sox/) and add it to your environment variables or configure `SOX_PATH` in `.env`.
3.  **Python**: Required for the speech-to-text pipeline (`faster-whisper`).

### Installation

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/your-username/Prisma.git
    cd Prisma
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    # Native modules like better-sqlite3 will be rebuilt automatically for Electron
    ```

3.  **Python Setup**:
    ```bash
    pip install faster-whisper
    ```

### Configuration

Create a `.env` file in the root directory:

```env
# AI
GEMINI_API_KEY=your_gemini_api_key

# Google OAuth (Register at Google Cloud Console)
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback

# Paths
SOX_PATH=C:/Program Files (x86)/sox-14-4-2/sox.exe
PYTHON_PATH=python

# Server
PORT=3000
SESSION_SECRET=prisma_secure_random_string
```

---

## 🛠️ Project Structure

```text
Prisma/
├── electron/          # Main process, preload, and renderer (frontend)
├── src/
│   ├── core/          # Database, AI Gateway, Context Manager
│   ├── voice/         # STT, TTS, WakeWord, Voice Engine
│   ├── services/      # Auth, Scheduler
│   ├── tools/         # Integrated Gemini tools (Email, Calendar, Memory)
│   └── server.js      # Express API backend
├── prisma.db          # Local SQLite database
└── package.json
```

---

## 💻 Usage

1.  **Start PRISMA**:
    ```bash
    npm run electron
    ```
2.  **Login**: Click "Sign in with Google" to authorize secure local access (OAuth 2.0).
3.  **Chat**: Type your requests or use the Microphone icon.
4.  **Voice**: Enable "Voice Mode" to talk to PRISMA hands-free.

---

## 🔒 Privacy & Security

PRISMA is designed to be **local-first**.
- Your database (`prisma.db`) stays on your machine.
- Authentication uses secure system browsers (Google blocks embedded webviews).
- Gemini API calls are only made with user-requested context.

---

## 📝 License

Distributed under the MIT License. See `LICENSE` for more information.
