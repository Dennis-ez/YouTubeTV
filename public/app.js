// ── YouTube TV ─────────────────────────────────────────────────────────────
'use strict';

var TV = {
  // state
  player:        null,
  playerReady:   false,
  channels:      [],
  currentIndex:  -1,
  watchedVideos: new Set(),
  videoCache:    {},
  currentVideo:  null,
  guideOpen:     false,
  muted:         true,

  // Each channel keeps a persistent "broadcast" that runs even while you're away.
  // Structure: { videoIndex, videoStartSec, broadcastStartMs }
  broadcasts:    {},

  // timers
  badgeTimer:        null,
  infoTimer:         null,
  numberTimer:       null,
  _guideRefreshTimer: null,
  _sleepTimer:       null,
  _sleepOptions:     [0, 30, 60, 90],
  _sleepIndex:       0,
  _speedOptions:     [1, 1.25, 1.5, 0.75],
  _speedIndex:       0,
  _channelHistory:   [],
  _historyNav:       false,
  _backToLiveTimer:  null,
  _volFeedbackTimer: null,
  shortcutsOpen:     false,
  numberBuffer:  '',
  _tuneSeq:      0,

  // ── Boot ────────────────────────────────────────────────────────────────

  init: async function() {
    this.loadSettings();
    var me = await api('/api/me');
    if (!me.authenticated) { show('login-screen'); return; }

    show('loading-screen');
    setText('loading-msg', 'Loading your channels…');

    try {
      var watchedData = await api('/api/watched');
      var subsData    = await api('/api/subscriptions');

      this.watchedVideos = new Set(watchedData.watched);
      this.channels      = subsData.subscriptions;

      if (!this.channels.length) {
        showError('No subscriptions found. Subscribe to some YouTube channels first!');
        return;
      }

      setText('loading-msg', 'Found ' + this.channels.length + ' channels. Tuning in…');

      if (window._ytAPIReady) this.createPlayer();

    } catch (err) {
      console.error(err);
      var msg = err.detail || err.message || 'Unknown error';
      showError('Failed to load channels: ' + msg + '\n\nRefresh to try again.');
    }
  },

  createPlayer: function() {
    this.player = new YT.Player('youtube-player', {
      width:  '100%',
      height: '100%',
      playerVars: {
        autoplay:       1,
        controls:       0,
        disablekb:      1,
        enablejsapi:    1,
        fs:             0,
        iv_load_policy: 3,
        modestbranding: 1,
        playsinline:    1,
        rel:            0,
      },
      events: {
        onReady:       function(e) { TV.onPlayerReady(); },
        onStateChange: function(e) { TV.onStateChange(e); },
        onError:       function(e) { TV.onPlayerError(e); },
      },
    });
  },

  onPlayerReady: async function() {
    this.playerReady = true;
    this.player.mute();
    this.muted = true;

    hide('loading-screen');
    show('tv');

    this.buildGuide();
    this.setupControls();
    this.syncSettingsUI();
    this.initPip();

    // Restore saved volume and speed
    var savedVol = parseInt(lsGet('ytv_volume', '80'), 10);
    el('ctrl-volume-slider').value = savedVol;
    this.player.setVolume(savedVol);
    if (this._speedIndex > 0) this.player.setPlaybackRate(this._speedOptions[this._speedIndex]);

    // Restore last channel or start on a random one
    var savedCh = parseInt(lsGet('ytv_lastCh', '-1'), 10);
    this.currentIndex = (savedCh >= 0 && savedCh < this.channels.length)
      ? savedCh : Math.floor(Math.random() * this.channels.length);
    await this.tuneToChannel(this.currentIndex, true);

    var self = this;
    setTimeout(function() { el('unmute-prompt').classList.add('visible'); }, 800);
  },

  // ── Broadcast engine ────────────────────────────────────────────────────
  //
  // Every channel has a persistent "broadcast" that keeps running even while
  // you're watching something else.  On first visit we pick a starting video
  // (preferring unwatched) and a random position inside it.  On every
  // subsequent visit we calculate where the broadcast would be RIGHT NOW,
  // advancing through videos as they finish.  This gives the authentic TV
  // feel: you always join mid-stream, and if enough time has passed you'll
  // catch a brand-new video you haven't seen yet.

  initBroadcast: function(channelId, videos) {
    if (this.broadcasts[channelId]) return;   // already initialised

    // Prefer an unwatched video as the starting point
    var unwatched = videos.filter(function(v) { return !TV.watchedVideos.has(v.id); });
    var pool      = unwatched.length ? unwatched : videos;
    var startVid  = pool[Math.floor(Math.random() * pool.length)];
    var startIdx  = 0;
    for (var k = 0; k < videos.length; k++) {
      if (videos[k].id === startVid.id) { startIdx = k; break; }
    }

    // Random entry point: 5 – 70 % into the video (like joining a broadcast late)
    var min = Math.floor(startVid.duration * 0.05);
    var max = Math.floor(startVid.duration * 0.70);
    var sec = min + Math.floor(Math.random() * Math.max(1, max - min));

    this.broadcasts[channelId] = {
      videoIndex:      startIdx,
      videoStartSec:   sec,
      broadcastStartMs: Date.now(),
    };
  },

  // Returns { video, position } representing where the channel is right now.
  getBroadcastNow: function(channelId, videos) {
    var b       = this.broadcasts[channelId];
    var elapsed = (Date.now() - b.broadcastStartMs) / 1000;   // seconds since we pinned it
    var pos     = b.videoStartSec + elapsed;
    var idx     = b.videoIndex;

    // Advance through the video list as videos finish
    var laps = 0;
    while (pos >= videos[idx].duration && laps < videos.length) {
      pos  -= videos[idx].duration;
      idx   = (idx + 1) % videos.length;
      laps++;
    }

    // Safety: if somehow we looped the entire list, start the pinned video over
    if (laps >= videos.length) { idx = b.videoIndex; pos = 0; }

    return { video: videos[idx], position: Math.floor(Math.max(0, pos)) };
  },

  // ── Channel tuning ──────────────────────────────────────────────────────

  // dir: +1 = forward, -1 = backward (controls which way we skip empty channels)
  tuneToChannel: async function(index, skipStatic, dir) {
    var n = this.channels.length;
    dir   = (dir !== undefined) ? dir : 1;
    index = ((index % n) + n) % n;

    // Cancellation token — rapid clicks cancel stale fetches
    this._tuneSeq += 1;
    var seq = this._tuneSeq;

    if (!skipStatic) this.playStaticEffect();

    // Walk in dir until we find a channel with playable videos
    var tried  = 0;
    var i      = index;
    var videos = [];

    while (tried < n) {
      videos = await this.getChannelVideos(this.channels[i].id);
      if (seq !== this._tuneSeq) return;   // cancelled — newer tune in progress
      if (videos.length) break;
      i = ((i + dir) % n + n) % n;
      tried++;
    }

    if (!videos.length) { showError('No playable videos found in any channel.'); return; }

    // Commit — push old channel to history before overwriting currentIndex
    if (!this._historyNav && this.currentIndex >= 0 && this.currentIndex !== i) {
      this._channelHistory.push(this.currentIndex);
      if (this._channelHistory.length > 20) this._channelHistory.shift();
    }
    this._historyNav = false;
    this.currentIndex = i;
    lsSet('ytv_lastCh', i);

    var channelId = this.channels[i].id;

    // Initialise broadcast state on first visit; subsequent visits just
    // calculate the current position from elapsed wall-clock time.
    this.initBroadcast(channelId, videos);
    var now = this.getBroadcastNow(channelId, videos);

    // Persist broadcast state so position survives page reload
    try { localStorage.setItem('ytv_broadcasts', JSON.stringify(this.broadcasts)); } catch(e) {}

    this.showBadge(i, now.video);

    if (this.playerReady) {
      this.player.loadVideoById({ videoId: now.video.id, startSeconds: now.position });
    }

    // Mark as watched so it won't be picked as a fresh start on another channel
    if (!this.watchedVideos.has(now.video.id)) {
      this.watchedVideos.add(now.video.id);
      api('/api/watched', { method: 'POST', body: { videoId: now.video.id } });
    }

    this.currentVideo = now.video;
    this.showInfoBar(this.channels[i], now.video);
    this.updateGuideActive();

    // Re-apply captions state after video load
    var self = this;
    setTimeout(function() {
      if (self.captionsOn && self.playerReady) {
        self.player.loadModule('captions');
        self.player.setOption('captions', 'track', { languageCode: 'en' });
      } else if (self.playerReady) {
        self.player.unloadModule('captions');
      }
    }, 1500);
  },

  getChannelVideos: async function(channelId) {
    if (this.videoCache[channelId]) return this.videoCache[channelId];
    try {
      var data = await api('/api/channel/' + channelId + '/videos');
      this.videoCache[channelId] = data.videos || [];
    } catch (e) {
      this.videoCache[channelId] = [];
    }
    return this.videoCache[channelId];
  },

  nextChannel: function() { this.tuneToChannel(this.currentIndex + 1, false,  1); },
  prevChannel: function() { this.tuneToChannel(this.currentIndex - 1, false, -1); },

  // ── Player events ────────────────────────────────────────────────────────

  onStateChange: function(e) {
    if (e.data === YT.PlayerState.ENDED) {
      // Re-tune to same channel — getBroadcastNow will have advanced past the
      // finished video because elapsed time now exceeds its duration.
      this.tuneToChannel(this.currentIndex, true, 1);
    }
  },

  onPlayerError: function(e) {
    console.warn('Player error', e.data, '-- skipping');
    // Nudge the broadcast clock forward so this broken video is skipped next visit too
    var ch = this.channels[this.currentIndex];
    if (ch && this.broadcasts[ch.id] && this.currentVideo) {
      var b = this.broadcasts[ch.id];
      var elapsed = (Date.now() - b.broadcastStartMs) / 1000;
      // Advance past the current video by pretending it was longer than it was
      b.videoStartSec   = 0;
      b.videoIndex      = (b.videoIndex + 1) % (this.videoCache[ch.id] || [1]).length;
      b.broadcastStartMs = Date.now();
    }
    this.tuneToChannel(this.currentIndex, true, 1);
  },

  // ── UI helpers ───────────────────────────────────────────────────────────

  showBadge: function(index, video) {
    var ch = this.channels[index];
    setText('badge-number', 'CH ' + (index + 1));
    setText('badge-name', ch.title);
    setText('badge-title', video ? video.title : '');
    el('channel-badge').classList.add('visible');
    clearTimeout(this.badgeTimer);
    this.badgeTimer = setTimeout(function() {
      el('channel-badge').classList.remove('visible');
    }, 3500);
  },

  showInfoBar: function(channel, video) {
    // Update controls bar info
    setText('ctrl-ch-label', 'CH ' + (this.currentIndex + 1) + ' · ' + channel.title);
    setText('ctrl-title-label', video.title);
  },

  // ── Static / noise effect ────────────────────────────────────────────────

  playStaticEffect: function() {
    if (!this.staticOn) return;
    var canvas  = el('static-canvas');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.display    = 'block';
    canvas.style.opacity    = '1';
    canvas.style.transition = '';

    var ctx  = canvas.getContext('2d');
    var W    = Math.ceil(canvas.width  / 4);
    var H    = Math.ceil(canvas.height / 4);
    var img  = ctx.createImageData(W, H);
    var frame = 0;
    var maxF  = 18;

    function draw() {
      var d = img.data;
      for (var i = 0; i < d.length; i += 4) {
        var v = (Math.random() * 255) | 0;
        d[i] = v; d[i+1] = v; d[i+2] = v; d[i+3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      ctx.drawImage(canvas, 0, 0, W, H, 0, 0, canvas.width, canvas.height);
      if (++frame < maxF) {
        requestAnimationFrame(draw);
      } else {
        canvas.style.transition = 'opacity 0.25s';
        canvas.style.opacity = '0';
        setTimeout(function() { canvas.style.display = 'none'; }, 300);
      }
    }
    requestAnimationFrame(draw);
  },

  // ── Channel Guide ────────────────────────────────────────────────────────

  buildGuide: function() {
    var grid = el('guide-grid');
    grid.innerHTML = '';
    grid.classList.toggle('list-layout', !this.guideIsGrid);
    for (var i = 0; i < this.channels.length; i++) {
      var ch   = this.channels[i];
      var card = document.createElement('div');
      card.className    = 'guide-card';
      card.dataset.index = i;
      card.innerHTML =
        '<div class="guide-card-top">' +
          '<img class="guide-thumb" src="' + escHtml(ch.thumbnail) + '" alt="" onerror="this.style.display=\'none\'">' +
          '<div>' +
            '<div class="guide-ch-num">CH ' + (i + 1) + '</div>' +
            '<div class="guide-ch-name">' + escHtml(ch.title) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="guide-now-playing" data-ch="' + escHtml(ch.id) + '">Loading…</div>' +
        '<div class="guide-progress"><div class="guide-progress-fill"></div></div>';

      (function(idx) {
        card.addEventListener('click', function() {
          TV.closeGuide();
          TV.tuneToChannel(idx);
        });
      })(i);

      grid.appendChild(card);
    }
  },

  openGuide: function() {
    if (this.guideOpen) return;
    this.guideOpen = true;
    el('guide-overlay').classList.add('open');
    this.updateGuideActive();
    this.populateGuideNowPlaying();
    var active = el('guide-grid').querySelector('.guide-card.active');
    if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    var self = this;
    this._guideRefreshTimer = setInterval(function() { self.populateGuideNowPlaying(); }, 30000);
  },

  closeGuide: function() {
    if (!this.guideOpen) return;
    this.guideOpen = false;
    el('guide-overlay').classList.remove('open');
    clearInterval(this._guideRefreshTimer);
    el('guide-search').value = '';
    var cards = el('guide-grid').querySelectorAll('.guide-card');
    for (var i = 0; i < cards.length; i++) cards[i].style.display = '';
  },

  toggleGuide: function() { this.guideOpen ? this.closeGuide() : this.openGuide(); },

  updateGuideActive: function() {
    var cards = el('guide-grid').querySelectorAll('.guide-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle('active', i === this.currentIndex);
    }
  },

  populateGuideNowPlaying: function() {
    var cards = el('guide-grid').querySelectorAll('.guide-card');
    for (var i = 0; i < cards.length; i++) {
      var ch     = this.channels[i];
      var label  = cards[i].querySelector('.guide-now-playing');
      var fill   = cards[i].querySelector('.guide-progress-fill');
      var cached = this.videoCache[ch.id];
      var pct    = 0;

      label.classList.remove('live', 'on-air');

      if (i === this.currentIndex && this.currentVideo) {
        label.textContent = '▶ ' + this.currentVideo.title;
        label.classList.add('live');
        if (this.playerReady && this.player.getDuration) {
          var dur = this.player.getDuration() || 0;
          var cur = this.player.getCurrentTime ? this.player.getCurrentTime() : 0;
          pct = dur ? (cur / dur) * 100 : 0;
        }
      } else if (cached && cached.length && this.broadcasts[ch.id]) {
        var now = this.getBroadcastNow(ch.id, cached);
        label.textContent = '▶ ' + now.video.title;
        label.classList.add('on-air');
        pct = now.video.duration ? (now.position / now.video.duration) * 100 : 0;
      } else if (cached && cached.length) {
        var unwatched = cached.filter(function(v) { return !TV.watchedVideos.has(v.id); });
        var v = (unwatched.length ? unwatched : cached)[0];
        label.textContent = v.title;
      } else if (cached) {
        label.textContent = 'No videos available';
      } else {
        label.textContent = 'Loading…';
        this.getChannelVideos(ch.id).then(function() {
          if (TV.guideOpen) TV.populateGuideNowPlaying();
        });
      }

      if (fill) fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
    }
  },

  // ── Number input ──────────────────────────────────────────────────────────

  handleNumberKey: function(digit) {
    this.numberBuffer += digit;
    var disp = el('number-input-display');
    disp.textContent = this.numberBuffer;
    disp.classList.add('visible');
    clearTimeout(this.numberTimer);
    var self = this;
    this.numberTimer = setTimeout(function() {
      var num = parseInt(self.numberBuffer, 10);
      self.numberBuffer = '';
      disp.classList.remove('visible');
      if (num >= 1 && num <= self.channels.length) self.tuneToChannel(num - 1);
    }, 1500);
  },

  // ── Seek bar + time display ───────────────────────────────────────────────

  startSeekPoller: function() {
    var self = this;
    setInterval(function() {
      if (!self.playerReady || !self.player.getDuration) return;
      var dur = self.player.getDuration() || 0;
      var cur = self.player.getCurrentTime() || 0;
      if (!dur) return;
      var pct = (cur / dur) * 100;
      el('ctrl-seek-fill').style.width  = pct + '%';
      el('ctrl-seek-thumb').style.left  = pct + '%';
      setText('ctrl-current-time', fmtTime(cur));
      setText('ctrl-duration',     fmtTime(dur));
    }, 500);
  },

  initSeekBar: function() {
    var self = this;
    var track = el('ctrl-seek-track');
    var seeking = false;

    function seek(e) {
      var rect = track.getBoundingClientRect();
      var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      var dur  = self.player.getDuration() || 0;
      if (dur) self.player.seekTo(pct * dur, true);
    }

    track.addEventListener('mousedown', function(e) { seeking = true; seek(e); e.stopPropagation(); TV.showBackToLive(); });
    document.addEventListener('mousemove', function(e) { if (seeking) seek(e); });
    document.addEventListener('mouseup',   function()  { seeking = false; });
    track.addEventListener('click', function(e) { seek(e); e.stopPropagation(); TV.showBackToLive(); });
  },

  // ── Options: scanlines / vignette / guide layout ─────────────────────────

  staticOn:     true,
  scanlinesOn:  true,
  vignetteOn:   true,
  guideIsGrid:  true,
  settingsOpen: false,

  toggleStatic: function() {
    this.staticOn = !this.staticOn;
    lsSet('ytv_static', this.staticOn);
    var btn = el('opt-static');
    btn.textContent = this.staticOn ? 'ON' : 'OFF';
    btn.classList.toggle('active', this.staticOn);
  },

  toggleScanlines: function() {
    this.scanlinesOn = !this.scanlinesOn;
    lsSet('ytv_scanlines', this.scanlinesOn);
    el('scanlines').classList.toggle('off', !this.scanlinesOn);
    var btn = el('opt-scanlines');
    btn.textContent = this.scanlinesOn ? 'ON' : 'OFF';
    btn.classList.toggle('active', this.scanlinesOn);
  },

  toggleVignette: function() {
    this.vignetteOn = !this.vignetteOn;
    lsSet('ytv_vignette', this.vignetteOn);
    el('vignette').classList.toggle('off', !this.vignetteOn);
    var btn = el('opt-vignette');
    btn.textContent = this.vignetteOn ? 'ON' : 'OFF';
    btn.classList.toggle('active', this.vignetteOn);
  },

  toggleGuideLayout: function() {
    this.guideIsGrid = !this.guideIsGrid;
    lsSet('ytv_guide_layout', this.guideIsGrid ? 'grid' : 'list');
    el('guide-grid').classList.toggle('list-layout', !this.guideIsGrid);
    var btn = el('opt-guide-layout');
    btn.textContent = this.guideIsGrid ? 'Grid' : 'List';
  },

  toggleSettings: function() {
    this.settingsOpen = !this.settingsOpen;
    el('settings-panel').classList.toggle('open', this.settingsOpen);
    el('ctrl-settings-btn').classList.toggle('active', this.settingsOpen);
  },

  closeSettings: function() {
    if (!this.settingsOpen) return;
    this.settingsOpen = false;
    el('settings-panel').classList.remove('open');
    el('ctrl-settings-btn').classList.remove('active');
  },

  // ── Captions ─────────────────────────────────────────────────────────────

  captionsOn: false,

  toggleCaptions: function() {
    if (!this.playerReady) return;
    this.captionsOn = !this.captionsOn;
    if (this.captionsOn) {
      this.player.loadModule('captions');
      this.player.setOption('captions', 'track', { languageCode: 'en' });
    } else {
      this.player.unloadModule('captions');
    }
    el('ctrl-cc-btn').classList.toggle('active', this.captionsOn);
  },

  // ── Shuffle / skip ────────────────────────────────────────────────────────

  // Shuffle: pick a random video on this channel and reset its broadcast
  shuffleChannel: function() {
    var ch = this.channels[this.currentIndex];
    if (!ch) return;
    var videos = this.videoCache[ch.id];
    if (!videos || !videos.length) return;

    // Delete broadcast state so initBroadcast picks a fresh random video
    delete this.broadcasts[ch.id];
    this.tuneToChannel(this.currentIndex, false, 1);
  },

  // Skip: advance the broadcast to the next video immediately
  skipVideo: function() {
    var ch = this.channels[this.currentIndex];
    if (!ch) return;
    var videos = this.videoCache[ch.id];
    if (!videos || !videos.length) return;
    var b = this.broadcasts[ch.id];
    if (!b) { this.tuneToChannel(this.currentIndex, false, 1); return; }

    // Move to start of next video
    b.videoIndex      = (b.videoIndex + 1) % videos.length;
    b.videoStartSec   = 0;
    b.broadcastStartMs = Date.now();
    this.tuneToChannel(this.currentIndex, false, 1);
  },

  // ── Fullscreen ────────────────────────────────────────────────────────────

  toggleFullscreen: function() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen && document.exitFullscreen();
    }
  },

  // ── Controls bar auto-hide ────────────────────────────────────────────────

  _ctrlHideTimer: null,

  showControls: function() {
    el('controls-bar').classList.add('visible');
    document.body.classList.remove('cursor-hidden');
    clearTimeout(this._ctrlHideTimer);
    var self = this;
    this._ctrlHideTimer = setTimeout(function() {
      if (!self.settingsOpen && !self.guideOpen && !self.shortcutsOpen) {
        el('controls-bar').classList.remove('visible');
        document.body.classList.add('cursor-hidden');
      }
    }, 3000);
  },

  // ── Mute ─────────────────────────────────────────────────────────────────

  toggleMute: function() {
    if (!this.playerReady) return;
    if (this.muted) {
      this.player.unMute();
      this.player.setVolume(parseInt(el('ctrl-volume-slider').value, 10));
      this.muted = false;
      el('unmute-prompt').classList.remove('visible');
      el('icon-vol-on').style.display  = '';
      el('icon-vol-off').style.display = 'none';
    } else {
      this.player.mute();
      this.muted = true;
      el('icon-vol-on').style.display  = 'none';
      el('icon-vol-off').style.display = '';
    }
  },

  // ── Controls setup ────────────────────────────────────────────────────────

  setupControls: function() {
    var self = this;

    // Auto-show controls on mouse move / key press; track cursor ring position
    document.addEventListener('mousemove', function(e) {
      self.showControls();
      var ring = el('cursor-ring');
      ring.style.left = e.clientX + 'px';
      ring.style.top  = e.clientY + 'px';
    });
    document.addEventListener('keydown', function() { self.showControls(); });

    // Keyboard
    document.addEventListener('keydown', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'RANGE') return;
      switch (e.key) {
        case 'ArrowRight': case 'ArrowUp':
          e.preventDefault(); self.nextChannel(); break;
        case 'ArrowLeft': case 'ArrowDown':
          e.preventDefault(); self.prevChannel(); break;
        case 'g': case 'G':
          e.preventDefault(); self.toggleGuide(); break;
        case 'm': case 'M':
          e.preventDefault(); self.toggleMute(); break;
        case 'f': case 'F':
          e.preventDefault(); self.toggleFullscreen(); break;
        case 'p': case 'P':
          e.preventDefault(); self.togglePip(); break;
        case '[':
          e.preventDefault(); self.adjustVolume(-10); break;
        case ']':
          e.preventDefault(); self.adjustVolume(10); break;
        case 'Backspace':
          e.preventDefault(); self.goBack(); break;
        case 's': case 'S':
          e.preventDefault(); self.shuffleChannel(); break;
        case 'n': case 'N':
          e.preventDefault(); self.skipVideo(); break;
        case 'c': case 'C':
          e.preventDefault(); self.toggleCaptions(); break;
        case '?':
          e.preventDefault(); self.toggleShortcuts(); break;
        case 'Escape':
          self.closeGuide(); self.closeSettings(); self.closeShortcuts(); break;
        default:
          if (/^[0-9]$/.test(e.key)) self.handleNumberKey(e.key);
      }
    });

    // Click shield: unmute first, then close settings; double-click = fullscreen
    el('player-shield').addEventListener('click', function() {
      if (self.muted) { self.toggleMute(); return; }
      self.closeSettings();
    });
    el('player-shield').addEventListener('dblclick', function() {
      self.toggleFullscreen();
    });

    // Controls bar buttons
    el('unmute-prompt').addEventListener('click', function() { self.toggleMute(); });
    el('btn-next').addEventListener('click',      function() { self.nextChannel(); });
    el('btn-prev').addEventListener('click',      function() { self.prevChannel(); });
    el('ctrl-ch-next').addEventListener('click',  function() { self.nextChannel(); });
    el('ctrl-ch-prev').addEventListener('click',  function() { self.prevChannel(); });
    el('ctrl-mute-btn').addEventListener('click', function() { self.toggleMute(); });
    el('ctrl-shuffle-btn').addEventListener('click', function() { self.shuffleChannel(); });
    el('ctrl-skip-btn').addEventListener('click', function() { self.skipVideo(); });
    el('ctrl-cc-btn').addEventListener('click',   function() { self.toggleCaptions(); });
    el('ctrl-settings-btn').addEventListener('click', function(e) {
      e.stopPropagation(); self.toggleSettings();
    });
    el('ctrl-fullscreen-btn').addEventListener('click', function() { self.toggleFullscreen(); });
    el('ctrl-pip-btn').addEventListener('click',        function() { self.togglePip(); });
    el('guide-close').addEventListener('click',         function() { self.closeGuide(); });
    el('shortcuts-close').addEventListener('click',     function() { self.closeShortcuts(); });
    el('shortcuts-overlay').addEventListener('click',   function(e) { if (e.target === el('shortcuts-overlay')) self.closeShortcuts(); });

    // Volume slider
    el('ctrl-volume-slider').addEventListener('input', function() {
      if (!self.playerReady) return;
      var vol = parseInt(this.value, 10);
      lsSet('ytv_volume', vol);
      self.player.setVolume(vol);
      if (vol === 0) {
        self.player.mute(); self.muted = true;
        el('icon-vol-on').style.display  = 'none';
        el('icon-vol-off').style.display = '';
      } else if (self.muted) {
        self.player.unMute(); self.muted = false;
        el('unmute-prompt').classList.remove('visible');
        el('icon-vol-on').style.display  = '';
        el('icon-vol-off').style.display = 'none';
      }
    });

    // Settings panel options
    el('opt-static').addEventListener('click',       function() { self.toggleStatic(); });
    el('opt-scanlines').addEventListener('click',    function() { self.toggleScanlines(); });
    el('opt-vignette').addEventListener('click',     function() { self.toggleVignette(); });
    el('opt-guide-layout').addEventListener('click', function() { self.toggleGuideLayout(); });
    el('opt-sleep-timer').addEventListener('click',    function() { self.toggleSleepTimer(); });
    el('opt-speed').addEventListener('click',          function() { self.cycleSpeed(); });
    el('opt-reset-watched').addEventListener('click', function() { self.resetWatched(); });
    el('opt-signout').addEventListener('click', function() {
      api('/auth/logout', { method: 'POST' }).then(function() { location.reload(); });
    });

    // Fullscreen icon swap
    document.addEventListener('fullscreenchange', function() {
      var isFS = !!document.fullscreenElement;
      el('icon-fs-enter').style.display = isFS ? 'none' : '';
      el('icon-fs-exit').style.display  = isFS ? '' : 'none';
    });

    // Seek bar
    this.initSeekBar();
    this.startSeekPoller();

    // Touch swipe
    var touchStartX = 0, touchStartY = 0;
    document.addEventListener('touchstart', function(e) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', function(e) {
      var dx = e.changedTouches[0].clientX - touchStartX;
      var dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
        dx < 0 ? self.nextChannel() : self.prevChannel();
      }
    }, { passive: true });

    // Video title opens YouTube
    el('ctrl-title-label').addEventListener('click', function(e) {
      e.stopPropagation();
      if (self.currentVideo) window.open('https://www.youtube.com/watch?v=' + self.currentVideo.id, '_blank');
    });

    // Back to live
    el('back-to-live').addEventListener('click', function() { self.backToLive(); });

    // Guide search
    el('guide-search').addEventListener('input', function() {
      var q = this.value.toLowerCase().trim();
      var cards = el('guide-grid').querySelectorAll('.guide-card');
      for (var i = 0; i < cards.length; i++) {
        var name = TV.channels[i] ? TV.channels[i].title.toLowerCase() : '';
        cards[i].style.display = (!q || name.indexOf(q) !== -1) ? '' : 'none';
      }
    });
    el('guide-search').addEventListener('keydown', function(e) {
      e.stopPropagation();
      if (e.key === 'Escape') TV.closeGuide();
    });

    // Click outside settings panel closes it
    document.addEventListener('click', function() { self.closeSettings(); });
    el('settings-panel').addEventListener('click', function(e) { e.stopPropagation(); });

    // Background preload
    setInterval(function() { self.preloadAdjacent(); }, 8000);
  },

  preloadAdjacent: function() {
    var len = this.channels.length;
    var offsets = [-2, -1, 1, 2];
    for (var i = 0; i < offsets.length; i++) {
      var idx = ((this.currentIndex + offsets[i]) % len + len) % len;
      var id  = this.channels[idx] && this.channels[idx].id;
      if (id && !this.videoCache[id]) this.getChannelVideos(id);
    }
  },

  resetWatched: async function() {
    await api('/api/watched', { method: 'DELETE' });
    this.watchedVideos.clear();
    this.broadcasts = {};   // also reset broadcasts so fresh picks happen
    var btn = el('opt-reset-watched');
    btn.textContent = 'Done!';
    setTimeout(function() { btn.textContent = 'Reset'; }, 2000);
  },

  // ── Persistent settings ──────────────────────────────────────────────────

  loadSettings: function() {
    this.staticOn    = lsGet('ytv_static',       'true') === 'true';
    this.scanlinesOn = lsGet('ytv_scanlines',    'true') === 'true';
    this.vignetteOn  = lsGet('ytv_vignette',     'true') === 'true';
    this.guideIsGrid = lsGet('ytv_guide_layout', 'grid') === 'grid';
    this._speedIndex = parseInt(lsGet('ytv_speed_idx', '0'), 10) % this._speedOptions.length;
    el('scanlines').classList.toggle('off', !this.scanlinesOn);
    el('vignette').classList.toggle('off', !this.vignetteOn);
    try {
      var b = localStorage.getItem('ytv_broadcasts');
      if (b) this.broadcasts = JSON.parse(b);
    } catch(e) {}
  },

  syncSettingsUI: function() {
    el('opt-static').textContent    = this.staticOn    ? 'ON'   : 'OFF';
    el('opt-scanlines').textContent = this.scanlinesOn ? 'ON'   : 'OFF';
    el('opt-vignette').textContent  = this.vignetteOn  ? 'ON'   : 'OFF';
    el('opt-guide-layout').textContent = this.guideIsGrid ? 'Grid' : 'List';
    el('opt-static').classList.toggle('active',    this.staticOn);
    el('opt-scanlines').classList.toggle('active', this.scanlinesOn);
    el('opt-vignette').classList.toggle('active',  this.vignetteOn);
    var rate = this._speedOptions[this._speedIndex];
    el('opt-speed').textContent = rate + '×';
    el('opt-speed').classList.toggle('active', rate !== 1);
  },

  // ── Sleep timer ──────────────────────────────────────────────────────────

  toggleSleepTimer: function() {
    clearTimeout(this._sleepTimer);
    this._sleepIndex = (this._sleepIndex + 1) % this._sleepOptions.length;
    var mins = this._sleepOptions[this._sleepIndex];
    var btn  = el('opt-sleep-timer');
    if (mins === 0) {
      btn.textContent = 'Off';
      btn.classList.remove('active');
    } else {
      btn.textContent = mins + 'm';
      btn.classList.add('active');
      var self = this;
      this._sleepTimer = setTimeout(function() {
        if (self.playerReady) self.player.pauseVideo();
        self._sleepIndex = 0;
        el('opt-sleep-timer').textContent = 'Off';
        el('opt-sleep-timer').classList.remove('active');
      }, mins * 60 * 1000);
    }
  },

  // ── Picture in picture ───────────────────────────────────────────────────

  initPip: function() {
    if (!window.documentPictureInPicture) el('ctrl-pip-btn').style.display = 'none';
  },

  togglePip: async function() {
    if (!window.documentPictureInPicture) return;
    var btn = el('ctrl-pip-btn');
    if (window.documentPictureInPicture.window) {
      window.documentPictureInPicture.window.close();
      return;
    }
    try {
      var pipWin = await window.documentPictureInPicture.requestWindow({
        width:  Math.round(window.innerWidth  * 0.36),
        height: Math.round(window.innerHeight * 0.36),
      });
      var wrapper = el('player-wrapper');
      pipWin.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
      pipWin.document.body.appendChild(wrapper);
      btn.classList.add('active');
      pipWin.addEventListener('pagehide', function() {
        if (!el('tv').contains(wrapper)) el('tv').insertBefore(wrapper, el('tv').firstChild);
        btn.classList.remove('active');
      });
    } catch(e) { console.warn('PiP:', e); }
  },

  // ── Shortcuts overlay ────────────────────────────────────────────────────

  toggleShortcuts: function() {
    this.shortcutsOpen = !this.shortcutsOpen;
    el('shortcuts-overlay').classList.toggle('open', this.shortcutsOpen);
  },

  closeShortcuts: function() {
    if (!this.shortcutsOpen) return;
    this.shortcutsOpen = false;
    el('shortcuts-overlay').classList.remove('open');
  },

  // ── Channel history (Backspace) ──────────────────────────────────────────

  goBack: function() {
    if (!this._channelHistory.length) return;
    this._historyNav = true;
    this.tuneToChannel(this._channelHistory.pop(), false, 1);
  },

  // ── Back to live ─────────────────────────────────────────────────────────

  showBackToLive: function() {
    el('back-to-live').classList.add('visible');
    clearTimeout(this._backToLiveTimer);
    var self = this;
    this._backToLiveTimer = setTimeout(function() {
      el('back-to-live').classList.remove('visible');
    }, 8000);
  },

  backToLive: function() {
    var ch = this.channels[this.currentIndex];
    if (!ch || !this.broadcasts[ch.id]) return;
    var videos = this.videoCache[ch.id];
    if (!videos || !videos.length) return;
    var now = this.getBroadcastNow(ch.id, videos);
    if (this.playerReady) this.player.seekTo(now.position, true);
    el('back-to-live').classList.remove('visible');
    clearTimeout(this._backToLiveTimer);
  },

  // ── Playback speed ───────────────────────────────────────────────────────

  cycleSpeed: function() {
    this._speedIndex = (this._speedIndex + 1) % this._speedOptions.length;
    var rate = this._speedOptions[this._speedIndex];
    if (this.playerReady) this.player.setPlaybackRate(rate);
    lsSet('ytv_speed_idx', this._speedIndex);
    var btn = el('opt-speed');
    btn.textContent = rate + '×';
    btn.classList.toggle('active', rate !== 1);
  },

  // ── Volume keyboard control ───────────────────────────────────────────────

  adjustVolume: function(delta) {
    var slider = el('ctrl-volume-slider');
    var newVol = Math.max(0, Math.min(100, parseInt(slider.value, 10) + delta));
    slider.value = newVol;
    lsSet('ytv_volume', newVol);
    if (!this.playerReady) return;
    this.player.setVolume(newVol);
    if (newVol === 0) {
      this.player.mute(); this.muted = true;
      el('icon-vol-on').style.display  = 'none';
      el('icon-vol-off').style.display = '';
    } else if (this.muted) {
      this.player.unMute(); this.muted = false;
      el('unmute-prompt').classList.remove('visible');
      el('icon-vol-on').style.display  = '';
      el('icon-vol-off').style.display = 'none';
    }
    this.showVolumeFeedback(newVol);
  },

  showVolumeFeedback: function(vol) {
    var indicator = el('volume-feedback');
    indicator.textContent = vol === 0 ? '🔇 Muted' : '🔊 ' + vol + '%';
    indicator.classList.add('visible');
    clearTimeout(this._volFeedbackTimer);
    var self = this;
    this._volFeedbackTimer = setTimeout(function() {
      el('volume-feedback').classList.remove('visible');
    }, 1400);
  },
};

