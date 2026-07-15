require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://127.0.0.1:3000/auth/callback';
const PORT = process.env.PORT || 3000;

// roomCode → { code, host, queue, currentTrack, history, userAddedTracks, userAddedArtistIds, trackTimer, clients }
const rooms = new Map();

function makeRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function basicAuth() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

function formatTrack(t) {
  return {
    uri: t.uri,
    name: t.name,
    artist: t.artists.map(a => a.name).join(', '),
    artistId: t.artists[0]?.id || null,
    albumArt: t.album.images[1]?.url || t.album.images[0]?.url || null,
    duration: t.duration_ms,
    releaseYear: t.album?.release_date?.slice(0, 4) || null,
  };
}

async function refreshIfNeeded(tokens) {
  if (Date.now() < tokens.expires_at - 60_000) return true;
  try {
    const { data } = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
      { headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokens.access_token = data.access_token;
    tokens.expires_at = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) tokens.refresh_token = data.refresh_token;
    return true;
  } catch {
    return false;
  }
}

async function getToken(req) {
  if (!req.session.tokens) return null;
  return (await refreshIfNeeded(req.session.tokens)) ? req.session.tokens.access_token : null;
}

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(express.static('public'));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}));

// ── Auth ─────────────────────────────────────────────────────────────────────

app.get('/auth/login', (req, res) => {
  const scopes = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-read-playback-state',
    'user-modify-playback-state',
    'playlist-read-private',
    'playlist-read-collaborative',
  ].join(' ');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: scopes,
    redirect_uri: REDIRECT_URI,
  });
  // Only add state if present — empty state param can confuse Spotify
  if (req.query.state) params.set('state', req.query.state);

  const authUrl = 'https://accounts.spotify.com/authorize?' + params;
  console.log('→ client_id:', CLIENT_ID);
  console.log('→ redirect_uri:', REDIRECT_URI);
  console.log('→ auth URL:', authUrl);
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.error('→ Spotify returned error:', error, req.query);
    return res.redirect('/?error=' + error);
  }
  try {
    const { data } = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      { headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    req.session.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    const { data: me } = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: 'Bearer ' + data.access_token },
    });
    req.session.user = { id: me.id, name: me.display_name || me.id };
    res.redirect(state ? `/radio.html?room=${state}` : '/room.html');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/token', async (req, res) => {
  const token = await getToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ access_token: token, user: req.session.user });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ── Spotify API Proxy ────────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  const token = await getToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.query.q?.trim()) return res.json([]);
  try {
    const { data } = await axios.get('https://api.spotify.com/v1/search', {
      params: { q: req.query.q, type: 'track', limit: 8, market: 'US' },
      headers: { Authorization: 'Bearer ' + token },
    });
    res.json(data.tracks.items.map(formatTrack));
  } catch (err) {
    console.error('Search error:', err.response?.data);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/recommendations', async (req, res) => {
  const token = await getToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const seedNames  = req.query.seed_artist_names?.split(',').filter(Boolean) || [];
    const seedTracks = (req.query.seed_tracks || '').split(';').filter(Boolean)
      .map(s => { const p = s.split('|'); return p.length >= 2 ? { name: p[0], artist: p[1] } : null; })
      .filter(Boolean)
      .slice(0, 3);

    console.log(`[recs] query: names=[${seedNames}] tracks=${JSON.stringify(seedTracks)}`);

    const LASTFM_KEY = process.env.LASTFM_API_KEY;
    const allTracks = [];

    // ── Last.fm track.getSimilar → Spotify search ─────────────────────────────
    for (const { name, artist } of seedTracks.slice(0, 3)) {
      try {
        const { data: lfm } = await axios.get('http://ws.audioscrobbler.com/2.0/', {
          params: { method: 'track.getSimilar', track: name, artist, api_key: LASTFM_KEY, format: 'json', limit: 20 },
        });
        const similar = Array.isArray(lfm.similartracks?.track) ? lfm.similartracks.track : [];
        console.log(`[recs] Last.fm "${name}" by "${artist}" → ${similar.length} similar tracks`);

        const results = await Promise.all(
          similar.slice(0, 15).map(async t => {
            try {
              const { data: sr } = await axios.get('https://api.spotify.com/v1/search', {
                params: { q: `track:"${t.name}" artist:"${t.artist.name}"`, type: 'track', limit: 1, market: 'US' },
                headers: { Authorization: 'Bearer ' + token },
              });
              return sr.tracks?.items?.[0] || null;
            } catch { return null; }
          })
        );
        allTracks.push(...results.filter(Boolean));
      } catch (e) {
        console.log(`[recs] Last.fm error for "${name}": ${e.message}`);
      }
    }

    // ── Fallback: Last.fm artist.getTopTracks if track seeds returned nothing ─
    if (allTracks.length < 3) {
      for (const artist of seedNames.slice(0, 2)) {
        try {
          const { data: lfm } = await axios.get('http://ws.audioscrobbler.com/2.0/', {
            params: { method: 'artist.getTopTracks', artist, api_key: LASTFM_KEY, format: 'json', limit: 10 },
          });
          const tops = Array.isArray(lfm.toptracks?.track) ? lfm.toptracks.track : [];
          console.log(`[recs] Last.fm artist "${artist}" top tracks → ${tops.length}`);
          const results = await Promise.all(
            tops.slice(0, 8).map(async t => {
              try {
                const { data: sr } = await axios.get('https://api.spotify.com/v1/search', {
                  params: { q: `track:"${t.name}" artist:"${artist}"`, type: 'track', limit: 1, market: 'US' },
                  headers: { Authorization: 'Bearer ' + token },
                });
                return sr.tracks?.items?.[0] || null;
              } catch { return null; }
            })
          );
          allTracks.push(...results.filter(Boolean));
        } catch { /* skip */ }
      }
    }

    console.log(`[recs] pool: ${allTracks.length} candidates`);

    // Deduplicate → shuffle → max 2 per artist → return up to 8
    const seenIds = new Set();
    const unique = allTracks.filter(t => {
      if (!t?.id || seenIds.has(t.id)) return false;
      seenIds.add(t.id);
      return true;
    });
    for (let i = unique.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unique[i], unique[j]] = [unique[j], unique[i]];
    }
    const artistCount = new Map();
    const varied = [];
    for (const t of unique) {
      const key = t.artists?.[0]?.id || 'unknown';
      const n = artistCount.get(key) || 0;
      if (n < 2) { varied.push(t); artistCount.set(key, n + 1); }
      if (varied.length >= 8) break;
    }

    const resultArtists = [...new Set(varied.map(t => t.artists?.[0]?.name))];
    console.log(`[recs] returning ${varied.length} tracks from: ${resultArtists.join(', ')}`);
    res.json(varied.map(formatTrack));
  } catch (err) {
    console.error('Recs error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Recommendations failed' });
  }
});

// ── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  socket.on('create-room', ({ username }) => {
    const code = makeRoomCode();
    const room = {
      code,
      host: socket.id,
      userQueue: [],
      radioQueue: [],
      currentTrack: null,
      history: [],
      userAddedArtists: [], // { id, name } — used as rec seeds
      userAddedTracks: [],  // { name, artist } — last 10 user-added, used as Last.fm seeds
      recsPending: false,
      recsDebounceTimer: null,
      trackTimer: null,
      clients: new Map([[socket.id, username]]),
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.username = username;
    socket.emit('room-created', { code });
    console.log(`[${code}] Created by ${username}`);
  });

  socket.on('join-room', ({ code, username }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('room-error', 'Room not found — check the code and try again.');

    room.clients.set(socket.id, username);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.username = username;

    const position = room.currentTrack ? Math.max(0, Date.now() - room.currentTrack.startedAt) : 0;
    socket.emit('room-joined', {
      code,
      userQueue: room.userQueue,
      radioQueue: room.radioQueue,
      currentTrack: room.currentTrack,
      position,
      listeners: Array.from(room.clients.values()),
    });
    socket.to(code).emit('user-joined', {
      username,
      listeners: Array.from(room.clients.values()),
    });
    console.log(`[${code}] ${username} joined (${room.clients.size} listeners)`);
  });

  socket.on('add-song', ({ track }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    room.userQueue.push({ ...track, addedBy: socket.data.username });

    if (track.artistId && !room.userAddedArtists.some(a => a.id === track.artistId)) {
      room.userAddedArtists.push({ id: track.artistId, name: track.artist.split(',')[0].trim() });
      if (room.userAddedArtists.length > 20) room.userAddedArtists.shift();
    }
    room.userAddedTracks.push({ name: track.name, artist: track.artist.split(',')[0].trim() });
    if (room.userAddedTracks.length > 10) room.userAddedTracks.shift();

    io.to(socket.data.roomCode).emit('queue-updated', { userQueue: room.userQueue, radioQueue: room.radioQueue });
    if (!room.currentTrack) advance(socket.data.roomCode);

    // Refresh radio queue to reflect updated taste — debounced so rapid adds don't spam Last.fm
    if (room.recsDebounceTimer) clearTimeout(room.recsDebounceTimer);
    room.recsDebounceTimer = setTimeout(() => {
      room.recsDebounceTimer = null;
      room.radioQueue = [];
      room.recsPending = false;
      requestRecommendations(room);
      io.to(socket.data.roomCode).emit('queue-updated', { userQueue: room.userQueue, radioQueue: room.radioQueue });
    }, 1500);
  });

  socket.on('skip-song', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    console.log(`[${socket.data.roomCode}] Skip by ${socket.data.username}`);
    advance(socket.data.roomCode);
  });

  // Host fetches recs client-side and sends results back through here
  socket.on('send-recommendations', ({ tracks }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !tracks?.length) return;

    // Block any track played in the last 20 songs, currently playing, or already queued
    const blocked = new Set([
      room.currentTrack?.uri,
      ...room.history.slice(-50).map(t => t.uri),
      ...room.radioQueue.map(t => t.uri),
      ...room.userQueue.map(t => t.uri),
    ].filter(Boolean));

    room.recsPending = false;

    const fresh = tracks.filter(t => !blocked.has(t.uri));
    if (!fresh.length) return;

    fresh.forEach(t => room.radioQueue.push({ ...t, addedBy: '✦ Radio' }));
    io.to(socket.data.roomCode).emit('queue-updated', { userQueue: room.userQueue, radioQueue: room.radioQueue });
    if (!room.currentTrack) advance(socket.data.roomCode);
  });

  socket.on('disconnect', () => {
    const { roomCode, username } = socket.data;
    const room = rooms.get(roomCode);
    if (!room) return;

    room.clients.delete(socket.id);

    if (room.clients.size === 0) {
      if (room.trackTimer) clearTimeout(room.trackTimer);
      rooms.delete(roomCode);
      console.log(`[${roomCode}] Closed (empty)`);
      return;
    }
    if (room.host === socket.id) {
      room.host = room.clients.keys().next().value;
    }
    io.to(roomCode).emit('user-left', {
      username,
      listeners: Array.from(room.clients.values()),
    });
  });
});

