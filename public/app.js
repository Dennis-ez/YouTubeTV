// ── YouTube TV ─────────────────────────────────────────────────────────────
'use strict';

const TV = {
  // state
  player:         null,
  playerReady:    false,
  channels:       [],      // all subscriptions
  currentIndex:   -1,
  watchedVideos:  new Set(),
  videoCache:     {},      // channelId → [{id, title, duration, …}]
  currentVideo:   null,
  guideOpen:      false,
  muted:          true,
  audioCtx:       null,

  // timers
  badgeTimer:     null,
  infoTimer:      null,
  numberTimer:    null,
  numberBuffer:   '',

  // ── Boot ──────────────────────────────────────────────────────────────────

  async init() {
    const me = await api('/api/me');
    if (!me.authenticated) { show('login-screen'); return; }

    show('loading-screen');
    setText('loading-msg', 'Loading your channels…');

    try {
      const [{ watched }, { subscriptions }] = await Promise.all([
        api('/api/watched'),
        api('/api/subscriptions'),
      ]);

      this.watchedVideos = new Set(watched);
      this.channels = subscriptions;

      if (!this.channels.length) {
        showError('No subscriptions found. Subscribe to some YouTube channels first!');
        return;
      }

      setText('loading-msg', `Found ${this.channels.length} channels. Tuning in…`);

      // Start the YouTube IFrame player; onYouTubeIframeAPIReady fires it
      // (already in queue if the API loaded before init finished)
      if (window._ytAPIReady) this.createPlayer();

    } catch (err) {
      console.error(err);
      showError('Failed to load channels. Please refresh and try again.');
    }
  },

  createPlayer() {
    this.player = new YT.Player('youtube-player', {
      width:  '100%',
      height: '100%',
      playerVars: {
        autoplay:        1,
        controls:        0,
        disablekb:       1,
        enablejsapi:     1,
        fs:              0,
        iv_load_policy:  3,
        modestbranding:  1,
        playsinline:     1,
        rel:             0,
      },
      events: {
        onReady:       () => this.onPlayerReady(),
        onStateChange: (e) => this.onStateChange(e),
        onError:       (e) => this.onPlayerError(e),
      },
    });
  },

  async onPlayerReady() {
    this.playerReady = true;

    // Must start muted so autoplay is allowed
    this.player.mute();
    this.muted = true;

    hide('loading-screen');
    show('tv');

    // Build guide
    this.buildGuide();
    this.setupControls();

    // Tune to a random starting channel
    this.currentIndex = Math.floor(Math.random() * this.channels.length);
    await this.tuneToChannel(this.currentIndex, { skipStatic: true });

    // Show unmute prompt after a beat
    setTimeout(() => el('unmute-prompt').classList.add('visible'), 800);
  },

  // ── Channel tuning ────────────────────────────────────────────────────────

  async tuneToChannel(index, { skipStatic = false } = {}) {
    index = ((index % this.channels.length) + this.channels.length) % this.channels.length;
    this.currentIndex = index;

    const channel = this.channels[index];
    this.showBadge(index);

    if (!skipStatic) {
      this.playStaticEffect();
    }

    // Fetch videos (cached after first call)
    const videos = await this.getChannelVideos(channel.id);

    if (!videos.length) {
      // No playable videos — silently skip to next
      await this.tuneToChannel(index + 1, { skipStatic: true });
      return;
    }

    // Pick a video: prefer unwatched
    const unwatched = videos.filter(v => !this.watchedVideos.has(v.id));
    const pool  = unwatched.length ? unwatched : videos;
    const video = pool[Math.floor(Math.random() * pool.length)];

    // Random start: between 5 % and 70 % of duration
    const start = randomBetween(
      Math.floor(video.duration * 0.05),
      Math.floor(video.duration * 0.70)
    );

    if (this.playerReady) {
      this.player.loadVideoById({ videoId: video.id, startSeconds: start });
    }

    // Track as watched
    this.watchedVideos.add(video.id);
    api('/api/watched', { method: 'POST', body: { videoId: video.id } });

    this.currentVideo = video;
    this.showInfoBar(channel, video);
    this.updateGuideActive();
  },

  async getChannelVideos(channelId) {
    if (this.videoCache[channelId]) return this.videoCache[channelId];
    try {
      const data = await api(`/api/channel/${channelId}/videos`);
      this.videoCache[channelId] = data.videos || [];
    } catch {
      this.videoCache[channelId] = [];
    }
    return this.videoCache[channelId];
  },

  nextChannel() { this.tuneToChannel(this.currentIndex + 1); },
  prevChannel() { this.tuneToChannel(this.currentIndex - 1); },

  // ── Player events ─────────────────────────────────────────────────────────

  onStateChange(e) {
    // When current video ends, pick another on the same channel
    if (e.data === YT.PlayerState.ENDED) {
      this.tuneToChannel(this.currentIndex);
    }
  },

  onPlayerError(e) {
    // Unplayable video: load another on same channel
    console.warn('Player error', e.data, '— loading next video on channel');
    if (this.currentVideo) {
      // Mark as "watched" so it won't be picked again immediately
      this.watchedVideos.add(this.currentVideo.id);
    }
    this.tuneToChannel(this.currentIndex);
  },

  // ── UI helpers ────────────────────────────────────────────────────────────

  showBadge(index) {
    const ch = this.channels[index];
    setText('badge-number', `CH ${index + 1}`);
    setText('badge-name', ch.title);
    el('channel-badge').classList.add('visible');
    clearTimeout(this.badgeTimer);
    this.badgeTimer = setTimeout(() => el('channel-badge').classList.remove('visible'), 3500);
  },

  showInfoBar(channel, video) {
    el('info-thumb').src     = video.thumbnail || channel.thumbnail || '';
    setText('info-channel', channel.title);
    setText('info-title', video.title);

    const bar  = el('info-bar');
    const hint = el('controls-hint');
    bar.classList.add('visible');
    hint.classList.add('visible');

    clearTimeout(this.infoTimer);
    this.infoTimer = setTimeout(() => {
      bar.classList.remove('visible');
      hint.classList.remove('visible');
    }, 5000);
  },

  // ── Static / noise effect ─────────────────────────────────────────────────

  playStaticEffect() {
    const canvas = el('static-canvas');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.display  = 'block';
    canvas.style.opacity  = '1';
    canvas.style.transition = '';

    const ctx    = canvas.getContext('2d');
    // Draw at 1/4 resolution and scale — looks more like TV static
    const W = Math.ceil(canvas.width  / 4);
    const H = Math.ceil(canvas.height / 4);
    const imgData = ctx.createImageData(W, H);

    let frame  = 0;
    const maxFrames = 18; // ~300 ms at 60 fps

    const draw = () => {
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (Math.random() * 255) | 0;
        d[i] = v; d[i+1] = v; d[i+2] = v; d[i+3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
      ctx.drawImage(canvas, 0, 0, W, H, 0, 0, canvas.width, canvas.height);

      if (++frame < maxFrames) {
        requestAnimationFrame(draw);
      } else {
        canvas.style.transition = 'opacity 0.25s';
        canvas.style.opacity = '0';
        setTimeout(() => { canvas.style.display = 'none'; }, 300);
      }
    };
    requestAnimationFrame(draw);

    this.playStaticSound();
  },

  playStaticSound() {
    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx    = this.audioCtx;
      const dur    = 0.3;
      const rate   = ctx.sampleRate;
      const buf    = ctx.createBuffer(1, rate * dur, rate);
      const data   = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      const src  = ctx.createBufferSource();
      src.buffer = buf;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);

      src.connect(gain); gain.connect(ctx.destination);
      src.start();
    } catch { /* audio not available */ }
  },

  // ── Mute toggle ───────────────────────────────────────────────────────────

  toggleMute() {
    if (!this.playerReady) return;
    if (this.muted) {
      this.player.unMute();
      this.player.setVolume(80);
      this.muted = false;
      el('unmute-prompt').classList.remove('visible');
    } else {
      this.player.mute();
      this.muted = true;
    }
  },

  unmuteOnFirstInteraction() {
    if (this.muted) this.toggleMute();
    el('unmute-prompt').classList.remove('visible');
  },

  // ── Channel Guide ─────────────────────────────────────────────────────────

  buildGuide() {
    const grid = el('guide-grid');
    grid.innerHTML = '';
    this.channels.forEach((ch, i) => {
      const card = document.createElement('div');
      card.className = 'guide-card';
      card.dataset.index = i;
      card.innerHTML = `
        <div class="guide-card-top">
          <img class="guide-thumb" src="${ch.thumbnail}" alt="" onerror="this.style.display='none'">
          <div>
            <div class="guide-ch-num">CH ${i + 1}</div>
            <div class="guide-ch-name">${escHtml(ch.title)}</div>
          </div>
        </div>
        <div class="guide-now-playing" data-ch="${ch.id}">Loading…</div>
      `;
      card.addEventListener('click', () => {
        this.closeGuide();
        this.tuneToChannel(i);
      });
      grid.appendChild(card);
    });

    // Populate now-playing lazily when guide opens
  },

  openGuide() {
    if (this.guideOpen) return;
    this.guideOpen = true;
    el('guide-overlay').classList.add('open');
    this.updateGuideActive();
    this.populateGuideNowPlaying();
    // Scroll active card into view
    const active = el('guide-grid').querySelector('.guide-card.active');
    if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },

  closeGuide() {
    if (!this.guideOpen) return;
    this.guideOpen = false;
    el('guide-overlay').classList.remove('open');
  },

  toggleGuide() {
    this.guideOpen ? this.closeGuide() : this.openGuide();
  },

  updateGuideActive() {
    el('guide-grid').querySelectorAll('.guide-card').forEach((card, i) => {
      card.classList.toggle('active', i === this.currentIndex);
    });
  },

  populateGuideNowPlaying() {
    el('guide-grid').querySelectorAll('.guide-card').forEach((card, i) => {
      const ch = this.channels[i];
      const label = card.querySelector('.guide-now-playing');
      const cached = this.videoCache[ch.id];
      if (cached && cached.length) {
        const unwatched = cached.filter(v => !this.watchedVideos.has(v.id));
        const v = (unwatched.length ? unwatched : cached)[0];
        label.textContent = v.title;
        label.classList.remove('live');
      } else if (cached) {
        label.textContent = 'No videos available';
        label.classList.remove('live');
      } else {
        label.textContent = 'Loading…';
        // Prefetch asynchronously
        this.getChannelVideos(ch.id).then(() => {
          if (this.guideOpen) this.populateGuideNowPlaying();
        });
      }
    });

    // Show current video for current channel
    if (this.currentVideo && this.currentIndex >= 0) {
      const card  = el('guide-grid').querySelectorAll('.guide-card')[this.currentIndex];
      if (card) {
        const label = card.querySelector('.guide-now-playing');
        label.textContent = '▶ ' + this.currentVideo.title;
        label.classList.add('live');
      }
    }
  },

  // ── Number channel input ──────────────────────────────────────────────────

  handleNumberKey(digit) {
    this.numberBuffer += digit;
    const disp = el('number-input-display');
    disp.textContent = this.numberBuffer;
    disp.classList.add('visible');

    clearTimeout(this.numberTimer);
    this.numberTimer = setTimeout(() => {
      const num = parseInt(this.numberBuffer, 10);
      this.numberBuffer = '';
      disp.classList.remove('visible');
      if (num >= 1 && num <= this.channels.length) {
        this.tuneToChannel(num - 1);
      }
    }, 1500);
  },

  // ── Keyboard + click controls ─────────────────────────────────────────────

  setupControls() {
    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          e.preventDefault(); this.nextChannel(); break;
        case 'ArrowLeft':
        case 'ArrowDown':
          e.preventDefault(); this.prevChannel(); break;
        case 'g': case 'G': case 'Enter':
          e.preventDefault(); this.toggleGuide(); break;
        case 'm': case 'M':
          e.preventDefault(); this.toggleMute(); break;
        case 'Escape':
          this.closeGuide(); break;
        case 'r': case 'R':
          this.resetWatched(); break;
        default:
          if (/^[0-9]$/.test(e.key)) this.handleNumberKey(e.key);
      }
    });

    // Click on shield = unmute on first click, subsequent clicks show info
    el('player-shield').addEventListener('click', () => {
      if (this.muted) { this.unmuteOnFirstInteraction(); return; }
      // Toggle info bar visibility
      el('info-bar').classList.toggle('visible');
      el('controls-hint').classList.toggle('visible');
    });

    el('unmute-prompt').addEventListener('click', () => this.toggleMute());
    el('btn-next').addEventListener('click', () => this.nextChannel());
    el('btn-prev').addEventListener('click', () => this.prevChannel());
    el('guide-close').addEventListener('click', () => this.closeGuide());

    // Swipe support (touch)
    let touchStartX = 0, touchStartY = 0;
    document.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
        dx < 0 ? this.nextChannel() : this.prevChannel();
      }
    }, { passive: true });

    // Preload adjacent channels in the background
    setInterval(() => this.preloadAdjacent(), 8000);
  },

  preloadAdjacent() {
    const len = this.channels.length;
    [-2, -1, 1, 2].forEach(offset => {
      const idx = ((this.currentIndex + offset) % len + len) % len;
      const id  = this.channels[idx]?.id;
      if (id && !this.videoCache[id]) this.getChannelVideos(id);
    });
  },

  async resetWatched() {
    await api('/api/watched', { method: 'DELETE' });
    this.watchedVideos.clear();
    this.showBadge(this.currentIndex); // brief flash confirmation
    console.log('Watched history cleared.');
  },
};

// ── YouTube IFrame API ready callback ───────────────────────────────────────

window._ytAPIReady = false;
window.onYouTubeIframeAPIReady = () => {
  window._ytAPIReady = true;
  if (TV.channels.length) TV.createPlayer(); // already loaded
};

// ── Tiny utilities ──────────────────────────────────────────────────────────

function el(id)        { return document.getElementById(id); }
function setText(id,t) { el(id).textContent = t; }
function show(id)      { el(id).style.display = 'flex'; }
function hide(id)      { el(id).style.display = 'none'; }
function escHtml(s)    { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function randomBetween(a, b) { return a + Math.floor(Math.random() * Math.max(1, b - a)); }

function showError(msg) {
  hide('loading-screen');
  el('error-msg').textContent = msg;
  el('error-screen').style.display = 'flex';
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method:  opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body:    opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/'; throw new Error('Unauthenticated'); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

TV.init();
