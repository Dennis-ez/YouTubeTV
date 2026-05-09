// Suppress the node:sqlite experimental warning — it's stable enough for our use
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const { google } = require('googleapis');
const { DatabaseSync } = require('node:sqlite');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database ───────────────────────────────────────────────────────────────

const dataDir = process.env.DB_DIR || './data';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'ytv.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS watched (
    user_id    TEXT    NOT NULL,
    video_id   TEXT    NOT NULL,
    watched_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, video_id)
  );
  CREATE TABLE IF NOT EXISTS cache (
    key        TEXT    PRIMARY KEY,
    data       TEXT    NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

function cacheGet(key) {
  const row = db.prepare('SELECT data, expires_at FROM cache WHERE key = ?').get(key);
  if (!row || row.expires_at < Date.now()) return null;
  return JSON.parse(row.data);
}

function cacheSet(key, data, ttlMs) {
  db.prepare('INSERT OR REPLACE INTO cache (key, data, expires_at) VALUES (?, ?, ?)')
    .run(key, JSON.stringify(data), Date.now() + ttlMs);
}

// ── OAuth helpers ──────────────────────────────────────────────────────────

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`
  );
}

function getYouTube(tokens) {
  const auth = makeOAuth2Client();
  auth.setCredentials(tokens);
  return { youtube: google.youtube({ version: 'v3', auth }), auth };
}

// ── SQLite session store (survives restarts, works in Safari) ──────────────

const Store = session.Store;
class SQLiteStore extends Store {
  constructor() {
    super();
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid      TEXT    PRIMARY KEY,
        data     TEXT    NOT NULL,
        expires  INTEGER NOT NULL
      );
    `);
    // Prune expired sessions every 15 min
    setInterval(() => {
      db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    }, 15 * 60 * 1000).unref();
  }
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 60 * 60 * 1000;
      db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), exp);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb(null); }
    catch (e) { cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(express.json());
app.use(session({
  store:             new SQLiteStore(),
  secret:            process.env.SESSION_SECRET || 'ytv-dev-secret-change-me',
  resave:            false,
  saveUninitialized: true,   // set cookie on first visit so Safari sees it as first-party
  cookie:            { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax', httpOnly: true },
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  console.log(`[auth] ${req.method} ${req.path} | sid=${req.sessionID?.slice(0,8)} | tokens=${!!req.session.tokens} | userId=${req.session.userId || 'none'}`);
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function syncTokens(req, auth) {
  auth.on('tokens', (t) => { req.session.tokens = { ...req.session.tokens, ...t }; });
}

// ── Auth routes ────────────────────────────────────────────────────────────

app.get('/auth/login', (req, res) => {
  const auth = makeOAuth2Client();
  res.redirect(auth.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  }));
});

app.get('/auth/callback', async (req, res) => {
  if (!req.query.code) return res.redirect('/?error=no_code');
  try {
    const auth = makeOAuth2Client();
    const { tokens } = await auth.getToken(req.query.code);
    auth.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth });
    const { data } = await oauth2.userinfo.get();
    req.session.tokens  = tokens;
    req.session.userId  = data.id;
    req.session.email   = data.email;
    req.session.picture = data.picture;
    console.log(`[callback] saving session sid=${req.sessionID?.slice(0,8)} userId=${data.id}`);
    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      console.log(`[callback] session saved, redirecting`);
      res.redirect('/');
    });
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── API ────────────────────────────────────────────────────────────────────

app.get('/api/me', (req, res) => {
  if (!req.session.tokens) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    email:   req.session.email,
    picture: req.session.picture,
    userId:  req.session.userId,
  });
});

