// ============================================================
// PRISMA — Ngrok Tunnel Manager
// ============================================================
// Spawns and manages the ngrok process to expose the local
// PRISMA server to the internet for GitHub webhooks.
// Uses ngrok's local API at http://127.0.0.1:4040 to get the URL.
// ============================================================
const { spawn, execSync } = require('child_process');
const http = require('http');

class TunnelManager {
    constructor() {
        this.ngrokProcess = null;
        this.publicUrl = null;
        this.port = process.env.PORT || 3000;
        this.ready = false;
        this.onReadyCallbacks = [];
    }

    /**
     * Start the ngrok tunnel.
     */
    async start() {
        if (this.ngrokProcess) return this.publicUrl;

        // Check if ngrok is installed
        try {
            execSync('ngrok version', {
                encoding: 'utf8', shell: true, timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            });
        } catch (err) {
            console.warn('[Tunnel] ngrok is not installed or not in PATH.');
            console.warn('[Tunnel] Install from https://ngrok.com/download for real-time webhooks.');
            console.warn('[Tunnel] PRISMA will continue without real-time webhooks.');
            return null;
        }

        console.log(`[Tunnel] Starting ngrok tunnel on port ${this.port}...`);

        return new Promise((resolve) => {
            // Spawn ngrok in the background
            this.ngrokProcess = spawn('ngrok', ['http', String(this.port)], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });

            this.ngrokProcess.unref();

            // Poll the ngrok local API (http://127.0.0.1:4040) for the public URL
            let attempts = 0;
            const pollInterval = setInterval(() => {
                attempts++;
                if (attempts > 20) { // 10 seconds max
                    clearInterval(pollInterval);
                    console.error('[Tunnel] Failed to get ngrok URL. Is ngrok authenticated?');
                    console.error('[Tunnel] Run: ngrok config add-authtoken YOUR_TOKEN');
                    this.stop();
                    resolve(null);
                    return;
                }

                // Query ngrok's local API
                const req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            const tunnel = (json.tunnels || []).find(t =>
                                t.proto === 'https' && t.config && t.config.addr &&
                                t.config.addr.includes(String(this.port))
                            );
                            if (tunnel && tunnel.public_url) {
                                clearInterval(pollInterval);
                                this.publicUrl = tunnel.public_url;
                                this.ready = true;
                                console.log(`[Tunnel] Tunnel active: ${this.publicUrl}`);
                                this._notifyReady();
                                resolve(this.publicUrl);
                            }
                        } catch (e) {
                            // API not ready yet, ignore and retry
                        }
                    });
                });

                req.on('error', () => {
                    // ngrok API not up yet, ignore and retry
                });
                req.end();
            }, 500);
        });
    }

    /**
     * Stop the ngrok process.
     */
    stop() {
        if (this.ngrokProcess) {
            console.log('[Tunnel] Stopping ngrok tunnel...');
            try {
                if (process.platform === 'win32') {
                    execSync(`taskkill /pid ${this.ngrokProcess.pid} /T /F`, {
                        stdio: 'ignore', windowsHide: true
                    });
                } else {
                    process.kill(-this.ngrokProcess.pid);
                }
            } catch { /* already dead */ }
            this.ngrokProcess = null;
            this.publicUrl = null;
            this.ready = false;
        }
    }

    /**
     * Get the current public URL.
     */
    getUrl() {
        return this.publicUrl;
    }

    /**
     * Wait for the tunnel to be ready.
     */
    onReady(callback) {
        if (this.ready) {
            callback(this.publicUrl);
        } else {
            this.onReadyCallbacks.push(callback);
        }
    }

    _notifyReady() {
        for (const cb of this.onReadyCallbacks) {
            try { cb(this.publicUrl); } catch (e) { console.error(e); }
        }
        this.onReadyCallbacks = [];
    }
}

const tunnelManager = new TunnelManager();

process.on('exit', () => tunnelManager.stop());
process.on('SIGINT', () => { tunnelManager.stop(); process.exit(); });
process.on('SIGTERM', () => { tunnelManager.stop(); process.exit(); });

module.exports = tunnelManager;
