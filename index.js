const fs = require('fs');

try {
  const ff = require('@ffmpeg-installer/ffmpeg');
  if (ff && ff.path && process.platform !== 'win32') {
    try { fs.chmodSync(ff.path, 0o755); } catch {}
  }
} catch {}

function start() {
  require('./src/index.js');
}

if (process.platform !== 'win32') {
  require('./scripts/ensureYtDlp.js')().catch(() => {}).finally(start);
} else {
  start();
}