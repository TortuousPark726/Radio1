/* ── State ──────────────────────────────────────────────────────────────── */
let accessToken = null;
let userName = null;
let deviceId = null;
let player = null;
let socket = null;
let roomCode = null;

let currentTrack = null;
let trackStartedAt = null;
let progressTimer = null;
let searchTimer = null;
let tokenRefreshTimer = null;

/* ── Boot ───────────────────────────────────────────────────────────────── */
async function boot() {
  const params = new URLSearchParams(location.search);
  const action = params.get('action');
  const roomParam = params.get('room');

  setLoading('Checking authentication…');

  let authData;
  try {
    const res = await fetch('/auth/token');
    if (!res.ok) {
      location.href = '/auth/login?state=' + (roomParam || '');
      return;
    }
    authData = await res.json();
  } catch {
    location.href = '/';
    return;
  }

  accessToken = authData.access_token;
  userName = authData.user?.name || 'Listener';

  tokenRefreshTimer = setInterval(refreshToken, 45 * 60 * 1000);

  setLoading('Initialising Spotify player…');
  await initSpotifyPlayer();

  setLoading('Connecting to room…');
  initSocket(action, roomParam);
}

/* ── Token refresh ──────────────────────────────────────────────────────── */
async function refreshToken() {
  try {
    const res = await fetch('/auth/token');
    if (res.ok) {
      const data = await res.json();
      accessToken = data.access_token;
    }
  } catch { /* silent */ }
}

/* ── Spotify Web Playback SDK ───────────────────────────────────────────── */
function initSpotifyPlayer() {
  return new Promise(resolve => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      player = new Spotify.Player({
        name: 'Radio1',
        getOAuthToken: async cb => { await refreshToken(); cb(accessToken); },
        volume: 0.8,
      });

      player.addListener('ready', ({ device_id }) => {
        deviceId = device_id;
        resolve();
      });

      player.addListener('not_ready', () => showToast('Spotify player disconnected — try refreshing'));
      player.addListener('initialization_error', ({ message }) => { showToast('Player error: ' + message); resolve(); });
      player.addListener('authentication_error', () => { showToast('Spotify auth error — try refreshing'); resolve(); });
      player.addListener('account_error', () => { showToast('Spotify Premium required for playback'); resolve(); });

      player.connect();
    };

    if (window.Spotify) window.onSpotifyWebPlaybackSDKReady();
  });
}

async function playTrack(uri, position_ms = 0) {
  if (!deviceId || !accessToken) return;
  try {
    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [uri], position_ms }),
    });
  } catch (err) {
    console.error('Play error:', err);
  }
}

function setVolume(v) {
  if (player) player.setVolume(v);
}

/* ── Socket.io ──────────────────────────────────────────────────────────── */
function initSocket(action, roomParam) {
  socket = io();

  socket.on('connect', () => {
    if (action === 'create') {
      socket.emit('create-room', { username: userName });
    } else if (roomParam) {
      socket.emit('join-room', { code: roomParam.toUpperCase(), username: userName });
    } else {
      location.href = '/room.html';
    }
  });

  socket.on('room-created', ({ code }) => {
    roomCode = code;
    history.replaceState(null, '', `/radio.html?room=${code}`);
    document.getElementById('room-code').textContent = code;
    showApp();
    showToast(`Room ${code} created — share the link!`);
  });

  socket.on('room-joined', ({ code, userQueue, radioQueue, currentTrack: track, position, listeners }) => {
    roomCode = code;
    document.getElementById('room-code').textContent = code;
    renderListeners(listeners);
    renderQueue(userQueue || [], radioQueue || []);
    if (track) {
      updateNowPlaying(track);
      playTrack(track.uri, position);
      trackStartedAt = Date.now() - position;
      startProgressTimer(track.duration);
    }
    showApp();
  });

  socket.on('play-track', ({ track, position }) => {
    updateNowPlaying(track);
    playTrack(track.uri, position);
    trackStartedAt = Date.now() - position;
    startProgressTimer(track.duration);
  });

  socket.on('queue-updated', ({ userQueue, radioQueue }) => renderQueue(userQueue || [], radioQueue || []));

  socket.on('playback-stopped', () => {
    stopProgressTimer();
    currentTrack = null;
    trackStartedAt = null;
    document.getElementById('track-name').textContent = 'Nothing playing';
    document.getElementById('track-artist').textContent = 'The queue is empty — add a song!';
    document.getElementById('track-added').style.display = 'none';
    document.getElementById('album-placeholder').style.display = 'flex';
    document.getElementById('album-art').style.display = 'none';
    document.getElementById('waveform').style.display = 'none';
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('time-current').textContent = '0:00';
    document.getElementById('time-total').textContent = '0:00';
    document.title = 'Radio1';
    renderQueue([], []);
  });

  socket.on('user-joined', ({ username, listeners }) => {
    renderListeners(listeners);
    showToast(`${username} joined the room`);
  });

  socket.on('user-left', ({ username, listeners }) => {
    renderListeners(listeners);
    showToast(`${username} left the room`);
  });

  socket.on('fetch-recommendations', async ({ seedArtistIds, seedArtistNames, seedTracks }) => {
    try {
      const params = new URLSearchParams();
      if (seedArtistIds?.length)   params.set('seed_artist_ids',   seedArtistIds.slice(0, 5).join(','));
      if (seedArtistNames?.length) params.set('seed_artist_names', seedArtistNames.slice(0, 5).join(','));
      if (seedTracks?.length) {
        // Encode as "Name|Artist|Year" triples joined by ";"
        params.set('seed_tracks', seedTracks.map(t => `${t.name}|${t.artist}|${t.releaseYear || ''}`).join(';'));
      }
      const q = params.toString() ? '?' + params.toString() : '';
      const res = await fetch('/api/recommendations' + q);
      if (!res.ok) { console.warn('Recommendations fetch failed:', res.status); return; }
      const tracks = await res.json();
      socket.emit('send-recommendations', { tracks });
    } catch (err) {
      console.warn('Recommendations error:', err);
    }
  });

  socket.on('room-error', msg => {
    hideLoading();
    showToast(msg);
    setTimeout(() => location.href = '/room.html', 2500);
  });

  socket.on('disconnect', () => showToast('Disconnected — reconnecting…'));
  socket.on('reconnect', () => {
    showToast('Reconnected!');
    if (roomCode) socket.emit('join-room', { code: roomCode, username: userName });
  });
}

