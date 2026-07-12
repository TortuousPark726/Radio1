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

// roomCode → { code, host, queue, currentTrack, history, trackTimer, clients: Map<socketId, username> }
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
    albumArt: t.album.images[1]?.url || t.album.images[0]?.url || null,
    duration: t.duration_ms,
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
    const params = { limit: 5, market: 'US' };
    if (req.query.seed_tracks) params.seed_tracks = req.query.seed_tracks;
    else params.seed_genres = 'pop,indie,electronic';
    const { data } = await axios.get('https://api.spotify.com/v1/recommendations', {
      params,
      headers: { Authorization: 'Bearer ' + token },
    });
    res.json(data.tracks.map(formatTrack));
  } catch (err) {
    console.error('Recs error:', err.response?.data);
    res.status(500).json({ error: 'Recommendations failed' });
  }
});

// ── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  socket.on('create-room', ({ username }) => {
    const code = makeRoomCode();
    rooms.set(code, {
      code,
      host: socket.id,
      queue: [],
      currentTrack: null,
      history: [],
      trackTimer: null,
      clients: new Map([[socket.id, username]]),
    });
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
      queue: room.queue,
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
    room.queue.push({ ...track, addedBy: socket.data.username });
    io.to(socket.data.roomCode).emit('queue-updated', { queue: room.queue });
    if (!room.currentTrack) advance(socket.data.roomCode);
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
    tracks.forEach(t => room.queue.push({ ...t, addedBy: '✦ Radio' }));
    io.to(socket.data.roomCode).emit('queue-updated', { queue: room.queue });
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

  if (room.queue.length === 0) {
    if (room.currentTrack) room.history.push(room.currentTrack);
    room.currentTrack = null;
    io.to(roomCode).emit('playback-stopped');
    requestRecommendations(room);
    return;
  }

  const track = room.queue.shift();
  if (room.currentTrack) room.history.push(room.currentTrack);
  room.currentTrack = { ...track, startedAt: Date.now() };

  io.to(roomCode).emit('queue-updated', { queue: room.queue });
  io.to(roomCode).emit('play-track', { track: room.currentTrack, position: 0 });

  // +3s buffer for network latency before advancing
  room.trackTimer = setTimeout(() => advance(roomCode), track.duration + 3000);

  if (room.queue.length < 2) requestRecommendations(room);

  console.log(`[${roomCode}] ▶ ${track.name} — ${track.artist}`);
}

function requestRecommendations(room) {
  const hostSocket = io.sockets.sockets.get(room.host);
  if (!hostSocket) return;
  const seeds = [...room.history.slice(-3), room.currentTrack]
    .filter(Boolean)
    .map(t => t.uri.split(':')[2]);
  hostSocket.emit('fetch-recommendations', { seedTracks: seeds });
}

server.listen(PORT, () => console.log(`Radio1 → http://localhost:${PORT}`));
