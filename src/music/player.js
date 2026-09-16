/*
 * Peace✘ - Discord Bot
 * Developed by Smith.Code
 *
 * Music engine built on play-dl + @discordjs/voice + ffmpeg-static.
 *
 * Why not discord-player: v7.2.0 ships no YouTube extractor (the
 * @discord-player/youtube package does not exist on npm), so it could never
 * resolve YouTube — the exact "Extractor: N/A / No results found" failure we
 * hit live. This engine resolves every source play-dl supports (YouTube,
 * SoundCloud, Spotify bridge, direct URLs) and streams through ffmpeg.
 *
 * It keeps a compatibility queue object (module-level `getQueue`) so the
 * Components V2 UI, controls panel and commands keep working unchanged.
 */
const { EventEmitter } = require('events');
const path = require('path');
const playdl = require('play-dl');

// Bundled ffmpeg: prism-media resolves `ffmpeg-static` first, then falls back
// to `ffmpeg`/`avconv` on PATH. ffmpeg-static's official binary download is
// broken upstream (GitHub release removed -> 500), so we ship the binary from
// @ffmpeg-installer/ffmpeg (installed from the npm registry, no network fetch)
// and alias it behind the name prism looks for. If the bundled binary can't be
// spawned prism automatically continues to the PATH fallback.
const bundledFfmpeg = require('@ffmpeg-installer/ffmpeg');
if (bundledFfmpeg?.path) {
  const Module = require('module');
  const nativeLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'ffmpeg-static') return { version: bundledFfmpeg.version, path: bundledFfmpeg.path };
    return nativeLoad.call(this, request, ...rest);
  };
}

const prism = require('prism-media');
const ytDlp = require('yt-dlp-exec');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

const { sendLog } = require('../utils/logging');
const { applyCredentials } = require('./dlconf');

// Load play-dl credentials (YouTube cookies etc.) before any streaming.
// Ran without await so startup isn't blocked; failures are caught inside.
Promise.resolve(applyCredentials())
  .then((report) => {
    for (const line of report) console.log(`[PeaceX] [dlconf] ${line}`);
  })
  .catch(() => {});

// Repeat mode constants (mirror discord-player values so consumers are unchanged)
const QueueRepeatMode = { OFF: 0, TRACK: 1, QUEUE: 2, AUTOPLAY: 3 };
const QueryType = { AUTO: 'auto', YOUTUBE: 'youtube', SPOTIFY: 'spotify' };

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// Friendly preset -> ffmpeg filtergraph
const FILTERS = {
  bass: ['bass=g=6'],
  bassboost_low: ['bass=g=6'],
  bassboost: ['bass=g=10'],
  bassboost_high: ['bass=g=16'],
  '8d': ['apulsator=hz=0.12'],
  vaporwave: ['aresample=8000,asetrate=8000*0.8'],
  nightcore: ['asetrate=44100*1.3,aresample=44100'],
  lofi: ['asetrate=44100*0.92,aresample=44100,lowpass=f=3400'],
  earrape: ['volume=6'],
  karaoke: ['pan=stereo|c0=c0|c1=-1*c1'],
  slow: ['atempo=0.85'],
  tremolo: ['tremolo=f=5:d=0.6'],
  vibrato: ['vibrato=f=6:d=0.5'],
  surround: ['surround'],
  subboost: ['asubboost'],
  mono: ['pan=mono|c0=0.5*c0+0.5*c1'],
  normalizer: ['dynaudnorm'],
  compressor: ['acompressor'],
  electronic: ['equalizer=f=80:t=q:w=1:g=5,equalizer=f=1200:t=q:w=1:g=3,equalizer=f=8000:t=q:w=1:g=5'],
  equalizer: ['equalizer=f=100:t=q:w=1:g=3,equalizer=f=1000:t=q:w=1:g=2,equalizer=f=8000:t=q:w=1:g=3'],
  party: ['equalizer=f=180:t=q:w=1:g=4,equalizer=f=800:t=q:w=1:g=5,equalizer=f=5000:t=q:w=1:g=3'],
  pop: ['equalizer=f=120:t=q:w=1:g=-2,equalizer=f=1000:t=q:w=1:g=4,equalizer=f=4000:t=q:w=1:g=5'],
  radio: ['equalizer=f=120:t=q:w=1:g=3,equalizer=f=1000:t=q:w=1:g=4,equalizer=f=5000:t=q:w=1:g=3'],
  soft: ['lowpass=f=5000,volume=0.9'],
  speed: ['atempo=1.25'],
  treblebass: ['bass=g=5,treble=g=4'],
};

const QUEUE_LIMIT = 500;

class MusicManager extends EventEmitter {
  constructor(client = null) {
    super();
    this.client = client;
    this.sessions = new Map(); // guildId -> session
    this.stayConnected = new Set();
    this.initiated = false;
  }

  ensurePlayer() {
    this.initiated = true;
    return this;
  }

  getPlayer() {
    return this.ensurePlayer();
  }

  /** Thin wrapper so existing code expecting `queue`/`track` still works. */
  async play(guild, voiceChannel, query, requestedBy = 'someone', sessionRequester = null, options = {}) {
    const result = await this.ensureConnected(guild, voiceChannel, { requestedBy, sessionRequester });
    const sess = this.sessions.get(guild.id);
    this.markRequested(sess, requestedBy, sessionRequester);

    // Legacy wrappers call player.play(...). Route through here.
    const resolved = await this.resolve(query);
    const track = this.toTrack({ ...resolved, mixUrl: options.mixUrl || null }, requestedBy);
    if (sess.current) {
      this.enqueue(guild.id, track);
      return { track, queue: this.getQueue(guild.id) };
    }
    await this.startTrack(guild.id, track);
    return { track, queue: this.getQueue(guild.id) };
  }

