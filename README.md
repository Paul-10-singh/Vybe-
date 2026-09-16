# Peace Music 🎵

Standalone music bot, split from the main **Peace✘** bot (which is now security + utility only).
Streams audio with **play-dl + yt-dlp** and plays it through **@discordjs/voice**.

- Plays **song names**, **YouTube links**, **Spotify links** and **Tamil radio stations**
- Persistent server playlists, audio filters, loop modes, shuffle, seek, lyrics
- Pro-style animated now-playing card (musicard "quartz+" theme) with transport buttons
- `/grab` DMs you the current track · `/24-7` keeps the bot in voice after the queue ends

## Requirements

- **Node.js 18+**
- **ffmpeg** on `PATH` (e.g. `winget install ffmpeg`), or a bundled `ffmpeg-static`
- Bot with the **VOICE STATES** (+ `SERVER MEMBERS`, `MESSAGE CONTENT`) intents enabled

## Setup

```bash
cp .env.example .env
npm install
npm run spotify     # optional: authorize Spotify for /play <spotify link>
npm run deploy      # register slash commands
npm start
```

`.env` needs a **new** bot application (do NOT reuse the main bot's token — Discord
disconnects the second login):

```env
DISCORD_TOKEN=your_music_bot_token_here
CLIENT_ID=your_music_bot_application_id_here
OWNER_ID=1202689641757806602
SUPPORT_URL=https://discord.gg/as22hkafWN
DEV_GUILD_ID=       # optional: server ID for instant command updates while testing
```

- `npm run deploy` → global commands (single-scope per server)
- `npm run deploy:guild` → only the two camp guilds (1340379968571576341, 1510358429183774910)
- `npm run spotify` → one-time OAuth; tokens saved to `.data/spotify.data`

`cookies.json`/`cookies.txt` are used for YouTube streaming (private/age-restricted content).

## Commands (35 registered)

`/play` `/search` `/queue` `/stop` `/pause` `/resume` `/skip` `/forceskip`
`/skipto` `/remove` `/clear` `/shuffle` `/loop` `/seek` `/disconnect`
`/connect` `/controls` `/volume` `/filter` `/8d` `/fx` `/mix` `/booster`
`/playlist play/create/view/show/load/add/delete` — per-user playlists with a
default **Liked** list (`/playlist play liked`, /show liked); add songs by URL
or song name. `/history` `/lyrics`
`/grab` `/radio` `/spotify` `/autoplay` `/24-7` `/p1 /p2 /p3` (owner library tracks)

`/help` lists everything with usage notes.

## Project structure

```
 Peace music/
├── src/
│   ├── index.js           # client setup (Voice States intent) + MusicManager
│   ├── commands/
│   │   ├── music/         # 34 slash commands
│   │   └── utility/help.js
│   ├── events/            # interactionCreate, voiceStateUpdate, clientReady
│   └── utils/             # permissions, settings, decorations, helpers, logging
├── scripts/               # deploy.js, loadCommands.js, spotify.js
└── .env                   # your token/ID (gitignored)
```

## Notes

- Cookies and Spotify tokens are gitignored; player state lives in SQLite (`better-sqlite3`).
- `/leave` is registered as `/disconnect` intentionally.
- Any user can use music commands in a voice channel; only the owner's library
  tracks (`/p1 /p2 /p3`) are owner-only.