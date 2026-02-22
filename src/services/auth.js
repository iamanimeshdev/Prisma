// ============================================================
// PRISMA — Google OAuth 2.0 Authentication
// ============================================================
const { google } = require('googleapis');
const db = require('../core/database');

const SCOPES = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar',
];

// Track the most recently authenticated user for Electron polling
let latestAuthUser = null;

/**
 * Create a fresh OAuth2 client instance.
 */
function createOAuth2Client() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
}

/**
 * Get an authenticated OAuth2 client for a specific user.
 * Automatically refreshes expired tokens.
 */
async function getAuthenticatedClient(userId) {
    const tokens = db.getTokens(userId);
    if (!tokens) throw new Error('No tokens found for user ' + userId);

    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date,
    });

    // Check if token is expired or about to expire (5 min buffer)
    const now = Date.now();
    if (tokens.expiry_date && now >= tokens.expiry_date - 5 * 60 * 1000) {
        try {
            const { credentials } = await oauth2Client.refreshAccessToken();
            db.saveTokens({
                userId,
                accessToken: credentials.access_token,
                refreshToken: credentials.refresh_token || tokens.refresh_token,
                expiryDate: credentials.expiry_date,
            });
            oauth2Client.setCredentials(credentials);
            console.log('[Auth] Token refreshed for user', userId);
        } catch (err) {
            console.error('[Auth] Token refresh failed:', err.message);
            throw new Error('Token refresh failed. Please re-authenticate.');
        }
    }

    return oauth2Client;
}

/**
 * Express middleware: require authenticated session or x-user-id header.
 * The x-user-id header is safe because the server only binds to localhost.
 */
function requireAuth(req, res, next) {
    // Check session first
    if (req.session && req.session.userId) {
        return next();
    }

    // Fall back to x-user-id header (from Electron main process)
    const headerUserId = req.headers['x-user-id'];
    if (headerUserId) {
        const user = db.getUser(headerUserId);
        if (user) {
            // Attach userId to request for downstream handlers
            req.session = req.session || {};
            req.session.userId = headerUserId;
            req.session.userEmail = user.email;
            req.session.userName = user.name;
            req.session.userPicture = user.picture;
            return next();
        }
    }

    return res.status(401).json({ error: 'Not authenticated' });
}

/**
 * Mount auth routes on an Express app.
 */
function mountAuthRoutes(app) {
    // ── Begin OAuth flow ──────────────────────────
    app.get('/auth/google', (req, res) => {
        const oauth2Client = createOAuth2Client();
        const url = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: SCOPES,
        });
        res.redirect(url);
    });

    // ── OAuth callback ────────────────────────────
    app.get('/auth/google/callback', async (req, res) => {
        const { code } = req.query;
        if (!code) return res.status(400).send('Missing auth code');

        try {
            const oauth2Client = createOAuth2Client();
            const { tokens } = await oauth2Client.getToken(code);
            oauth2Client.setCredentials(tokens);

            // Fetch user profile
            const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
            const { data: profile } = await oauth2.userinfo.get();

            // Persist user
            db.upsertUser({
                id: profile.id,
                email: profile.email,
                name: profile.name,
                picture: profile.picture,
            });

            // Persist tokens
            db.saveTokens({
                userId: profile.id,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                expiryDate: tokens.expiry_date,
            });

            // Set session
            req.session.userId = profile.id;
            req.session.userEmail = profile.email;
            req.session.userName = profile.name;
            req.session.userPicture = profile.picture;

            // Store for Electron polling
            latestAuthUser = {
                id: profile.id,
                email: profile.email,
                name: profile.name,
                picture: profile.picture,
            };

            // Redirect back to app — Electron will catch this
            res.send(`
        <html>
          <body style="background:#0a0a0f;color:#fff;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center">
              <h1 style="color:#7c5cfc">✓ Signed in as ${profile.name}</h1>
              <p style="color:#888">You can close this window and return to PRISMA.</p>
            </div>
          </body>
        </html>
      `);
        } catch (err) {
            console.error('[Auth] Callback error:', err);
            res.status(500).send('Authentication failed: ' + err.message);
        }
    });

    // ── Auth status ───────────────────────────────
    app.get('/auth/status', (req, res) => {
        if (req.session && req.session.userId) {
            res.json({
                authenticated: true,
                user: {
                    id: req.session.userId,
                    email: req.session.userEmail,
                    name: req.session.userName,
                    picture: req.session.userPicture,
                },
            });
        } else {
            res.json({ authenticated: false });
        }
    });

    // ── Logout ────────────────────────────────────
    app.post('/auth/logout', (req, res) => {
        req.session.destroy(() => {
            res.json({ success: true });
        });
    });

    // ── Electron auth check (polled after OAuth) ──
    app.get('/auth/electron-check', (req, res) => {
        if (latestAuthUser) {
            const user = latestAuthUser;
            latestAuthUser = null; // Clear after reading
            res.json({ user });
        } else {
            res.json({ user: null });
        }
    });
}

module.exports = {
    createOAuth2Client,
    getAuthenticatedClient,
    requireAuth,
    mountAuthRoutes,
    SCOPES,
};