  /** True while a live-radio track is the current track in this guild. */
  isRadioActive(guildId) {
    const sess = this.sessions.get(guildId);
    return !!(sess && sess.current && sess.current.source === 'radio');
  }

  /**
   * Start an endless live-radio track (24/7 + TRACK repeat so a stream drop
   * re-plays the same station instead of stopping). Flushes any normal
   * music that was playing.
   */
  async startRadio(guild, voiceChannel, track) {
    const sess = await this.ensureConnected(guild, voiceChannel, {
      requestedBy: track.requestedBy || 'someone',
      sessionRequester: track.sessionRequester || null,
    });
    if (sess.current && sess.current.source !== 'radio') this.stop(guild.id);
    sess.repeatMode = QueueRepeatMode.TRACK;
    this.stayConnected.add(guild.id);
    if (track.sessionRequester) sess.metadata.sessionRequester = track.sessionRequester;
    sess.metadata.channel = voiceChannel;
    await this.startTrack(guild.id, track);
    return sess;
  }

  async ensureConnected(guild, voiceChannel, meta, canRetry = true) {
    let sess = this.sessions.get(guild.id);
    if (!sess || !sess.connection || sess.connection.state.status === VoiceConnectionStatus.Destroyed) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      // Watchdog: if a track is playing but the voice connection gets stuck
      // (e.g. endless connecting<->signalling from a failed UDP handshake or a
      // stale voice server), abort playback loudly instead of leaving a silent
      // "playing" session that the panel keeps showing as active.
      let watchdog = null;
      const armWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          const cs = this.sessions.get(guild.id);
          if (cs?.connection === connection && cs.current && connection.state.status !== VoiceConnectionStatus.Ready) {
            this.log(guild.id, 'Voice watchdog: connection stuck while music is active — aborting to avoid silent audio.');
            this.abortPlayback(guild.id, 'Voice connection stalled; playback was interrupted. Try playing again.');
          }
        }, 12000);
        if (watchdog.unref) watchdog.unref();
      };
      const clearWatchdog = () => { clearTimeout(watchdog); watchdog = null; };

      connection.on(VoiceConnectionStatus.Disconnected, () => {
        // Keep music alive: if a track is active (or 24/7 is on), rejoin the
        // channel. Otherwise tear everything down so we never leave a dead
        // session that pretends to be "playing" (silent audio).
        const sess = this.sessions.get(guild.id);
        if (this.isStayConnected(guild.id) || sess?.current) {
          // A dropped connection after a play session automatically switches
          // the bot into 24/7 mode so it returns to the previously joined
          // channel and keeps sitting there until the owner runs /24-7 end.
          if (sess) this.stayConnected.add(guild.id);
          this.reconnectVoice(guild.id, connection);
          return;
        }
        this.sessions.delete(guild.id);
        connection.destroy();
      });
      connection.on(VoiceConnectionStatus.Ready, () => {
        // Re-subscribe after reconnect — a new networking stack is created on
        // every ready transition and the old subscription may be stale.
        const s = this.sessions.get(guild.id);
        if (s?.audioPlayer) {
          const existing = connection.state.subscription;
          if (!existing || existing.player !== s.audioPlayer) {
            connection.subscribe(s.audioPlayer);
            this.log(guild.id, '[voice] Re-subscribed audioPlayer after connection became ready.');
          }
        }
      });
      connection.on('stateChange', (o, n) => {
        if (o.status !== n.status) this.log(guild.id, `Voice: ${o.status} -> ${n.status}`);
        if (n.status === VoiceConnectionStatus.Ready) {
          clearWatchdog();
        } else if (this.sessions.get(guild.id)?.current) {
          armWatchdog();
        }
      });
      connection.on('error', (err) => {
        this.log(guild.id, `Voice error: ${err.message}`);
      });
      // IMPORTANT: Use Pause (not Play) so the player actually pauses/stops
      // when Discord isn't ready to receive audio. With Play, the player
      // continues "playing" into nothing and pcmChunks show > 0 even though
      // Discord receives zero packets — exactly the "bot connects, no audio" bug.
      const audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
      const subscription = connection.subscribe(audioPlayer);
      if (!subscription) this.log(guild.id, '[voice] WARN: connection.subscribe returned null');
      this.attachAudioHandlers(guild.id, audioPlayer);
      sess = {
        guildId: guild.id,
        guild,
        channel: voiceChannel,
        connection,
        audioPlayer,
        current: null,
        queue: [],
        history: [],
        volume: 70,
        repeatMode: QueueRepeatMode.OFF,
        paused: false,
        autoplay: false,
        filters: [],
        metadata: { channel: voiceChannel, requestedBy: meta?.requestedBy || 'someone', sessionRequester: meta?.sessionRequester || null },
        leavingTimer: null,
        mutedVol: null,
      };
      this.sessions.set(guild.id, sess);
    } else {
      sess.metadata.channel = voiceChannel;
    }
    this.markSeen(guild.id);
    const voiceConnection = sess.connection;
    try {
      await entersState(voiceConnection, VoiceConnectionStatus.Ready, 15000);
    } catch (err) {
      const stuck = voiceConnection.state.status;
      this.log(guild.id, `Voice connection timed out (status ${stuck}): ${err.message}`);
      if (canRetry && (stuck === VoiceConnectionStatus.Signalling || stuck === VoiceConnectionStatus.Connecting || stuck === VoiceConnectionStatus.Disconnected)) {
        this.log(guild.id, 'Discarding stale voice connection and retrying once.');
        voiceConnection.destroy();
        if (this.sessions.get(guild.id)?.connection === voiceConnection) this.sessions.delete(guild.id);
        return this.ensureConnected(guild, voiceChannel, meta, false);
      }
      const hint =
        stuck === VoiceConnectionStatus.Signalling || stuck === VoiceConnectionStatus.Connecting
          ? "Check that I have View Channel + Connect/Speak permission in this voice channel, and that the server region is reachable."
          : 'Voice connection failed unexpectedly.';
      throw new Error(`Could not connect to the voice channel (${stuck}). ${hint}`);
    }
    return sess;
  }

  /** Resolve an arbitrary query into a playable { url, title, author, durationMS, thumbnail, source }. */
  async resolve(query) {
    const q = String(query || '').trim();
    if (!q) throw new Error('No query provided.');

    // local file on disk
    try {
      const fs = require('fs');
      if (fs.existsSync(q) && fs.statSync(q).isFile()) {
        return { url: q, title: require('path').basename(q).replace(/\.[^.]+$/, ''), author: null, durationMS: 0, thumbnail: null, source: 'file' };
      }
    } catch { /* fall through */ }

    if (URL_RE.test(q)) {
      return this.resolveUrl(q);
    }
    // plain text -> youtube search (yt-dlp, since play-dl search is blocked)
    const res = await this.ytdlpSearch(q, 1);
    if (!res?.length) throw new Error(`No results found for "${q}"`);
    return res[0];
  }

  /**
   * Turn a /mix side-sound into something ffmpeg can read as a second input:
   *  - local file / direct audio URL -> returned as-is
   *  - song name / YouTube / SoundCloud -> resolved and downloaded to a temp file
   * Returns a path or URL that can be passed as `-i <x>` to ffmpeg.
   */
  async downloadSideSound(query) {
    const resolved = await this.resolve(query);
    if (resolved.source === 'file' || resolved.source === 'direct' || resolved.source === 'radio') {
      return resolved.url;
    }
    const fs = require('fs');
    const os = require('os');
    const dir = path.join(os.tmpdir(), 'peace-mix');
    fs.mkdirSync(dir, { recursive: true });
    const prefix = `side-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const flags = {
      format: 'ba',
      output: path.join(dir, `${prefix}.%(ext)s`),
      noWarnings: true,
      noProgress: true,
    };
    const cookiesFile = path.join(path.resolve(__dirname, '..', '..'), 'cookies.txt');
    if (fs.existsSync(cookiesFile)) flags.cookies = cookiesFile;
    await ytDlp(resolved.url, flags, { timeout: 120000 }).catch((e) => {
      throw new Error(`Could not download side sound: ${e.message}`);
    });
    const produced = fs.readdirSync(dir)
      .map((n) => path.join(dir, n))
      .find((p) => path.basename(p).startsWith(prefix));
    if (!produced) throw new Error('Could not download side sound.');
    setTimeout(() => {
      try { fs.unlinkSync(produced); } catch {}
    }, 30 * 60 * 1000);
    return produced;
  }

  async resolveUrl(url) {
    const u = url.toLowerCase();
    if (u.includes('discord.gg/') || u.includes('discord.com/invite/')) {
      throw new Error('That is a Discord invite, not a playable song. Use a song name or a YouTube/SoundCloud URL.');
    }
    if (u.includes('youtube.com') || u.includes('youtu.be')) {
      const info = await playdl.video_info(url).catch((e) => {
        throw new Error(`Could not resolve YouTube video: ${e.message}`);
      });
      return this.videoMeta(info.video_details);
    }
    if (u.includes('soundcloud.com')) {
      const data = await playdl.soundcloud(url).catch(() => null);
      if (!data) throw new Error(`Could not resolve SoundCloud track: "${url}"`);
      return {
        url, title: data.name, author: data.user?.name, durationMS: (data.durationInMs || 0),
        thumbnail: data.thumbnail || null, source: 'soundcloud',
      };
    }
    if (u.includes('open.spotify.com') || u.includes('spotify.')) {
      throw new Error('Spotify links need a matching YouTube/SoundCloud track — use /spotify or /play with a name.');
    }
    // direct media file
    return { url, title: url, author: null, durationMS: 0, thumbnail: null, source: 'direct' };
  }

  videoMeta(v) {
    if (!v) throw new Error('No results found for that query.');
    let durMS = 0;
    if (typeof v.durationInSec === 'number') durMS = Math.round(v.durationInSec * 1000);
    else if (v.durationSec) durMS = Number(v.durationSec) * 1000;
    return {
      url: v.url || v.id,
      title: v.title || 'Untitled',
      author: v.channel?.name || v.author?.name || null,
      durationMS: durMS,
      thumbnail: v.thumbnails?.highest?.url || v.thumbnail || null,
      source: 'youtube',
    };
  }

  toTrack(src, requestedBy) {
    return { ...src, requestedBy };
  }

  /** Search top-N results (for pickers). Returns { tracks: [TrackShapes] }. */
  async search(query, opts = {}) {
    const engine = (opts.searchEngine || 'auto').toLowerCase();
    if (engine.includes('spotify') || engine.includes('sp')) {
      try {
        const res = await playdl.spotify(query).catch(() => null);
        const list = Array.isArray(res) ? res : res?.tracks;
        if (list?.length) {
          return { tracks: list.slice(0, 5).map((t) => this.toTrack({ url: t.url, title: t.name, author: t.artist?.name, durationMS: t.durationInMs || 0, thumbnail: t.thumbnail || null, source: 'spotify' }), 'someone') };
        }
      } catch {
        /* fall through to youtube search */
      }
      const yt = await this.ytdlpSearch(query, 5);
      return { tracks: yt.map((v) => this.toTrack(v, 'someone')) };
    }
    const res = await this.ytdlpSearch(query, opts.limit || 5);
    return { tracks: res.slice(0, 5).map((v) => this.toTrack(v, 'someone')) };
  }

  // ── Queue mutation helpers ──────────────────────────────────────────
  enqueue(guildId, track) {
    const sess = this.sessions.get(guildId);
    if (!sess) return false;
    if (sess.queue.length >= QUEUE_LIMIT) return false;
    sess.queue.push(track);
    return true;
  }

  async startTrack(guildId, track) {
    const sess = this.sessions.get(guildId);
    if (!sess) return;
    sess.current = track;
    try {
      await this.playCurrent(guildId);
    } catch (err) {
      this.log(guildId, `Playback error: ${err.message}`);
      this.autoNext(guildId);
      throw err;
    }
    this.emit('playerStart', this.getQueue(guildId));
    const { refreshPanel } = require('./nowPlaying');
    refreshPanel(this.client, guildId).catch(() => {});
  }

  async playCurrent(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess?.current) return;
    const track = sess.current;

    let audioStream;
    try {
      audioStream = await this.streamSource(track).catch((e) => {
        throw e;
      });
    } catch (err) {
      this.log(guildId, `Could not fetch stream for ${track.title}: ${err.message}`);
      throw err;
    }

    if (!audioStream) {
      this.log(guildId, `No audio stream available for ${track.title}.`);
      throw new Error('No audio stream available.');
    }
    const rawStream = audioStream.stream || audioStream;

    // Build ffmpeg pipeline: decode + apply filters -> raw PCM 48k.
    // IMPORTANT: use `-f s16le` (raw PCM), NOT `-f opus` — ffmpeg's `-f opus`
    // wraps frames in an Ogg container (OggS + OpusHead/OpusTags) which
    // @discordjs/voice cannot decode as raw opus -> silent audio. We encode the
    // PCM to raw opus with prism.opus.Encoder (libopus) exactly as Discord wants.
    // Live volume (/volume, controls) is handled by the resource's inline
    // volume transformer so changes take effect on the current track, not just
    // the next one.
    const filterArgs = this.buildFilterArgs(sess);

    const ffmpegArgs = ['-loglevel', 'error', '-i', 'pipe:0'];
    if (track.mixUrl) ffmpegArgs.push('-i', track.mixUrl, '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2');
    ffmpegArgs.push('-vn', '-f', 's16le', '-ar', '48000', '-ac', '2');
    if (filterArgs.length) ffmpegArgs.splice(ffmpegArgs.length - 6, 0, '-af', filterArgs.join(','));
    // NOTE: do NOT add trailing "pipe:1" — prism.FFmpeg appends it automatically.

    const ffmpeg = new prism.FFmpeg({ args: ffmpegArgs });
    rawStream.pipe(ffmpeg);
    rawStream.on('error', (err) => {
      this.log(guildId, `Audio source error for ${track.title}: ${err.message}`);
      try { ffmpeg.destroy(); } catch {}
    });
    ffmpeg.on('error', (err) => {
      this.log(guildId, `FFmpeg error for ${track.title}: ${err.message}`);
    });

    // Let @discordjs/voice perform the PCM -> Opus encoding. Feeding it the
    // raw PCM stream avoids an extra encoder layer that can end the resource
    // while packets are still being produced.
    const resource = createAudioResource(ffmpeg, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(sess.volume / 100);
    resource.metadata = track;
    const player = sess.audioPlayer;
    player.play(resource);
    sess.paused = false;

    // Runtime diagnostic: confirm PCM chunks flow AND player reaches 'playing' after 6s.
    // Catches two failure modes:
    //  1. pcmChunks === 0 — yt-dlp failed, no audio data at all.
    //  2. playerState === 'buffering' — data flows but Discord won't pull it
    //     (connection dropped, subscription lost, or NoSubscriberBehavior issue).
    // In both cases: notify channel + auto-skip.
    let pcmChunks = 0;
    ffmpeg.on('data', () => { pcmChunks++; });
    const diagTimer = setTimeout(() => {
      const connState = sess.connection?.state.status || 'none';
      const playerState = player.state.status;
      this.log(guildId, `[diag] pcmChunks=${pcmChunks}, playerState=${playerState}, connState=${connState}, resource=${resource.playStream.readableEnded ? 'ended' : 'open'}`);
      
      const silent = pcmChunks === 0;
      const stuck  = playerState === 'buffering' && pcmChunks > 0;
      
      if (silent || stuck) {
        const reason = silent
          ? `yt-dlp produced no data for "${track.title}"`
          : `audioPlayer stuck in buffering for "${track.title}" (connState=${connState})`;
        this.log(guildId, `[diag] FATAL: ${reason}. Auto-skipping.`);
        const ch = sess.metadata?.channel;
        if (ch?.isTextBased?.()) {
          const { errorEmbed } = require('../utils/decorations');
          ch.send({
            embeds: [errorEmbed({
              title: 'Playback Failed',
              description: silent
                ? `Could not stream **${track.title || 'this track'}**.\nYouTube may have blocked the request — try again or use a different song.`
                : `Audio got stuck for **${track.title || 'this track'}** (voice connection issue).\nAuto-skipping — try \`/play\` again if needed.`,
            })],
          }).catch(() => {});
        }
        try { ffmpeg.destroy(); } catch {}
        try { rawStream.destroy(); } catch {}
        player.stop(true);
        this.autoNext(guildId);
      } else if (connState !== 'ready') {
        this.log(guildId, `[diag] WARN: connection not ready (state=${connState}) — audio may not reach Discord.`);
      }
    }, 20000);
    diagTimer.unref();
    const diagHandler = (o, n) => {
      if (n.status === 'playing') {
        this.log(guildId, '[diag] audioPlayer reached playing');
        player.off('stateChange', diagHandler);
      }
    };
    player.on('stateChange', diagHandler);
  }

  /** Produce the raw audio Readable for a track. Local files -> read stream; radio -> plain HTTP(S); everything else -> yt-dlp. */
  async streamSource(track, opts = {}) {
    if (track.source === 'file') {
      return { stream: require('fs').createReadStream(track.url) };
    }
    if (track.source === 'radio') {
      return this.streamRadio(track.url);
    }
    return this.spawnYtdlp(track.url, opts);
  }

  /**
   * Live radio (Icecast/Shoutcast/Zeno) streams are infinite and change
   * server-to-server, so they are streamed with a plain HTTP(S) GET instead of
   * yt-dlp (which would buffer/croak on endless streams). `Icy-MetaData: 0`
   * stops the server from interleaving song-title metadata into the MP3 frames
   * (that metadata corrupts ffmpeg decoding).
   */
  streamRadio(url) {
    const mod = /^https:/i.test(String(url || '')) ? require('https') : require('http');
    const stream = new (require('stream').PassThrough)();
    const done = (code) => {
      stream.emit('error', new Error(`Radio stream returned HTTP ${code}`));
    };
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (PeaceX Music)', // some servers 403 default UAs
        'Icy-MetaData': '0',
        Accept: '*/*',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return done(res.statusCode);
      }
      res.on('error', () => {});
      res.pipe(stream);
    });
    req.setTimeout(15000, () => req.destroy());
    req.on('error', () => {}); // surfaced via the stream
    (stream).on('error', () => {});
    return { stream };
  }

  /**
   * Spawn yt-dlp to stream a track's audio to stdout (a Readable).
   * yt-dlp is used (not play-dl.stream) because YouTube now requires a per-video
   * PO token; play-dl does not support PO tokens and returns empty URLs. yt-dlp
   * is updated almost daily to keep up with YouTube's anti-scraping changes, and
   * it accepts the same cookies.txt we build from cookies.json.
   */
  spawnYtdlp(url, opts = {}) {
    const child = ytDlp.exec(url, this.ytdlpFlags(opts), { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr = `${stderr}${text}`.slice(-2000);
      // Surface yt-dlp errors in real time (non-progress lines only)
      if (text.trim() && !text.includes('[download]') && !text.includes('[info]')) {
        this.log?.('unknown', `[yt-dlp] ${text.trim()}`);
      }
    });
    child.on('error', (err) => {
      this.log?.('unknown', `[yt-dlp] spawn error: ${err.message}`);
      child.stdout.destroy(err);
    });
    child.on('close', (code) => {
      if (code !== 0 && !child.stdout.destroyed) {
        const reason = stderr.trim() || `yt-dlp exited with code ${code}`;
        this.log?.('unknown', `[yt-dlp] non-zero exit (${code}): ${reason}`);
        child.stdout.destroy(new Error(reason));
      }
    });
    return { stream: child.stdout };
  }

  /** Build yt-dlp flags for the bundled executable shipped by yt-dlp-exec. */
  ytdlpFlags(opts = {}) {
    // NOTE: do NOT set quiet:true — suppressing stderr hides yt-dlp errors and
    // makes silent audio failures undiagnosable. noWarnings + noProgress are
    // enough to reduce noise without hiding actual errors.
    // 'ba' strictly requests best audio only. Do not fallback to 'b' (video).
    const flags = { noWarnings: true, noProgress: true, format: 'ba', output: '-' };
    const cookiesFile = path.join(path.resolve(__dirname, '..', '..'), 'cookies.txt');
    if (require('fs').existsSync(cookiesFile)) flags.cookies = cookiesFile;
    if (opts.seekSeconds) flags.downloadSections = `*${opts.seekSeconds}-`;
    return flags;
  }

  /**
   * Search YouTube via yt-dlp (not play-dl — play-dl's search is blocked by
   * YouTube's anti-bot changes, the same reason streaming uses yt-dlp).
   * Returns track shapes: { url, title, author, durationMS, duration, thumbnail, source }.
   */
  async ytdlpSearch(query, limit = 5) {
    const searchQuery = `ytsearch${Math.max(1, limit)}:${String(query || '').trim()}`;
    const flags = { noWarnings: true, noProgress: true, quiet: true, flatPlaylist: true, dumpSingleJson: true };
    const cookiesFile = path.join(path.resolve(__dirname, '..', '..'), 'cookies.txt');
    if (require('fs').existsSync(cookiesFile)) flags.cookies = cookiesFile;
    const tracks = await ytDlp(searchQuery, flags, { timeout: 20000 }).then((data) => (data?.entries || []).map((e) => {
            const id = e?.id;
            return {
              url: id ? `https://www.youtube.com/watch?v=${id}` : (e?.url || null),
              title: e?.title || 'Untitled',
              author: e?.uploader || e?.channel || null,
              durationMS: e?.duration ? Math.round(e.duration * 1000) : 0,
              duration: e?.duration ? this.fmtDuration(e.duration * 1000) : null,
              thumbnail: e?.thumbnails?.[e.thumbnails.length - 1]?.url || null,
              source: 'youtube',
            };
          }).filter((t) => t.url)).catch(() => []);
    return tracks;
  }

  fmtDuration(ms) {
    if (!ms) return null;
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  buildFilterArgs(sess) {
    const out = [];
    for (const f of sess.filters) {
      const got = FILTERS[f];
      if (got) out.push(...got);
    }
    return out;
  }

  attachAudioHandlers(guildId, audioPlayer) {
    audioPlayer.on('stateChange', (oldS, newS) => {
      if (newS.status === AudioPlayerStatus.Idle && oldS.status === AudioPlayerStatus.Playing) {
        this.onTrackEnd(guildId);
      }
    });
    audioPlayer.on('error', (err) => {
      this.log(guildId, `Audio error: ${err.message}`);
    });
  }

  onTrackEnd(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess) return;
    if (sess.paused) return;

    if (sess.current) sess.history.unshift(sess.current);
    if (sess.history.length > 50) sess.history.length = 50;

    // repeat track
    if (sess.repeatMode === QueueRepeatMode.TRACK && sess.current) {
      this.playCurrent(guildId).catch(() => this.autoNext(guildId));
      return;
    }
    const next = sess.queue.shift();
    if (next) {
      this.startTrack(guildId, next);
      return;
    }
    // repeat queue
    if (sess.repeatMode === QueueRepeatMode.QUEUE && sess.history.length) {
      sess.queue.push(...sess.history);
      sess.history = [];
      const n = sess.queue.shift();
      if (n) { this.startTrack(guildId, n); return; }
    }
    if (sess.repeatMode === QueueRepeatMode.AUTOPLAY) {
      this.autoplayNext(guildId);
      return;
    }
    sess.current = null;
    this.emit('emptyQueue', this.getQueue(guildId));
    this.scheduleAutoLeave({ guild: { id: guildId } });
    const { refreshPanel } = require('./nowPlaying');
    refreshPanel(this.client, guildId).catch(() => {});
  }

  // Recover from a stream or decoder failure without leaving a dead track.
  autoNext(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess) return;
    const next = sess.queue.shift();
    if (next) {
      this.startTrack(guildId, next);
      return;
    }
    sess.current = null;
    this.emit('emptyQueue', this.getQueue(guildId));
    this.scheduleAutoLeave({ guild: { id: guildId } });
    const { refreshPanel } = require('./nowPlaying');
    refreshPanel(this.client, guildId).catch(() => {});
  }

  async autoplayNext(guildId) {
    const sess = this.sessions.get(guildId);
    const ref = sess?.current;
    if (!ref) return;
    try {
      const res = await this.ytdlpSearch(`${ref.title} ${ref.author || ''}`, 5);
      const pick = res[Math.floor(Math.random() * Math.min(3, res.length))];
      if (!pick) return;
      const t = this.toTrack(pick, 'autoplay');
      sess.queue.push(t);
    } catch {}
    this.onTrackEnd(guildId);
  }

  // ── Control surface (compat with existing commands/router) ──────────
  getQueue(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess) return null;
    return makeQueueCompat(sess, this);
  }

  markSeen(guildId) { /* 24/7 uses stayConnected */ }

  toggle247(guildId) {
    if (this.stayConnected.has(guildId)) { this.stayConnected.delete(guildId); return false; }
    this.stayConnected.add(guildId);
    return true;
  }
  /** Explicitly set 24/7 on/off. Returns the resulting state. */
  set247(guildId, enabled) {
    if (enabled) { this.stayConnected.add(guildId); return true; }
    this.stayConnected.delete(guildId);
    return false;
  }
  isStayConnected(guildId) { return this.stayConnected.has(guildId); }

  handleVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild?.id || oldState.guild?.id;
    const sess = guildId ? this.sessions.get(guildId) : null;
    if (!sess) return;

    const trackedChannelId = sess.channel?.id;
    if (!trackedChannelId || (oldState.channelId !== trackedChannelId && newState.channelId !== trackedChannelId)) return;

    // ── The bot's own voice state changed (moved or kicked by a member) ──
    const meId = this.client?.user?.id;
    if (meId && (oldState.member?.id === meId || newState.member?.id === meId)) {
      if (newState.channelId === null) {
        // Kicked / pulled out of the channel while a session exists: enable
        // 24/7 and return to the previously joined channel so the bot keeps
        // sitting in voice until the owner ends 24/7.
        this.log(guildId, '[voice] Bot was removed from the channel — enabling 24/7 and returning.');
        this.stayConnected.add(guildId);
        const conn = sess.connection;
        if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) {
          this.reconnectVoice(guildId, conn);
        }
      } else if (newState.channelId !== trackedChannelId) {
        // Moved into another channel by a member — follow it so auto-leave and
        // reconnect tracking stay correct (no forced 24/7, no channel-fighting).
        const ch = sess.guild?.channels?.cache?.get(newState.channelId);
        if (ch?.isVoiceBased?.()) { sess.channel = ch; sess.metadata.channel = ch; }
        this.log(guildId, `[voice] Moved to channel ${newState.channelId} — tracking updated.`);
      }
      return;
    }

    // Let Discord update the channel member cache before deciding whether the
    // bot is alone. This also handles a member moving between voice channels.
    setTimeout(() => {
      const current = this.sessions.get(guildId);
      const channel = current?.channel?.guild?.channels?.cache?.get(trackedChannelId);
      if (!current || !channel) return;
      const humanMembers = channel.members.filter((member) => !member.user.bot);
      if (humanMembers.size > 0) return;

      // 24/7 explicitly keeps the bot connected even when the channel is empty.
      if (this.isStayConnected(guildId)) return;

      this.stayConnected.delete(guildId);
      this.stop(guildId);
      this.leave(guildId);
      this.log(guildId, 'Music stopped and voice channel left because no human members remained.');
    }, 250).unref();
  }

  reconnectVoice(guildId, connection) {
    const sess = this.sessions.get(guildId);
    if (!sess || sess.reconnecting || connection.state.status === VoiceConnectionStatus.Destroyed) return;
    sess.reconnecting = true;
    let attempts = 0;
    const retry = async () => {
      if (!sess.reconnecting) return;
      try {
        if (connection.state.status === VoiceConnectionStatus.Destroyed) return;
        connection.rejoin({ channelId: sess.channel.id, selfDeaf: true, selfMute: false });
        await entersState(connection, VoiceConnectionStatus.Ready, 15000);
        sess.reconnecting = false;
        this.log(guildId, 'Voice connection restored.');
      } catch (err) {
        attempts += 1;
        this.log(guildId, `Voice reconnect attempt ${attempts} failed: ${err.message}`);
        if (attempts < 3) {
          setTimeout(retry, 2000 * attempts).unref();
        } else if (this.isStayConnected(guildId)) {
          sess.reconnecting = false;
          this.log(guildId, 'Voice reconnect failed — 24/7 mode keeps the bot alive, retrying silently every 30s.');
          const timer = setTimeout(() => {
            const s = this.sessions.get(guildId);
            if (s && this.isStayConnected(guildId)) this.reconnectVoice(guildId, connection);
          }, 30000);
          if (timer.unref) timer.unref();
        } else {
          sess.reconnecting = false;
          this.log(guildId, 'Giving up on voice reconnect — stopping playback.');
          this.abortPlayback(guildId, 'Voice connection was lost and could not be restored. Playback stopped.');
        }
      }
    };
    retry();
  }

  markRequested(sess, requestedBy, sessionRequester) {
    if (requestedBy) sess.metadata.requestedBy = requestedBy;
    if (sessionRequester) sess.metadata.sessionRequester = sessionRequester;
  }

  setVolume(guildId, percent) {
    const sess = this.sessions.get(guildId);
    if (!sess) return false;
    sess.volume = Math.max(0, Math.min(1000, percent));
    const res = sess.audioPlayer?.state?.resource;
    if (res?.volume) res.volume.setVolume(sess.volume / 100);
    return true;
  }

  togglePause(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess || !sess.current) return null;
    if (sess.paused) { sess.audioPlayer.unpause(); sess.paused = false; return false; }
    sess.audioPlayer.pause(); sess.paused = true; return true;
  }

  setPause(guildId, paused) {
    const sess = this.sessions.get(guildId);
    if (!sess) return false;
    if (paused && !sess.paused) { sess.audioPlayer.pause(); sess.paused = true; }
    else if (!paused && sess.paused) { sess.audioPlayer.unpause(); sess.paused = false; }
    return true;
  }

  async skip(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess?.current) return false;
    const next = sess.queue.shift();
    if (next) { this.startTrack(guildId, next); return true; }
    if (sess.repeatMode === QueueRepeatMode.TRACK || sess.repeatMode === QueueRepeatMode.QUEUE) {
      this.onTrackEnd(guildId); return true;
    }
    sess.audioPlayer.stop(true);
    return true;
  }

  stop(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess) return false;
    sess.queue = [];
    sess.repeatMode = QueueRepeatMode.OFF;
    sess.audioPlayer.stop(true);
    sess.current = null;
    this.emit('emptyQueue', this.getQueue(guildId));
    return true;
  }

  previous(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess?.history?.length) return false;
    const prev = sess.history.shift();
    if (sess.current) sess.queue.unshift(sess.current);
    this.startTrack(guildId, prev);
    return true;
  }

  async seek(guildId, seconds) {
    const sess = this.sessions.get(guildId);
    if (!sess?.current) return false;
    // re-stream with -ss offset via ffmpeg (yt-dlp supplies the raw audio)
    try {
      const audioStream = await this.streamSource(sess.current, {}).catch(() => null);
      if (!audioStream) return false;
      const ss = Math.max(0, Math.floor(seconds));
      const ffmpeg = new prism.FFmpeg({
        args: ['-loglevel', 'error', '-ss', String(ss), '-i', 'pipe:0', '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2'],
      });
      (audioStream.stream || audioStream).pipe(ffmpeg);
      const resource = createAudioResource(ffmpeg, { inputType: StreamType.Raw, inlineVolume: true });
      resource.volume?.setVolume(sess.volume / 100);
      sess.audioPlayer.play(resource);
      return true;
    } catch { return false; }
  }

  shuffle(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess?.queue?.length) return false;
    for (let i = sess.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sess.queue[i], sess.queue[j]] = [sess.queue[j], sess.queue[i]];
    }
    return true;
  }

  cycleRepeat(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess) return null;
    const next = {
      [QueueRepeatMode.OFF]: QueueRepeatMode.TRACK,
      [QueueRepeatMode.TRACK]: QueueRepeatMode.QUEUE,
      [QueueRepeatMode.QUEUE]: QueueRepeatMode.OFF,
    };
    const mode = next[sess.repeatMode] ?? QueueRepeatMode.OFF;
    sess.repeatMode = mode;
    return mode;
  }

  setRepeat(guildId, mode) {
    const sess = this.sessions.get(guildId);
    if (!sess) return false;
    sess.repeatMode = mode;
    return true;
  }

  toggleAutoplay(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess) return null;
    sess.repeatMode = QueueRepeatMode.AUTOPLAY;
    return QueueRepeatMode.AUTOPLAY;
  }

  clearQueue(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess) return false;
    sess.queue = [];
    return true;
  }

  removeAt(guildId, index) {
    const sess = this.sessions.get(guildId);
    if (!sess?.queue?.[index]) return false;
    sess.queue.splice(index, 1);
    return true;
  }

  setFilter(guildId, preset) {
    const sess = this.sessions.get(guildId);
    if (!sess) return null;
    const ids = FILTERS[preset] ? [preset] : null;
    if (!ids) return null;
    sess.filters = [preset];
    return ids;
  }

  clearFilters(guildId) {
    const sess = this.sessions.get(guildId);
    if (!sess) return false;
    sess.filters = [];
    return true;
  }

  getActiveFilters(guildId) {
    return this.sessions.get(guildId)?.filters || [];
  }

  // Effects are applied when the next resource is created. Rebuilding the
  // current resource here would restart the song and create an audible gap.
  reapplyEffects() {}

  scheduleAutoLeave(queue) {
    const guildId = queue?.guild?.id;
    if (!guildId) return;
    if (this.isStayConnected(guildId)) return;
    this.clearLeavingTimer(guildId);
    const sess = this.sessions.get(guildId);
    if (sess) {
      sess.leavingTimer = setTimeout(() => {
        const s = this.sessions.get(guildId);
        if (s && !s.current && !s.queue.length) this.leave(guildId);
      }, 120000);
    }
  }

  clearLeavingTimer(guildId) {
    const sess = this.sessions.get(guildId);
    if (sess?.leavingTimer) { clearTimeout(sess.leavingTimer); sess.leavingTimer = null; }
  }

  leave(guildId) {
    const sess = this.sessions.get(guildId);
    const { clearPanel } = require('./nowPlaying');
    clearPanel(guildId);
    if (sess) {
      sess.audioPlayer?.stop(true);
      sess.connection?.destroy();
      this.sessions.delete(guildId);
    }
  }

  /**
   * Hard-stop playback after a voice failure so no silent "playing" session
   * survives. Keeps the bot connected when 24/7 is enabled; otherwise the
   * connection and session are torn down completely.
   */
  abortPlayback(guildId, reason) {
    const sess = this.sessions.get(guildId);
    if (sess) {
      sess.audioPlayer?.stop(true);
      sess.current = null;
      sess.queue = [];
      sess.repeatMode = QueueRepeatMode.OFF;
      if (!this.isStayConnected(guildId)) sess.connection?.destroy();
      this.emit('emptyQueue', this.getQueue(guildId));
    }
    const { clearPanel } = require('./nowPlaying');
    clearPanel(guildId);
    if (!this.isStayConnected(guildId)) this.sessions.delete(guildId);
    this.log(guildId, reason);
  }

  disconnect(guildId) {
    this.leave(guildId);
  }

  /** Log to the guild's music log channel and a local file I can inspect. */
  log(guildId, text) {
    try {
      const fs = require('fs');
      const path = require('path');
      const file = path.join(__dirname, '..', '..', 'logs', 'playback.log');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] [${guildId}] ${text}\n`);
    } catch {}
    if (!this.client) return;
    sendLog(this.client, guildId, 'music', { content: `🎵 ${text}` }).catch(() => {});
  }
}

// ── Compatibility queue facade ─────────────────────────────────────────
function makeQueueCompat(sess, manager) {
  const node = {
    isPaused: () => !!sess.paused,
    get volume() { return sess.volume; },
    setVolume: (v) => { sess.volume = Math.max(0, Math.min(1000, v)); const res = sess.audioPlayer?.state?.resource; if (res?.volume) res.volume.setVolume(sess.volume / 100); },
    pause: () => { sess.audioPlayer?.pause(); sess.paused = true; return Promise.resolve(); },
    resume: () => { sess.audioPlayer?.unpause(); sess.paused = false; return Promise.resolve(); },
    setPaused: (p) => { p ? sess.audioPlayer?.pause() : sess.audioPlayer?.unpause(); sess.paused = p; },
    skip: () => manager.skip(sess.guildId),
    seek: (ms) => manager.seek(sess.guildId, ms / 1000),
    stop: () => manager.stop(sess.guildId),
  };
  return {
    guild: sess.guild,
    metadata: sess.metadata,
    currentTrack: sess.current,
    repeatMode: sess.repeatMode,
    estimatedDuration: sess.queue.reduce((a, t) => a + (t.durationMS || 0), 0),
    tracks: {
      data: sess.queue,
      toArray: () => [...sess.queue],
      shuffle: () => manager.shuffle(sess.guildId),
      clear: () => { sess.queue = []; },
      get length() { return sess.queue.length; },
    },
    history: {
      data: sess.history,
      get previousTrack() { return sess.history[0] || null; },
      previous: () => manager.previous(sess.guildId),
    },
    node,
    filters: {
      setFilters: async (ids) => { sess.filters = Array.isArray(ids) ? ids : []; },
      get ffmpeg() { return sess.filters; },
    },
    setRepeatMode: (mode) => { sess.repeatMode = mode; },
    delete: () => manager.leave(sess.guildId),
    clear: () => { sess.queue = []; sess.history = []; },
    isEmpty: () => !sess.current && !sess.queue.length,
    _sess: sess,
  };
}

module.exports = { MusicManager, FILTERS, EqPresets: {}, QueryType, QueueRepeatMode };
