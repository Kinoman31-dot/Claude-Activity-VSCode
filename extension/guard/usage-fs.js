'use strict';
// File helpers shared by the hook, the guard and the usage fetch.
// Windows can briefly refuse to read or rename a file another process has open, so both retry.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code's own folder (settings, credentials).
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

const RETRY = new Set(['EBUSY', 'EPERM', 'EACCES']);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Missing or corrupt -> fallback. Other errors (locked, no permission, a folder in the way) are
// thrown, so a transient failure never makes the caller replace good data with an empty value.
function readJSON(f, fallback) {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT' || e instanceof SyntaxError) return fallback;
      if (i >= 5 || !RETRY.has(e.code)) throw e;
      sleep(30);
    }
  }
}

function readJSONQuiet(f, fallback) {
  try {
    return readJSON(f, fallback);
  } catch (_) {
    return fallback;
  }
}

// Atomic write (temp file + rename); the temp file never outlives a failure.
function writeJSON(f, v, pretty = true) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  try {
    fs.writeFileSync(tmp, pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v));
    for (let i = 0; ; i++) {
      try {
        return fs.renameSync(tmp, f);
      } catch (e) {
        if (i >= 10 || !RETRY.has(e.code)) throw e;
        sleep(25);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written or already gone */ }
    throw e;
  }
}

module.exports = { configDir, sleep, readJSON, readJSONQuiet, writeJSON };
