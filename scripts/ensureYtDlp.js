const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const TARGET = path.join(DATA_DIR, 'yt-dlp_linux');
const RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function download(to) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(to);
    const req = https.get(RELEASE_URL, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => resolve(true));
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      out.destroy();
      reject(err);
    });
    out.on('error', (err) => {
      req.destroy();
      reject(err);
    });
  });
}

async function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(TARGET)) {
    const age = Date.now() - fs.statSync(TARGET).mtimeMs;
    if (age < MAX_AGE_MS) return TARGET;
  }

  const tmp = `${TARGET}.tmp`;
  try {
    await download(tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, TARGET);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    if (!fs.existsSync(TARGET)) throw err;
  }
  return TARGET;
}

if (require.main === module) {
  ensure()
    .then((p) => console.log(`[PeaceX] yt-dlp ready: ${p}`))
    .catch((e) => {
      console.error(`[PeaceX] yt-dlp update failed (${e.message}) — using bundled binary.`);
      process.exit(1);
    });
}

module.exports = ensure;