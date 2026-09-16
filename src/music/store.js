/*
 * Peace✘ - Discord Bot
 * Developed by ACEtnc
 *
 * Per-user playlist store: MongoDB by default, local fallback when the DB is
 * unreachable.
 *
 * Every user gets an implicit default **liked** playlist (names "liked"/"like"
 * are reserved). ❤️ buttons and "/playlist play liked" use it. Users can also
 * create custom playlists (create / add by URL / show / view / delete) which
 * follow them across every guild.
 *
 * Mongo schema:
 *   playlists      { userId, name (lowercased), label, created }  UNIQUE(userId, name)
 *   playlist_tracks{ userId, name, title, url, duration, addedAt } UNIQUE(userId, name, url)
 *
 * Fallback (Mongo down):
 *   liked tracks -> SQLite data/music.db (previous behavior)
 *   custom lists -> JSON data/userPlaylists.json
 */
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');
try { require('dotenv').config(); } catch {} // load MONGO_URI when used outside index.js

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const LIKED = 'liked';
const RESERVED = new Set(['liked', 'like']);
const PLAY_LIMIT = 500;

// ── Fallback: liked songs -> SQLite (keeps old behavior alive) ──────────
const DB_PATH = path.join(DATA_DIR, 'music.db');
let sqlite = null;
let sqlInsertUser = null;
let sqlInsert = null;
let sqlRemoveUrl = null;
let sqlRemoveId = null;
let sqlAll = null;
let sqlHas = null;
try {
  const Database = require('better-sqlite3');
  sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      duration TEXT,
      added_at INTEGER NOT NULL,
      UNIQUE(user_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_pl_user ON playlist_tracks(user_id);
  `);
  sqlInsertUser = sqlite.prepare('INSERT OR IGNORE INTO users (user_id) VALUES (?)');
  sqlInsert = sqlite.prepare(
    `INSERT OR IGNORE INTO playlist_tracks (user_id, title, url, duration, added_at)
     VALUES (@user_id, @title, @url, @duration, @added_at)`
  );
  sqlRemoveUrl = sqlite.prepare('DELETE FROM playlist_tracks WHERE user_id = ? AND url = ?');
  sqlRemoveId = sqlite.prepare('DELETE FROM playlist_tracks WHERE user_id = ? AND id = ?');
  sqlAll = sqlite.prepare('SELECT id, title, url, duration, added_at FROM playlist_tracks WHERE user_id = ? ORDER BY id ASC');
  sqlHas = sqlite.prepare('SELECT 1 FROM playlist_tracks WHERE user_id = ? AND url = ?');
} catch (err) {
  sqlite = null;
  console.warn(`[PeaceX] [store] SQLite binding unavailable (${err.message}) — using JSON file for liked tracks.`);
}

// ── Fallback: custom playlists -> JSON file ─────────────────────────────
const FALLBACK_FILE = path.join(DATA_DIR, 'userPlaylists.json');
if (!fs.existsSync(FALLBACK_FILE)) fs.writeFileSync(FALLBACK_FILE, '{}', 'utf8');
let fbCache = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
function fbPersist() { fs.writeFileSync(FALLBACK_FILE, JSON.stringify(fbCache, null, 2), 'utf8'); }
function fbUser(userId) { if (!fbCache[userId]) fbCache[userId] = {}; return fbCache[userId]; }
function fbLiked(userId) {
  const store = fbUser(String(userId));
  if (!store[LIKED] || !Array.isArray(store[LIKED].tracks)) store[LIKED] = { name: LIKED, label: 'Liked', tracks: [] };
  return store[LIKED];
}

// ── MongoDB (lazy, never blocks startup) ────────────────────────────────
const MONGO_URI = (process.env.MONGO_URI && process.env.MONGO_URI.trim()) || 'mongodb://127.0.0.1:27017';
const MONGO_DB = (process.env.MONGO_DB && process.env.MONGO_DB.trim()) || 'peace_music';

let mclient = null;
let db = null;
let colls = null;
let connecting = null;
let retryAfter = 0;

async function ensureMongo() {
  if (db) return true;
  if (connecting) return connecting;
  if (Date.now() < retryAfter) return false;
  connecting = (async () => {
    try {
      mclient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 10000 });
      await mclient.connect();
      db = mclient.db(MONGO_DB);
      colls = {
        playlists: db.collection('playlists'),
        tracks: db.collection('playlist_tracks'),
      };
      await colls.playlists.createIndex({ userId: 1, name: 1 }, { unique: true });
      await colls.tracks.createIndex({ userId: 1, name: 1, url: 1 }, { unique: true });
      await colls.tracks.createIndex({ userId: 1, name: 1 });
      return true;
    } catch (err) {
      db = null;
      mclient = null;
      colls = null;
      retryAfter = Date.now() + 60 * 1000;
      console.warn(`[PeaceX] [store] MongoDB unavailable (${err.message}) — using local fallback stores (retry in 60s).`);
      return false;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

/** Resolve a playlist name to its stored key: reserved names map to "liked". */
function normName(name) {
  const n = String(name || '').trim().toLowerCase();
  return RESERVED.has(n) ? LIKED : n;
}

function cleanLabel(name) {
  return String(name || '').trim().slice(0, 40);
}

function isReserved(name) {
  return RESERVED.has(String(name || '').trim().toLowerCase());
}

// ── Mongo helpers ───────────────────────────────────────────────────────
async function mCreatePlaylist(userId, name, label) {
  const key = normName(name);
  if (isReserved(name)) return { ok: true, playlist: { name: key, label: 'Liked', created: 0 }, isDefault: true };
  try {
    await colls.playlists.insertOne({ userId, name: key, label, created: Date.now() });
    return { ok: true, playlist: { name: key, label, created: Date.now() }, isDefault: false };
  } catch (err) {
    if (err?.code === 11000) return { ok: false, error: 'exists' };
    throw err;
  }
}

async function mUpsertPlaylist(userId, name, label) {
  const key = normName(name);
  if (isReserved(name)) return { name: key, label: 'Liked' };
  await colls.playlists.updateOne(
    { userId, name: key },
    { $setOnInsert: { userId, name: key, label, created: Date.now() } },
    { upsert: true }
  );
  return { name: key, label };
}

async function mTrackCount(userId, name) {
  return colls.tracks.countDocuments({ userId, name });
}

async function mAddTrack(userId, name, track, label) {
  const pl = await mUpsertPlaylist(userId, name, label);
  const url = String(track.url || '');
  if (!url) return { ok: false, error: 'missing url', playlist: pl };
  const dup = await colls.tracks.findOne({ userId, name: pl.name, url });
  if (dup) return { ok: true, duplicate: true, created: false, playlist: pl };
  const count = await mTrackCount(userId, pl.name);
  if (count >= PLAY_LIMIT) return { ok: false, error: 'limit', playlist: pl };
  await colls.tracks.insertOne({
    userId,
    name: pl.name,
    title: String(track.title || 'Untitled'),
    url,
    duration: track.duration ? String(track.duration) : null,
    addedAt: Date.now(),
  });
  return { ok: true, duplicate: false, created: true, playlist: pl };
}

async function mRemoveTrack(userId, name, ref) {
  if (typeof ref === 'number' && ref > 0) {
    const rows = await colls.tracks.find({ userId, name }).sort({ addedAt: 1, _id: 1 }).toArray();
    const target = rows[ref - 1];
    if (!target) return 0;
    const del = await colls.tracks.deleteOne({ userId, name, url: target.url });
    return del.deletedCount;
  }
  const del = await colls.tracks.deleteOne({ userId, name, url: String(ref) });
  return del.deletedCount;
}

async function mListTracks(userId, name) {
  return colls.tracks.find({ userId, name }).sort({ addedAt: 1, _id: 1 }).toArray();
}

async function mListPlaylists(userId) {
  const [likedCount, custom] = await Promise.all([
    mTrackCount(userId, LIKED),
    colls.playlists.find({ userId }).sort({ created: 1 }).toArray(),
  ]);
  const out = [{ name: LIKED, label: 'Liked', tracks: likedCount, isDefault: true, created: 0 }];
  for (const p of custom) {
    const c = await mTrackCount(userId, p.name);
    out.push({ name: p.name, label: p.label || p.name, tracks: c, isDefault: false, created: p.created || 0 });
  }
  return out;
}

async function mRemovePlaylist(userId, name) {
  if (isReserved(name)) return { ok: false, error: 'reserved' };
  await colls.playlists.deleteOne({ userId, name });
  await colls.tracks.deleteMany({ userId, name });
  return { ok: true };
}

// ── Fallback helpers ────────────────────────────────────────────────────
function fbAddTrack(userId, track) {
  const u = String(userId);
  const url = String(track.url || '');
  if (!url) return { ok: false, error: 'missing url' };
  if (sqlite) {
    sqlInsertUser.run(u);
    const dup = !!sqlHas.get(u, url);
    const info = sqlInsert.run({
      user_id: u,
      title: String(track.title || 'Untitled'),
      url,
      duration: track.duration ? String(track.duration) : null,
      added_at: Date.now(),
    });
    return { ok: info.changes > 0, duplicate: dup };
  }
  const list = fbLiked(u).tracks;
  if (list.some((t) => t.url === url)) return { ok: true, duplicate: true, created: false };
  if (list.length >= PLAY_LIMIT) return { ok: false, error: 'limit' };
  list.push({ title: String(track.title || 'Untitled'), url, duration: track.duration ? String(track.duration) : null, addedAt: Date.now() });
  fbPersist();
  return { ok: true, duplicate: false, created: true };
}

function fbRemoveTrack(userId, ref) {
  const u = String(userId);
  if (sqlite) {
    if (isFinite(ref)) {
      const rows = sqlAll.all(u);
      const target = rows[Number(ref) - 1];
      if (!target) return 0;
      return sqlRemoveId.run(u, target.id).changes;
    }
    return sqlRemoveUrl.run(u, String(ref)).changes;
  }
  const list = fbLiked(u).tracks;
  if (isFinite(ref) && ref > 0) {
    if (ref > list.length) return 0;
    list.splice(Number(ref) - 1, 1);
  } else {
    const i = list.findIndex((t) => t.url === String(ref));
    if (i === -1) return 0;
    list.splice(i, 1);
  }
  fbPersist();
  return 1;
}

function fbList(userId) {
  const u = String(userId);
  if (sqlite) { sqlInsertUser.run(u); return sqlAll.all(u); }
  return fbLiked(u).tracks.map((t, i) => ({ id: i + 1, title: t.title, url: t.url, duration: t.duration, added_at: t.addedAt }));
}

function fbUpsertPlaylist(userId, name, label) {
  const store = fbUser(String(userId));
  const key = normName(name);
  if (isReserved(name)) return { name: key, label: 'Liked' };
  if (!store[key]) store[key] = { name: key, label, created: Date.now(), tracks: [] };
  fbPersist();
  return { name: key, label };
}

function fbAddTrackTo(userId, name, track, label) {
  if (isReserved(name)) {
    const r = fbAddTrack(userId, track);
    return { ...r, playlist: { name: LIKED, label: 'Liked' } };
  }
  const pl = fbUpsertPlaylist(userId, name, label);
  const store = fbUser(String(userId));
  const list = store[pl.name].tracks;
  const url = String(track.url || '');
  if (!url) return { ok: false, error: 'missing url', playlist: pl };
  if (list.some((t) => t.url === url)) return { ok: true, duplicate: true, created: false, playlist: pl };
  if (list.length >= PLAY_LIMIT) return { ok: false, error: 'limit', playlist: pl };
  list.push({ title: String(track.title || 'Untitled'), url, duration: track.duration ? String(track.duration) : null, addedAt: Date.now() });
  fbPersist();
  return { ok: true, duplicate: false, created: true, playlist: pl };
}

function fbListTracks(userId, name) {
  if (isReserved(name)) return fbList(userId);
  const store = fbUser(String(userId));
  const key = normName(name);
  const pl = store[key];
  if (!pl) return null;
  return (pl.tracks || []).map((t, i) => ({ id: i + 1, title: t.title, url: t.url, duration: t.duration, added_at: t.addedAt }));
}

function fbListPlaylists(userId) {
  const store = fbUser(String(userId));
  const liked = sqlite ? sqlAll.all(String(userId)).length : (fbLiked(String(userId)).tracks || []).length;
  const out = [{ name: LIKED, label: 'Liked', tracks: liked, isDefault: true, created: 0 }];
  for (const p of Object.values(store)) {
    out.push({ name: p.name, label: p.label || p.name, tracks: (p.tracks || []).length, isDefault: false, created: p.created || 0 });
  }
  return out;
}

function fbRemoveTrackFrom(userId, name, ref) {
  if (isReserved(name)) return fbRemoveTrack(userId, ref);
  const store = fbUser(String(userId));
  const key = normName(name);
  const pl = store[key];
  if (!pl) return 0;
  const list = pl.tracks || [];
  if (typeof ref === 'number' && ref > 0) {
    if (ref > list.length) return 0;
    list.splice(ref - 1, 1);
  } else {
    const i = list.findIndex((t) => t.url === String(ref));
    if (i === -1) return 0;
    list.splice(i, 1);
  }
  fbPersist();
  return 1;
}

function fbRemovePlaylist(userId, name) {
  if (isReserved(name)) return { ok: false, error: 'reserved' };
  const store = fbUser(String(userId));
  const key = normName(name);
  if (!store[key]) return { ok: false, error: 'missing' };
  delete store[key];
  fbPersist();
  return { ok: true };
}

// ── Public API (Mongo first, fallback behind) ───────────────────────────

/* Like / default playlist — used by the ❤️/👎 buttons (unchanged signature). */
async function addTrack(userId, track) {
  const up = await ensureMongo();
  if (up) return mAddTrack(userId, LIKED, track, 'Liked');
  return fbAddTrack(userId, track);
}

async function removeTrack(userId, ref) {
  const up = await ensureMongo();
  if (up) return mRemoveTrack(userId, LIKED, ref);
  return fbRemoveTrack(userId, ref);
}

async function list(userId) {
  const up = await ensureMongo();
  if (up) return mListTracks(userId, LIKED);
  return fbList(userId);
}

async function count(userId) {
  const up = await ensureMongo();
  if (up) return mTrackCount(userId, LIKED);
  return fbList(userId).length;
}

/* Custom + liked playlist management — used by /playlist. */
async function createPlaylist(userId, name) {
  const label = cleanLabel(name);
  const up = await ensureMongo();
  if (up) return mCreatePlaylist(userId, name, label);
  if (isReserved(name)) return { ok: true, isDefault: true };
  const store = fbUser(String(userId));
  const key = normName(name);
  if (store[key]) return { ok: false, error: 'exists' };
  store[key] = { name: key, label, created: Date.now(), tracks: [] };
  fbPersist();
  return { ok: true, isDefault: false };
}

async function addTrackTo(userId, name, track) {
  const label = cleanLabel(name);
  const up = await ensureMongo();
  if (up) return mAddTrack(userId, name, track, label);
  return fbAddTrackTo(userId, name, track, label);
}

async function listTracks(userId, name) {
  const up = await ensureMongo();
  if (up) return mListTracks(userId, normName(name));
  return fbListTracks(userId, name);
}

async function listPlaylists(userId) {
  const up = await ensureMongo();
  if (up) return mListPlaylists(userId);
  return fbListPlaylists(userId);
}

async function removePlaylist(userId, name) {
  const up = await ensureMongo();
  if (up) return mRemovePlaylist(userId, normName(name));
  return fbRemovePlaylist(userId, name);
}

async function removeTrackFrom(userId, name, ref) {
  const up = await ensureMongo();
  if (up) return mRemoveTrack(userId, normName(name), ref);
  return fbRemoveTrackFrom(userId, name, ref);
}

module.exports = {
  addTrack, removeTrack, list, count,
  createPlaylist, addTrackTo, listTracks, listPlaylists, removePlaylist, removeTrackFrom,
  LIKED, RESERVED, normName, isReserved,
};