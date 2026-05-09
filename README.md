# 📺 YouTube TV

Browse your YouTube subscriptions like TV channels. Every subscription becomes a channel — tune in and a random video starts at a random timestamp, just like real TV.

![YouTube TV Screenshot](https://i.imgur.com/placeholder.png)

## Features

- **Google OAuth** — sign in securely, no credentials stored
- **All your subscriptions** as numbered TV channels (CH 1, CH 2, …)
- **Random start time** — you're always joining mid-broadcast (5–70% into the video)
- **Prefers unwatched videos** — tracks what you've seen so it shows you new content first
- **Static / noise effect** with sound on channel switch
- **Channel Guide** (press `G`) — visual grid of all your channels
- **Keyboard controls**: `←` `→` arrows, number keys to jump directly to a channel
- **Touch/swipe** support for mobile
- **CRT scanlines + vignette** for authentic TV feel
- **Docker** — one command to run

## Quick Start (Local)

### 1. Get Google API credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project → Enable **YouTube Data API v3**
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Add authorised redirect URI: `http://localhost:3000/auth/callback`
6. Copy the **Client ID** and **Client Secret**

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and fill in your GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
```

### 3a. Run with Docker (recommended)

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000)

### 3b. Run locally (Node.js)

```bash
npm install
npm start
```

Requires Node.js 18+.

## Controls

| Key / Action         | Effect                      |
|----------------------|-----------------------------|
| `→` / `↑`           | Next channel                |
| `←` / `↓`           | Previous channel            |
| `0`–`9`             | Type a channel number       |
| `G` / `Enter`       | Open / close channel guide  |
| `M`                  | Toggle mute                 |
| `R`                  | Reset watched history       |
| `Esc`                | Close channel guide         |
| Swipe left/right     | Next / previous channel     |
| Click video          | Unmute (first click)        |

## API Routes

| Route | Description |
|-------|-------------|
| `GET /auth/login` | Start Google OAuth flow |
| `GET /auth/callback` | OAuth callback |
| `POST /auth/logout` | Sign out |
| `GET /api/me` | Current user info |
| `GET /api/subscriptions` | All subscriptions (cached 1h) |
| `GET /api/channel/:id/videos` | Recent videos for a channel (cached 30m) |
| `GET /api/watched` | Watched video IDs |
| `POST /api/watched` | Mark video as watched |
| `DELETE /api/watched` | Clear watched history |

## Architecture

```
youtube-tv/
├── server.js          # Express backend (OAuth, YouTube API, SQLite cache)
├── public/
│   ├── index.html     # Single-page TV UI
│   ├── style.css      # CRT/TV aesthetic styling
│   └── app.js         # Client-side TV logic (YouTube IFrame API)
├── data/              # SQLite DB (gitignored, Docker volume)
├── Dockerfile
└── docker-compose.yml
```

## YouTube API Quota

The app uses efficient API calls (no expensive `search.list`):
- `subscriptions.list` — 1 unit × pages
- `channels.list` — 1 unit per channel
- `playlistItems.list` — 1 unit per channel
- `videos.list` — 1 unit per channel

With 30-min/1-hour caching, daily quota usage stays well within the free 10,000-unit limit.

## Deploying

Update `.env`:
```
GOOGLE_REDIRECT_URI=https://your-domain.com/auth/callback
```

Add `https://your-domain.com/auth/callback` to your Google Cloud OAuth redirect URIs.

Then run `docker compose up -d`.
