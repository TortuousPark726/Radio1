# Radio1

A collaborative Spotify radio web app. Create a room, share a code, and everyone listens together — each person on their own device. The queue is shared and synced in real time. When the user queue runs dry, AI-powered radio kicks in automatically, recommending songs based on what the room has been adding. 

These instructions are added because this app is not scalable with the current limitations of Spotify Developers and Spotify Extended Quota
---

## Features

- Real-time synced playback across all listeners in a room
- Shared queue — anyone in the room can add songs
- User songs always play first; radio fills in automatically
- Radio recommendations powered by Last.fm, based on the last 10 songs added to the queue
- Radio queue refreshes live as people add new songs
- Repeat prevention (no song repeats within the last 50 tracks)

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- **Spotify Premium** account
- **Spotify Developer** app (free)
- **Last.fm API** key (free)

---

## Step 1 — Create Spotify Developer App

To create the application, go to Spotify Developers and log in using your Spotify Premium account. Head to dashboard and create the app. Fill in the name and description. Under Redirect URIs, add 'http://127.0.0.1:3000/auth/callback' and under APIs used, check Web Playback SDK. Create the app and get your Client ID and Client Secret

> **Important:** Spotify apps start in Development Mode. In this mode, only users you explicitly add as testers can authenticate. To add testers, go to your app → **Settings** → **User Management** and add their Spotify email addresses (max 25 users in dev mode).

---

## Step 2 — Get a Last.fm API Key

1. Create a free Last.fm account at [last.fm](https://www.last.fm).
2. Go to [last.fm/api/account/create](https://www.last.fm/api/account/create).
3. Fill in any application name and description. Callback URL and homepage can be left blank.
4. Submit — you'll be shown your **API key** immediately.

Create a Last.fm account(https://www.last.fm) and get it verified. Go to https://www.last.fm/api/account/create and fill the application name and description. The rest stays blank. Submit and copy down the API key. 

---

## Step 3 — Clone and Install

```bash
git clone https://github.com/TortuousPark726/Radio1.git
cd Radio1
npm install
```

---

## Step 4 — Configure Environment Variables

Create a `.env` file in the project root (never commit this file):

```
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
REDIRECT_URI=http://127.0.0.1:3000/auth/callback
SESSION_SECRET=any_random_string
PORT=3000
LASTFM_API_KEY=your_lastfm_api_key
```

Replace the placeholder values with your copied credentials from Steps 1 and 2.

---

## Step 5 — Run the App

```bash
node server.js
```

Open `http://localhost:3000` in Chrome or Firefox and click **Connect with Spotify**.

> **Note:** You must open the app at `http://127.0.0.1:3000` (not `localhost`) if that's what you set as your redirect URI in the Spotify dashboard. The two are not interchangeable for OAuth.

---

## How It Works

### Room system
- One user creates a room and gets a 6-character code.
- Others join by entering that code.
- The host's browser handles playback authentication — all listeners sync to the host's position.

### Queue
- Any user in the room can search for and add songs to the shared queue.
- User-added songs always play before radio picks.

### Radio recommendations
- When the user queue runs low (fewer than 3 radio songs buffered), the server calls Last.fm's `track.getSimilar` API using up to 3 randomly sampled tracks from the last 10 user-added songs.
- Last.fm returns genre-aware similar tracks.
- Each similar track is searched on Spotify to get a playable URI.
- When new songs are added to the queue, the radio queue automatically refreshes after a short debounce.

### Why Last.fm instead of Spotify's recommendation API?
Spotify deprecated `/v1/recommendations` in November 2024. Several other useful endpoints (`/v1/artists/{id}/related-artists`, `/v1/artists/{id}/top-tracks`) are also restricted for apps in Development Mode. Last.fm's `track.getSimilar` is free, unrestricted, and returns genuinely genre-accurate results.

---

## Project Structure

```
Radio1/
├── server.js          # Express server, Socket.io, Spotify OAuth, recommendation logic
├── public/
│   ├── index.html     # Landing page
│   ├── room.html      # Create/join room page
│   ├── radio.html     # Main player UI
│   └── js/
│       └── radio.js   # Client-side playback, queue sync, socket events
├── .env               # Your credentials (never committed)
├── .gitignore
└── package.json
```

---