/* ── UI: now playing ────────────────────────────────────────────────────── */
function updateNowPlaying(track) {
  currentTrack = track;
  document.getElementById('track-name').textContent = track.name;
  document.getElementById('track-artist').textContent = track.artist;
  document.title = `${track.name} — Radio1`;

  const addedEl = document.getElementById('track-added');
  if (track.addedBy) {
    document.getElementById('track-added-name').textContent = track.addedBy;
    addedEl.style.display = 'flex';
  } else {
    addedEl.style.display = 'none';
  }

  const art = document.getElementById('album-art');
  const placeholder = document.getElementById('album-placeholder');
  const waveform = document.getElementById('waveform');

  if (track.albumArt) {
    art.src = track.albumArt;
    art.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    art.style.display = 'none';
    placeholder.style.display = 'flex';
  }

  waveform.style.display = 'flex';
  document.getElementById('time-total').textContent = formatTime(track.duration);
}

/* ── UI: progress bar ───────────────────────────────────────────────────── */
function startProgressTimer(duration) {
  stopProgressTimer();
  progressTimer = setInterval(() => {
    if (!trackStartedAt || !duration) return;
    const elapsed = Date.now() - trackStartedAt;
    const pct = Math.min(100, (elapsed / duration) * 100);
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('time-current').textContent = formatTime(Math.min(elapsed, duration));
  }, 500);
}