function advance(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.trackTimer) clearTimeout(room.trackTimer);

  // User picks always play first; Radio queue is the fallback
  let track;
  if (room.userQueue.length > 0) {
    track = room.userQueue.shift();
  } else if (room.radioQueue.length > 0) {
    track = room.radioQueue.shift();
  } else {
    if (room.currentTrack) room.history.push(room.currentTrack);
    room.currentTrack = null;
    io.to(roomCode).emit('playback-stopped');
    requestRecommendations(room);
    return;
  }

  if (room.currentTrack) {
    room.history.push(room.currentTrack);
    if (room.history.length > 100) room.history.shift();
  }
  room.currentTrack = { ...track, startedAt: Date.now() };

  io.to(roomCode).emit('queue-updated', { userQueue: room.userQueue, radioQueue: room.radioQueue });
  io.to(roomCode).emit('play-track', { track: room.currentTrack, position: 0 });

  room.trackTimer = setTimeout(() => advance(roomCode), track.duration + 3000);

  // Keep radio queue topped up in the background
  if (room.radioQueue.length < 3) requestRecommendations(room);

  console.log(`[${roomCode}] ▶ ${track.name} — ${track.artist}`);
}

function requestRecommendations(room) {
  if (room.recsPending) return;
  const hostSocket = io.sockets.sockets.get(room.host);
  if (!hostSocket) return;
  room.recsPending = true;

  // Artist seeds: ONLY user-added songs, never radio-generated history.
  // Using history artists causes a feedback loop where radio picks corrupt future recs.
  let artistSeeds = room.userAddedArtists.slice(-5);
  if (artistSeeds.length === 0 && room.currentTrack?.artistId) {
    // No user songs yet — seed from the current track only
    artistSeeds = [{ id: room.currentTrack.artistId, name: room.currentTrack.artist.split(',')[0].trim() }];
  }

  // Track seeds: randomly sample 3 from the last 10 user-added tracks for variety.
  // If the user hasn't added anything yet, fall back to the current track.
  const pool = [...room.userAddedTracks];
  const trackSeeds = [];
  while (trackSeeds.length < 3 && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    trackSeeds.push(pool.splice(idx, 1)[0]);
  }
  if (trackSeeds.length === 0 && room.currentTrack) {
    trackSeeds.push({ name: room.currentTrack.name, artist: room.currentTrack.artist.split(',')[0].trim() });
  }

  hostSocket.emit('fetch-recommendations', {
    seedArtistIds:   artistSeeds.map(a => a.id),
    seedArtistNames: artistSeeds.map(a => a.name),
    seedTracks:      trackSeeds,
  });
}

server.listen(PORT, () => console.log(`Radio1 → http://localhost:${PORT}`));