// ── YouTube IFrame API ready ─────────────────────────────────────────────────

window._ytAPIReady = false;
window.onYouTubeIframeAPIReady = function() {
  window._ytAPIReady = true;
  if (TV.channels.length) TV.createPlayer();
};

// ── Utilities ────────────────────────────────────────────────────────────────

function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch(e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch(e) {} }

function el(id)        { return document.getElementById(id); }
function setText(id,t) { el(id).textContent = t; }
function show(id)      { el(id).style.display = 'flex'; }
function hide(id)      { el(id).style.display = 'none'; }

function fmtTime(sec) {
  sec = Math.floor(sec || 0);
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
  return m + ':' + pad(s);
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }

function escHtml(s) {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showError(msg) {
  hide('loading-screen');
  el('error-msg').textContent = msg;
  el('error-screen').style.display = 'flex';
}

async function api(url, opts) {
  opts = opts || {};
  var res = await fetch(url, {
    method:  opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body:    opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/'; return new Promise(function() {}); }
  if (!res.ok) {
    var body = {};
    try { body = await res.json(); } catch (e) {}
    // YouTube scope not granted — send user back through OAuth to re-authorize
    if (res.status === 403 && body.error === 'reauth_required') {
      location.href = '/auth/login';
      return new Promise(function() {}); // navigation in progress; don't surface an error
    }
    var err = new Error(body.detail || body.error || ('HTTP ' + res.status));
    err.detail = body.detail || body.error;
    throw err;
  }
  return res.json();
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

TV.init();