function stopProgressTimer() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function formatTime(ms) {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ── UI: queue ──────────────────────────────────────────────────────────── */
function renderQueue(userQueue, radioQueue) {
  const list = document.getElementById('queue-list');
  const count = document.getElementById('queue-count');
  const total = userQueue.length + radioQueue.length;
  count.textContent = total + ' Song' + (total !== 1 ? 's' : '');

  if (total === 0) {
    list.innerHTML = `
      <div class="flex flex-col items-center justify-center py-6 gap-2 text-on-surface-variant border-2 border-dashed border-outline-variant rounded-lg w-full">
          <p class="text-[12px] italic">Queue is empty — search for a song to get started</p>
      </div>`;
    return;
  }

  const trackRow = (t, isRadio) => `
    <div class="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-highlight transition-all ${isRadio ? 'opacity-70' : ''}">
      <img src="${esc(t.albumArt || '')}" alt=""
        class="w-10 h-10 rounded object-cover bg-surface-highlight flex-shrink-0"
        onerror="this.style.display='none'"/>
      <div class="flex-1 min-w-0">
        <div class="text-on-surface font-bold text-[13px] truncate">${esc(t.name)}</div>
        <div class="text-on-surface-variant text-[11px] truncate">${esc(t.artist)}</div>
      </div>
      <span class="text-[10px] font-bold flex-shrink-0 truncate max-w-[80px] ${isRadio ? 'text-primary/40' : 'text-primary/70'}">${esc(t.addedBy || '')}</span>
    </div>`;

  const divider = `
    <div class="flex items-center gap-2 py-1.5 px-1">
      <div class="h-px flex-1 bg-outline-variant"></div>
      <span class="text-[9px] font-black uppercase tracking-widest text-primary/50">✦ Radio</span>
      <div class="h-px flex-1 bg-outline-variant"></div>
    </div>`;

  let html = userQueue.map(t => trackRow(t, false)).join('');
  if (radioQueue.length > 0) {
    if (userQueue.length > 0) html += divider;
    html += radioQueue.map(t => trackRow(t, true)).join('');
  }

  list.innerHTML = html;
}

/* ── UI: listeners ──────────────────────────────────────────────────────── */
function renderListeners(listeners) {
  document.getElementById('listeners-count').textContent = listeners.length;
  const list = document.getElementById('listeners-list');
  const visible = listeners.slice(0, 5);
  const overflow = listeners.length - visible.length;

  list.innerHTML = visible.map(name => `
    <div class="w-8 h-8 rounded-full border-2 border-background bg-surface-container-high flex items-center justify-center text-[11px] font-bold text-on-surface ring-1 ring-primary/20" title="${esc(name)}">
      ${esc(name.charAt(0).toUpperCase())}
    </div>
  `).join('') + (overflow > 0 ? `
    <div class="w-8 h-8 rounded-full bg-surface-highlight flex items-center justify-center border-2 border-background text-[10px] font-bold text-on-surface-variant">
      +${overflow}
    </div>
  ` : '');
}

/* ── Search ─────────────────────────────────────────────────────────────── */
let lastQuery = '';

function onSearchInput() {
  const q = document.getElementById('search-input').value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) return;
  searchTimer = setTimeout(() => doSearch(), 400);
}

async function doSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q || q === lastQuery) return;
  lastQuery = q;

  document.getElementById('search-results').innerHTML = `
    <div class="flex items-center justify-center h-32 text-on-surface-variant gap-3">
      <div class="w-5 h-5 border-2 border-outline-variant border-t-primary rounded-full animate-spin"></div>
      <span class="text-[13px]">Searching…</span>
    </div>`;

  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const tracks = await res.json();
    renderSearchResults(tracks);
  } catch {
    document.getElementById('search-results').innerHTML =
      '<div class="flex items-center justify-center h-32 text-on-surface-variant text-[13px]">Search failed — try again</div>';
  }
}

function renderSearchResults(tracks) {
  const el = document.getElementById('search-results');
  if (!tracks.length) {
    el.innerHTML = '<div class="flex items-center justify-center h-32 text-on-surface-variant text-[13px]">No results found</div>';
    return;
  }

  el.innerHTML = tracks.map(t => `
    <div class="group flex items-center justify-between p-3 rounded-lg hover:bg-surface-highlight transition-all cursor-pointer"
      onclick="addSong(${esc(JSON.stringify(t))})">
      <div class="flex items-center gap-4 min-w-0">
        <img src="${esc(t.albumArt || '')}" alt=""
          class="w-12 h-12 rounded object-cover bg-surface-highlight flex-shrink-0"
          onerror="this.style.display='none'"/>
        <div class="min-w-0">
          <h4 class="text-on-surface font-bold text-body-lg truncate">${esc(t.name)}</h4>
          <p class="text-on-surface-variant text-body-md truncate">${esc(t.artist)}</p>
        </div>
      </div>
      <div class="flex items-center gap-4 flex-shrink-0 ml-2">
        <span class="text-on-surface-variant text-label-bold hidden sm:block">${formatTime(t.duration)}</span>
        <button class="opacity-0 group-hover:opacity-100 bg-primary-container text-on-primary-container p-2 rounded-full transition-opacity active:scale-90">
          <span class="material-symbols-outlined text-[20px]">add</span>
        </button>
      </div>
    </div>
  `).join('');
}

function addSong(track) {
  socket.emit('add-song', { track });
  showToast(`"${track.name}" added to queue`);
}

/* ── Controls ───────────────────────────────────────────────────────────── */
function skipSong() {
  socket.emit('skip-song');
}

function copyInvite() {
  const url = `${location.origin}/radio.html?room=${roomCode}`;
  navigator.clipboard.writeText(url).then(() => showToast('Invite link copied!'));
}

/* ── Toast ──────────────────────────────────────────────────────────────── */
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ── Loading ────────────────────────────────────────────────────────────── */
function setLoading(msg) {
  document.getElementById('loading-msg').textContent = msg;
  document.getElementById('loading').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function showApp() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

function hideLoading() {
  document.getElementById('loading').style.display = 'none';
}

/* ── Helpers ────────────────────────────────────────────────────────────── */
function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

boot();
