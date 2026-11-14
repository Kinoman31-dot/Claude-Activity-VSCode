#!/usr/bin/env node
'use strict';
// Resumes Claude Code sessions that the usage hook stopped, once the 5-hour window has reset.
// Leave it running in a terminal:  node scripts/usage-guard.js      (one pass: --once)
//
// For each session the hook stopped (after it wrote its HANDOFF-<session>.md, or 5 minutes later):
//   1. save a snapshot of its folder on the branch usage-guard/<session> and push it, without
//      touching your current branch, index or files
//   2. after the reset: claude [RESUME_ARGS] -p "Read HANDOFF-<session>.md and continue..."
//      That is a NEW session, which knows only what the hand-off says. Resuming the stopped
//      session instead (claude --resume <session>) sends its whole context again: on 13 Nov 2026
//      that cost about a quarter of the new 5-hour window in one step. RESUME_MODE=same does it
//      anyway, and it is also what happens when there is no hand-off file to start from.
//      Nothing is started when you used that folder since the reset, the stop was lifted, another session in the
//      same folder is being resumed, or the reset was missed by more than 2 hours (computer
//      asleep, guard off). In those cases it logs the command to run yourself.
// --once makes a single pass (it waits for any run it starts, holding the lock meanwhile).
//
// Env: INTERVAL secs (15)  CHECKPOINT=0 no snapshot  PUSH=0 snapshot without pushing
//      RESUME_ARGS (default "--permission-mode acceptEdits"; a JSON array also works)
//      RESUME_MSG  DRY_RUN=1  CLAUDE_CMD (default "claude")  USAGE_GUARD_DIR (~/.claude-usage-guard)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { readJSONQuiet: readJSON, writeJSON } = require('./usage-fs');

const DIR = process.env.USAGE_GUARD_DIR || path.join(os.homedir(), '.claude-usage-guard');
const SESSIONS = path.join(DIR, 'sessions');
const GUARD = path.join(DIR, 'guard.json');
const LOCK = path.join(DIR, 'guard.lock');
const INTERVAL = Number(process.env.INTERVAL || 15) * 1000;
const HANDOFF_GRACE = 5 * 60e3;
const LATE_MS = 2 * 3600e3;
const RETRIES = 3;
const msgFor = (file) => `The usage limit has reset. Read ${file} and continue the task from where it stopped.`;
const MSG_NO_HANDOFF = 'The usage limit has reset. Continue the task from where it stopped.';
const msgFresh = (file, id) => `The usage limit has reset. Read ${file} and continue the work it describes. An earlier session (${id}) wrote it before it was stopped at the limit; you are a new session and know only what the file says.`;
const SAME_SESSION = process.env.RESUME_MODE === 'same';
const handoffName = (id) => 'HANDOFF-' + String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 8) + '.md';
const DRY = !!process.env.DRY_RUN;
const WIN = process.platform === 'win32';

const stamp = () => new Date().toLocaleString();
const say = (...a) => console.log(stamp(), ...a);

const words = (v) => (v.trim().startsWith('[') ? JSON.parse(v) : v.split(/\s+/).filter(Boolean));
const RESUME_ARGS = words(process.env.RESUME_ARGS ?? '--permission-mode acceptEdits');
function claudeCmd() {
  const v = process.env.CLAUDE_CMD || (onPath('claude') ? 'claude' : extensionClaude() || 'claude');
  return fs.existsSync(v) ? [v] : words(v); // a plain path may contain spaces
}

const onPath = (name) => (process.env.PATH || '').split(path.delimiter).some((d) =>
  (WIN ? ['.exe', '.cmd', '.bat', ''] : ['']).some((x) => d && fs.existsSync(path.join(d, name + x))));