// All subscriptions — cached 1 hour per user
app.get('/api/subscriptions', requireAuth, async (req, res) => {
  const key = `subs:${req.session.userId}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  try {
    const { youtube, auth } = getYouTube(req.session.tokens);
    syncTokens(req, auth);

    const subs = [];
    let pageToken;
    do {
      const r = await youtube.subscriptions.list({
        part: ['snippet'], mine: true, maxResults: 50, pageToken,
      });
      for (const item of r.data.items || []) {
        subs.push({
          id:          item.snippet.resourceId.channelId,
          title:       item.snippet.title,
          thumbnail:   item.snippet.thumbnails?.default?.url || '',
          description: item.snippet.description || '',
        });
      }
      pageToken = r.data.nextPageToken;
    } while (pageToken);

    const result = { subscriptions: subs };
    cacheSet(key, result, 60 * 60 * 1000);
    res.json(result);
  } catch (err) {
    console.error('Subscriptions error:', err.message, err.errors || '');
    // Insufficient scope — user needs to re-authorize with youtube.readonly
    const reason = err.errors?.[0]?.reason;
    if (reason === 'insufficientPermissions' || err.message?.includes('Insufficient Permission')) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: 'reauth_required', detail: 'YouTube permission not granted. Please sign in again.' });
    }
    res.status(500).json({ error: 'Failed to fetch subscriptions', detail: err.message });
  }
});

// Videos for a channel — cached 30 min
app.get('/api/channel/:channelId/videos', requireAuth, async (req, res) => {
  const { channelId } = req.params;
  const key = `videos:${channelId}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  try {
    const { youtube, auth } = getYouTube(req.session.tokens);
    syncTokens(req, auth);

    // 1. Get uploads playlist ID
    const chRes = await youtube.channels.list({
      part: ['contentDetails'], id: [channelId],
    });
    const uploadsId = chRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) return res.json({ videos: [] });

    // 2. Pull recent uploads (max 50 = 1 API unit)
    const plRes = await youtube.playlistItems.list({
      part: ['contentDetails'], playlistId: uploadsId, maxResults: 50,
    });
    const videoIds = (plRes.data.items || [])
      .map(i => i.contentDetails.videoId).filter(Boolean);
    if (!videoIds.length) return res.json({ videos: [] });

    // 3. Get details: embeddable, duration, privacy
    const vRes = await youtube.videos.list({
      part: ['contentDetails', 'status', 'snippet'], id: videoIds,
    });
    const videos = (vRes.data.items || [])
      .filter(v =>
        v.status.embeddable &&
        v.status.privacyStatus === 'public' &&
        (v.snippet.liveBroadcastContent === 'none' || !v.snippet.liveBroadcastContent)
      )
      .map(v => ({
        id:          v.id,
        title:       v.snippet.title,
        channel:     v.snippet.channelTitle,
        thumbnail:   v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
        duration:    parseDuration(v.contentDetails.duration),
        publishedAt: v.snippet.publishedAt,
      }))
      .filter(v => v.duration > 90); // skip Shorts and tiny clips

    const result = { videos };
    cacheSet(key, result, 30 * 60 * 1000);
    res.json(result);
  } catch (err) {
    console.error(`Channel ${channelId} videos error:`, err.message);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

// Watched history
app.get('/api/watched', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT video_id FROM watched WHERE user_id = ?')
    .all(req.session.userId);
  res.json({ watched: rows.map(r => r.video_id) });
});

app.post('/api/watched', requireAuth, (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  db.prepare('INSERT OR REPLACE INTO watched (user_id, video_id, watched_at) VALUES (?, ?, ?)')
    .run(req.session.userId, videoId, Date.now());
  res.json({ ok: true });
});

app.delete('/api/watched', requireAuth, (req, res) => {
  db.prepare('DELETE FROM watched WHERE user_id = ?').run(req.session.userId);
  res.json({ ok: true });
});

// ── Utility ────────────────────────────────────────────────────────────────

function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nYouTube TV  →  http://localhost:${PORT}\n`);
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn('⚠  GOOGLE_CLIENT_ID not set — copy .env.example to .env and fill it in.\n');
  }
});