// Without a CLI install, claude lives only inside the VS Code extension, in a folder named after
// its version; take the newest one.
// Extension folders are named anthropic.claude-code-<major>.<minor>.<patch>-<platform>.
function newestFirst(names) {
  const ver = (n) => (n.match(/-(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  return [...names].sort((x, y) => { const a = ver(x), b = ver(y); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (b[i] || 0) - (a[i] || 0); return 0; });
}

function extensionClaude() {
  const base = path.join(os.homedir(), '.vscode', 'extensions');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base).filter((n) => n.startsWith('anthropic.claude-code-'));
  } catch (_) { return null; }
  for (const d of newestFirst(dirs)) {
    const p = path.join(base, d, 'resources', 'native-binary', WIN ? 'claude.exe' : 'claude');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readSessions() {
  let names = [];
  try {
    names = fs.readdirSync(SESSIONS).filter((n) => n.endsWith('.json'));
  } catch (_) { /* none yet */ }
  return names.map((n) => readJSON(path.join(SESSIONS, n), null)).filter((s) => s && s.id).map((s) => ({ ...s, root: s.root || s.cwd }));
}

const sameDir = (a, b) => {
  const n = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
};

// --- checkpoint -------------------------------------------------------------------------------

// Never waits on a password, passphrase or signing prompt: no terminal or askpass prompts,
// ssh in batch mode (unless you configured your own ssh command), and a timeout as a backstop.
const sshEnvByRepo = new Map(); // per folder: each repo can have its own core.sshCommand
function gitEnv(cwd) {
  let sshEnv = sshEnvByRepo.get(cwd);
  if (sshEnv == null) {
    sshEnv = {};
    sshEnvByRepo.set(cwd, sshEnv);
    let custom = !!(process.env.GIT_SSH || process.env.GIT_SSH_COMMAND);
    try {
      custom = custom || !!execFileSync('git', ['config', '--get', 'core.sshCommand'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    } catch (_) { /* not set */ }
    if (!custom) sshEnv.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  }
  return { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', ...sshEnv };
}
function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    timeout: args[0] === 'push' ? 120e3 : 60e3,
    env: { ...process.env, ...gitEnv(cwd), ...env },
  }).trim();
}

// Snapshot the whole work tree (tracked + untracked, respecting .gitignore) as a commit on
// usage-guard/<session>, built with a temporary index: your branch, index and files are untouched.
function checkpoint(cwd, sid) {
  if (process.env.CHECKPOINT === '0') return 'skipped (CHECKPOINT=0)';
  try {
    if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return 'not a git repo';
  } catch (_) {
    return 'not a git repo';
  }
  if (DRY) return 'dry run';
  const branch = 'usage-guard/' + String(sid).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8);
  const tmp = path.join(os.tmpdir(), `usage-guard-index-${process.pid}-${Date.now()}`);
  try {
    const index = path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index']));
    if (fs.existsSync(index)) fs.copyFileSync(index, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    git(cwd, ['add', '-A', '--', ':/'], env);
    const tree = git(cwd, ['write-tree'], env);
    let head = null;
    try {
      head = git(cwd, ['rev-parse', '-q', '--verify', 'HEAD']);
    } catch (_) { /* empty repo */ }
    if (head && tree === git(cwd, ['rev-parse', 'HEAD^{tree}'])) return 'nothing to save (no changes since the last commit)';
    const commit = git(cwd, ['commit-tree', '--no-gpg-sign', tree, ...(head ? ['-p', head] : []), '-m', 'WIP: usage guard checkpoint before the usage limit']);
    git(cwd, ['update-ref', 'refs/heads/' + branch, commit]);
    if (process.env.PUSH === '0') return `saved on branch ${branch}`;
    let remote = null;
    try {
      remote = git(cwd, ['config', '--get', `branch.${git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'])}.remote`]);
    } catch (_) {
      const remotes = git(cwd, ['remote']).split('\n').filter(Boolean);
      remote = remotes.includes('origin') ? 'origin' : remotes[0] || null;
    }
    if (!remote) return `saved on branch ${branch} (no remote to push to)`;
    try {
      git(cwd, ['push', '-q', remote, `+${commit}:refs/heads/${branch}`]);
      return `saved on branch ${branch} and pushed to ${remote}`;
    } catch (e) {
      return `saved on branch ${branch}, push failed: ${String(e.stderr || e.message).trim()}`;
    }
  } catch (e) {
    return 'checkpoint failed: ' + String(e.stderr || e.message).trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// --- resume -----------------------------------------------------------------------------------

// cmd.exe needs arguments with spaces quoted when spawning through the shell (claude is a .cmd on Windows).
const winQuote = (a) => (/[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a);

function handoffFresh(s) {
  try {
    // written at the stop, or earlier in the stopped window (the hook asks for it at 85 %)
    const early = s.ho && s.ho.window === s.stopWindow && s.ho.wroteAt;
    return !s.handoffMissing && fs.statSync(path.join(s.root, handoffName(s.id))).mtimeMs >= (early ? s.ho.wroteAt : s.stoppedAt) - 2000;
  } catch (_) {
    return false;
  }
}

function resume(s, g, done) {
  const has = handoffFresh(s);
  const fresh = has && !SAME_SESSION; // a new session needs a hand-off to start from
  const msg = process.env.RESUME_MSG || (fresh ? msgFresh(handoffName(s.id), s.id) : has ? msgFor(handoffName(s.id)) : MSG_NO_HANDOFF);
  const [cmd, ...pre] = claudeCmd();
  const args = fresh ? [...pre, ...RESUME_ARGS, '-p', msg] : [...pre, '--resume', s.id, ...RESUME_ARGS, '-p', msg];
  if (DRY) return say('DRY_RUN: would run', cmd, args.join(' '), 'in', s.root);
  g.attempts = (g.attempts || 0) + 1;
  g.resumedAt = Date.now();
  Object.assign(g, { exitCode: null, pid: null });
  writeJSON(GUARD, done); // record before starting, so a crash cannot resume twice
  const logFile = path.join(DIR, 'resume-' + String(s.id).replace(/[^A-Za-z0-9_-]/g, '_') + '.log');
  // The run is marked so the hook can tell its activity apart from yours.
  const env = { ...process.env, USAGE_GUARD_RUN: s.id };
  let child;
  if (WIN) {
    // No console window and not tied to the guard's terminal: all stdio ignored (libuv then
    // creates the process without a window) and the output redirected by cmd.exe itself.
    const line = [cmd, ...args].map(winQuote).join(' ') + ' >> ' + winQuote(logFile) + ' 2>&1';
    child = spawn(line, { cwd: s.root, stdio: 'ignore', shell: true, windowsHide: true, env });
  } else {
    // Its own session: closing the guard's terminal does not kill it.
    const log = fs.openSync(logFile, 'a');
    child = spawn(cmd, args, { cwd: s.root, stdio: ['ignore', log, log], detached: true, env });
    fs.closeSync(log);
  }
  g.pid = child.pid || null;
  writeJSON(GUARD, done);
  say(fresh ? 'started a new session from the hand-off of session' : 'resumed session', s.id, 'in', s.root, '(log:', logFile + ')');
  const finish = (code, err) => {
    const all = readJSON(GUARD, {});
    const r = all[s.id];
    if (!r || r.stoppedAt !== g.stoppedAt) return;
    r.exitCode = code;
    r.exitedAt = Date.now();
    if (code === 0) say('resumed session', s.id, 'finished');
    else if (r.attempts < RETRIES) {
      Object.assign(r, { resumedAt: null, resumeAt: Date.now() + 10 * 60e3 * r.attempts });
      say('resumed session', s.id, err ? 'failed to start (' + err + ')' : 'exited with code ' + code, '- retrying at', new Date(r.resumeAt).toLocaleString());
    } else say('resumed session', s.id, 'failed', RETRIES, 'times; see', logFile);
    try { writeJSON(GUARD, all); } catch (e) { say('could not save guard.json:', e.message); }
  };
  child.on('error', (e) => finish(-1, e.message));
  child.on('exit', (code) => finish(code));
}

// --- main loop --------------------------------------------------------------------------------

function pass(now = Date.now()) {
  const sessions = readSessions();
  const done = readJSON(GUARD, {});
  let changed = false;
  const due = [];
  for (const s of sessions) {
    try {
      if (!s.root) continue;
      const g = done[s.id];
      if (!s.stoppedAt) {
        if (g && g.stoppedAt && !g.resumedAt && !g.skipped) {
          g.skipped = 'the stop was lifted';
          say('session', s.id, 'is no longer stopped; nothing to resume');
          changed = true;
        }
        continue;
      }
      if (!g || g.stoppedAt !== s.stoppedAt) {
        const resetAt = (s.resumeAt || s.stoppedAt + 5 * 3600e3) - 60e3;
        done[s.id] = { stoppedAt: s.stoppedAt, root: s.root, resetAt, resumeAt: resetAt + 60e3, attempts: 0 };
        changed = true;
      }
      const r = done[s.id];
      if (r.resumedAt || r.skipped) continue;
      if (!r.checkpointedAt && (s.handedOff || now - s.stoppedAt >= HANDOFF_GRACE)) {
        r.checkpointedAt = now;
        say('session', s.id, 'stopped near the limit; checkpoint:', checkpoint(s.root, s.id));
        say('will resume at', new Date(r.resumeAt).toLocaleString());
        changed = true;
      }
      if (r.checkpointedAt && now >= r.resumeAt) due.push(s);
    } catch (e) {
      say('error handling session', s.id, '-', e.message);
    }
  }

  // At most one resume per folder: the most recently stopped session.
  due.sort((a, b) => b.stoppedAt - a.stoppedAt);
  const taken = [];
  for (const s of due) {
    const r = done[s.id];
    const hint = `to continue yourself: cd "${s.root}" && claude --resume ${s.id}`;
    let skip = null;
    // Your activity after the reset; the stopped session's own hand-off does not count.
    const usedAfter = (o) => (o.seenAt || 0) > Math.max(r.resetAt, o.id === s.id ? o.handedOffAt || 0 : 0);
    if (taken.some((c) => sameDir(c, s.root))) skip = 'another session in this folder is being resumed';
    else if (sessions.some((o) => o.root && sameDir(o.root, s.root) && usedAfter(o))) skip = 'you have used this folder since the reset';
    else if (!r.attempts && now - r.resumeAt > LATE_MS) skip = 'the reset was missed by more than 2 hours (computer asleep or guard off)';
    if (skip) {
      r.skipped = skip;
      say('not resuming session', s.id + ':', skip + ';', hint);
      changed = true;
      continue;
    }
    taken.push(s.root);
    try {
      resume(s, r, done);
    } catch (e) {
      say('could not resume session', s.id, '-', e.message);
    }
    changed = true;
  }
  if (changed && !DRY) writeJSON(GUARD, done);
  return done;
}

// One guard at a time, so a session is never resumed twice. The lock holds the pid and a
// heartbeat; a lock whose heartbeat is old is stale even if its pid now belongs to another program.
const LOCK_STALE_MS = Math.max(3 * INTERVAL, 60e3);
const heartbeat = () => fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));
function lock() {
  fs.mkdirSync(DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
  } catch (_) {
    const l = readJSON(LOCK, {}) || {};
    const pid = typeof l === 'number' ? l : Number(l.pid);
    let alive = false;
    try {
      alive = pid > 0 && pid !== process.pid && process.kill(pid, 0);
    } catch (_) { /* not running */ }
    if (alive && Date.now() - (l.at || 0) < LOCK_STALE_MS) return false;
    heartbeat();
  }
  process.on('exit', () => {
    try {
      if (Number((readJSON(LOCK, {}) || {}).pid) === process.pid) fs.unlinkSync(LOCK);
    } catch (_) { /* gone */ }
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130));
  return true;
}

function safePass() {
  try {
    heartbeat();
    pass();
  } catch (e) {
    say('pass failed:', e.message);
  }
}

if (require.main === module) {
  if (!lock()) {
    console.error('Another usage guard is already running. If none is, delete ' + LOCK + '.');
    process.exit(1);
  }
  if (process.argv.includes('--once')) {
    safePass();
  } else {
    const [cmd, ...pre] = claudeCmd();
    const v = spawnSync(WIN ? winQuote(cmd) : cmd, [...pre, '--version'], { shell: WIN, encoding: 'utf8', windowsHide: true });
    if (v.status !== 0) say('warning: `' + cmd + ' --version` failed; resumes will fail until claude is on PATH (or set CLAUDE_CMD).');
    say('usage guard watching', SESSIONS);
    safePass();
    setInterval(safePass, INTERVAL);
  }
}

module.exports = { pass, checkpoint, winQuote, words, newestFirst };
