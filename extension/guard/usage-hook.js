#!/usr/bin/env node
'use strict';
// Claude Code hook: careful mode near the 5-hour usage limit, then a clean stop with a hand-off.
//
//   node scripts/usage-hook.js install     add the hooks to ~/.claude/settings.json
//   node scripts/usage-hook.js uninstall   remove them
//   node scripts/usage-hook.js status      show the current estimate and stage
//   node scripts/usage-hook.js reset       forget the stage and calibration
//
// As a hook it is called with "pre" (PreToolUse) or "stop" (Stop) and the event JSON on stdin.
// It reads ~/.claude-usage.json (written by the Claude Usage Bar extension) plus local token
// counts from Claude Code's transcripts. Any error lets Claude carry on (fail open).
// When that reading is old (over 90 seconds near the limit, over 5 minutes otherwise) or missing,
// it asks Anthropic for a fresh one (usage-fetch.js; USAGE_GUARD_FETCH=off turns that off).
// Settings: ~/.claude-usage-guard/config.json, e.g. {"line": 75, "stopAt": 92}. USAGE_GUARD=off disables it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DEFAULTS, parseReading, step, sameReset } = require('./usage-core');
const { configDir, readJSON, readJSONQuiet, writeJSON } = require('./usage-fs');
const { credentialsFile } = require('./usage-fetch');

const DIR = process.env.USAGE_GUARD_DIR || path.join(os.homedir(), '.claude-usage-guard');
const STATE = path.join(DIR, 'state.json');
const SESSIONS = path.join(DIR, 'sessions');
const GUARD = path.join(DIR, 'guard.json');
const CONFIG = path.join(DIR, 'config.json');
const CACHE = path.join(DIR, 'transcripts-cache.json');
const USAGE_FILE = process.env.USAGE_FILE || path.join(os.homedir(), '.claude-usage.json');
const REMIND_EVERY = 10; // careful-mode reminder every N tool calls per agent
const HANDOFF_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const SESSION_TTL = 30 * 3600e3;
const FETCH = path.join(DIR, 'fetch.json'); // when the hook last asked Anthropic for a reading (all sessions)
const READINGS = path.join(DIR, 'readings.jsonl'); // one line per new reading: real % next to the estimate
const STEPS = path.join(DIR, 'steps.count'); // one byte per tool call, from every session: its size is the step count
const STOPS = path.join(DIR, 'stops.jsonl'); // one line per stop: the real % at the stop and at the end of its window
// Near the limit, a reading older than this is refreshed. The usage bar writes one a minute, so
// while it is running the hook does not ask as well (both share Anthropic's rate limit).
const FRESH_MS = 90e3;
const STOP_FRESH_MS = 20e3; // ...and before a stop is committed, one older than this
const STOP_WAIT_MAX = 2; // % past the stop target that may build up while a stop waits for a fresh reading
// Away from the limit, a reading this old (or none at all) is refreshed too: without the usage
// bar the guard would otherwise count from a stale figure and never notice the limit coming.
const IDLE_FRESH_MS = 5 * 60e3;
const FETCH_SCRIPT =process.env.USAGE_FETCH_SCRIPT || path.join(__dirname, 'usage-fetch.js'); // the tests swap in a fake
const FETCH_EVERY_MS = DEFAULTS.fetchFloorMs - 2000; // ...at most this often (a little under the core's floor, so a due fetch is not refused)
const FETCH_TIMEOUT_MS = 6000; // the fetch itself gives up after 4 s
const READINGS_MAX_BYTES = 512 * 1024;

function logError(e) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, 'hook.log'), new Date().toISOString() + ' ' + ((e && e.stack) || e) + '\n');
  } catch (_) { /* nowhere to log */ }
}

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
const sessionFile = (id) => path.join(SESSIONS, safeId(id) + '.json');
// One hand-off file per session, so two sessions in one folder never mix them up.
const handoffName = (id) => 'HANDOFF-' + safeId(id).slice(0, 8) + '.md';

function readSessions() {
  let names = [];
  try {
    names = fs.readdirSync(SESSIONS).filter((n) => n.endsWith('.json'));
  } catch (_) { /* none yet */ }
  const out = {};
  for (const n of names) {
    const s = readJSONQuiet(path.join(SESSIONS, n), null);
    if (s && s.id) out[s.id] = s;
  }
  return out;
}

function pidAlive(pid) {
  try {
    return pid > 0 && process.kill(pid, 0);
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// --- decision ---------------------------------------------------------------------------------

const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'unknown');
// The figure the stop target is tested against (the reading plus the work since it), when there is one.
const shown = (r) => (r.estStop == null ? r.est : r.estStop);
const pct = (r) => (shown(r) == null ? 'Nearly all' : `About ${Math.round(shown(r))}%`);

function readUsage() {
  let raw = null;
  try {
    raw = readJSON(USAGE_FILE, null);
  } catch (e) {
    logError(e); // locked or unreadable: treated as no data, which keeps a stop until its reset
  }
  return { raw, reading: parseReading(raw) };
}

// Ask Anthropic for a fresh reading (written to the usage file by usage-fetch.js). True when a
// new reading was written. At most one try per FETCH_EVERY_MS across all sessions; any failure
// just means the estimate is used. USAGE_GUARD_FETCH=off turns this off.
function fetchFresh(now) {
  return tryFetch(now) === 'ok';
}

// 'ok' (a reading was written), 'wait' (too soon after the last try, or backing off: a later call
// can try again), or 'no' (switched off, not signed in, or the request failed).
function tryFetch(now) {
  if (process.env.USAGE_GUARD_FETCH === 'off') return 'no';
  try {
    if (!fs.existsSync(credentialsFile())) return 'no';
    const th = readJSONQuiet(FETCH, null);
    if (th) {
      const age = now - (th.at || 0);
      if ((age >= 0 && age < FETCH_EVERY_MS) || now < (th.until || 0)) return 'wait';
    }
    writeJSON(FETCH, { at: now }); // before the call, so parallel hooks do not fetch as well
    const r = spawnSync(process.execPath, [FETCH_SCRIPT, USAGE_FILE, FETCH], { timeout: FETCH_TIMEOUT_MS, stdio: 'ignore', windowsHide: true });
    return r.status === 0 ? 'ok' : 'no';
  } catch (e) {
    logError(e);
    return 'no';
  }
}

// Remember the reading in the state and, when it is a new one, log the real % next to the
// position the guard held at its last look before it. `held` is that position when already known.
function noteReading(prev, reading, r, src, held, now) {
  if (!reading) return;
  const last = prev.lastReading;
  r.state.lastReading = reading;
  if (last && reading.t <= last.t) return;
  let est = held;
  if (est === undefined) {
    // Nothing to compare with once the reading's window has ended, or across two windows.
    const ended = reading.resetsAt != null && now >= reading.resetsAt;
    const same = !ended && last && sameReset(last.resetsAt, reading.resetsAt);
    est = same && prev.win && typeof prev.win.est === 'number' ? prev.win.est : null;
  }
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(READINGS, JSON.stringify({ t: reading.t, real: reading.p, est: est == null ? null : Math.round(est * 100) / 100, stage: r.stage, src }) + '\n');
  } catch (e) {
    logError(e);
  }
}

// Steps are counted by appending one byte per tool call: appends from parallel hooks never lose
// each other, and the file's size is the count.
function countStep() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(STEPS, 'x');
  } catch (e) {
    logError(e);
  }
}
function stepsTotal() {
  try {
    return fs.statSync(STEPS).size;
  } catch (_) {
    return 0;
  }
}

// What stops really cost: for each past stop, where the guard held usage to be when it stopped
// and the last real % read before that window ended. Their average difference is the room the
// next stop leaves. (Until 14 Nov 2026 the difference was taken from the last reading before the
// stop, which also counted usage from before the stop: 4 points instead of about 1.5, so the
// next stop came two points early.) Stops with no reading after them are left out.
const stopFrom = (j) => Math.max(j.atStop, typeof j.estAtStop === 'number' ? j.estAtStop : j.atStop);
const stopCost = (j) => Math.max(0, j.end - stopFrom(j));
function stopStats(n = 5) {
  let lines = [];
  try {
    lines = fs.readFileSync(STOPS, 'utf8').split('\n');
  } catch (_) { /* none yet */ }
  const byT = new Map();
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if (j && typeof j.atStop === 'number' && typeof j.end === 'number' && j.end >= j.atStop && j.measured !== false) byT.set(j.t, j);
    } catch (_) { /* blank or partial line */ }
  }
  const last = [...byT.values()].slice(-n);
  if (!last.length) return null;
  return { n: last.length, mean: last.reduce((x, j) => x + stopCost(j), 0) / last.length, last: last[last.length - 1] };
}

const ACTIVE_MS = 90e3; // an agent that took a step this recently is still working

function evaluate(now, { count = false, who = null } = {}) {
  const base = { ...DEFAULTS, ...readJSONQuiet(CONFIG, {}) };
  const past = stopStats();
  if (past && !('tail' in readJSONQuiet(CONFIG, {}))) base.tail = Math.max(0.5, Math.min(8, past.mean));
  if (count) countStep();
  const total = stepsTotal();
  const prev = readJSON(STATE, {});
  const readStage = prev.win ? prev.win.stage : null;
  // Who is taking steps: every session and sub-agent seen in the last ACTIVE_MS.
  const act = {};
  for (const [k, t] of Object.entries(prev.act || {})) if (now - t < ACTIVE_MS) act[k] = t;
  if (who) act[who] = now;
  const agents = Math.max(1, Object.keys(act).length);
  let cfg = base;
  const run = ({ raw, reading }, extra = {}) => {
    cfg = { ...base, ...extra };
    const g = raw && raw.guardThreshold; // the usage bar's setting: never stop later than this
    if (typeof g === 'number' && g >= 1 && g <= 100) cfg.ceiling = Math.min(cfg.ceiling, g);
    const out = step(prev, { now, reading, total, agents }, cfg);
    out.state.act = act;
    out.agents = agents;
    return out;
  };
  let u = readUsage();
  let r = run(u);
  let src = 'file';
  let held;
  // A reading is refreshed when it can tell something new (r.fetchEvery), and a stop is only
  // committed on one at most STOP_FRESH_MS old.
  const newStop = r.stage === 'stopped' && readStage !== 'stopped';
  if (!u.reading || (newStop ? now - u.reading.t > STOP_FRESH_MS : r.fetchDue !== false && (r.fetchDue || now - u.reading.t > r.fetchEvery))) {
    const got = tryFetch(now);
    const u2 = got === 'ok' ? readUsage() : null;
    if (u2 && u2.reading && (!u.reading || u2.reading.t > u.reading.t)) {
      held = r.est;
      u = u2;
      r = run(u);
      src = 'fetch';
    } else if (got === 'wait' && newStop && r.stopAt != null && r.est < r.stopAt + STOP_WAIT_MAX) {
      // The stop wants a fresh reading and a later call can get one: keep working in careful mode
      // for now. The hard end still stops, and so does a position more than STOP_WAIT_MAX past the
      // target. A fetch that fails outright does not wait: the position is then all there is.
      r = run(u, { holdTarget: true });
    }
  }
  // A stopped window has ended: keep what the stop really cost.
  const pw = prev.win;
  if (pw && pw.stage === 'stopped' && typeof pw.stopReal === 'number' && r.state.win && r.state.win.id !== pw.id && prev.lastReading && sameReset(prev.lastReading.resetsAt, pw.resetsAt)) {
    try {
      // measured: a reading was taken after the stop. Without one, "end" is only the figure from
      // before the stop and says nothing about what the stop cost.
      fs.appendFileSync(STOPS, JSON.stringify({
        t: pw.stoppedAt, atStop: pw.stopReal, estAtStop: typeof pw.stopEst === 'number' ? Math.round(pw.stopEst * 100) / 100 : undefined,
        end: prev.lastReading.p, measured: prev.lastReading.t > pw.stoppedAt,
      }) + '\n');
    } catch (e) {
      logError(e);
    }
  }
  noteReading(prev, u.reading, r, src, held, now);
  r.readStage = readStage;
  r.cfg = cfg;
  r.raw = u.raw;
  return r;
}

// Hooks of several sessions read the state, decide (a fetch can take seconds) and write it back
// without a lock. A stop another hook committed in the meantime must not be written over by a
// hook that never saw it. (A hook that read the stop and lifted it on a fresh reading may.)
function keepStop(state, readStage, cur) {
  if (!cur || !cur.win || !state || !state.win) return state;
  if (cur.win.stage === 'stopped' && cur.win.id === state.win.id && state.win.stage !== 'stopped' && readStage !== 'stopped') {
    state.win.stage = 'stopped';
    state.win.stoppedAt = cur.win.stoppedAt;
  }
  return state;
}

// Error of the estimate against the real readings: the last n logged readings that had an estimate.
function readingStats(n = 20) {
  let lines = [];
  try {
    lines = fs.readFileSync(READINGS, 'utf8').split('\n');
  } catch (_) { /* none yet */ }
  const byT = new Map();
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if (j && typeof j.t === 'number' && typeof j.real === 'number' && typeof j.est === 'number') byT.set(j.t, j.est - j.real);
    } catch (_) { /* blank or partial line */ }
  }
  const errs = [...byT.values()].slice(-n);
  if (!errs.length) return null;
  return {
    n: errs.length,
    mean: errs.reduce((x, e) => x + Math.abs(e), 0) / errs.length,
    worst: errs.reduce((w, e) => (Math.abs(e) > Math.abs(w) ? e : w), 0),
  };
}

// Keep the readings log small: drop the older half once it passes READINGS_MAX_BYTES.
function trimReadings() {
  try {
    if (fs.statSync(READINGS).size <= READINGS_MAX_BYTES) return;
    const lines = fs.readFileSync(READINGS, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(READINGS, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
  } catch (_) { /* missing, or busy: next time */ }
}

// The session's record. `root` is the folder the session started in (CLAUDE_PROJECT_DIR), which
// stays put when Claude cds into a subfolder; the hand-off, the snapshot and the resume use it.
function loadSession(input, now) {
  let s = null;
  let readFailed = false;
  try {
    s = readJSON(sessionFile(input.session_id), null);
  } catch (e) {
    logError(e);
    readFailed = true; // decide anyway, but never overwrite the real record
  }
  if (!s || typeof s !== 'object') s = { id: input.session_id };
  if (!input.agent_id) s.root = process.env.CLAUDE_PROJECT_DIR || s.root || input.cwd;
  if (!s.root) s.root = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (input.transcript_path && !input.agent_id) s.transcript = input.transcript_path;
  // Activity of a run the guard started is kept apart, so it is not mistaken for the user's.
  // (the run is either the stopped session resumed, or a new session started from its hand-off)
  if (process.env.USAGE_GUARD_RUN) s.guardSeenAt = now;
  else s.seenAt = now;
  return { s, readFailed };
}

// Start the background guard that resumes stopped sessions, unless one already holds a fresh lock
// (the guard's own lock settles a race). USAGE_GUARD_AUTOSTART=off turns this off.
function ensureGuard() {
  if (process.env.USAGE_GUARD_AUTOSTART === 'off' || process.env.USAGE_GUARD_RUN) return;
  try {
    const l = readJSONQuiet(path.join(DIR, 'guard.lock'), null);
    if (l && Date.now() - (l.at || 0) < 60e3 && pidAlive(l.pid)) return;
    fs.mkdirSync(DIR, { recursive: true });
    const out = fs.openSync(path.join(DIR, 'guard.log'), 'a');
    require('child_process').spawn(process.execPath, [path.join(__dirname, 'usage-guard.js')], {
      detached: true, stdio: ['ignore', out, out], windowsHide: true,
    }).unref();
  } catch (e) {
    logError(e);
  }
}

function recordStop(s, r, now) {
  if (s.stopWindow === r.state.win.id && s.stoppedAt) return;
  ensureGuard();
  Object.assign(s, { stopWindow: r.state.win.id, stoppedAt: now, handedOff: false, handedOffAt: null, handoffAt: null, handoffMissing: null, liftedAt: null, resumeAt: r.resetsAt ? r.resetsAt + 60e3 : now + 5 * 3600e3 });
}

// A stop that no longer applies: lifted in its own window by a fresh reading, or its window was
// replaced by a different one before its reset time.
function maybeLift(s, r, now) {
  const win = r.state.win;
  if (!s.stoppedAt || s.handedOff || r.stage === 'stopped' || r.est == null || !win) return;
  if (s.stopWindow === win.id || now < (s.resumeAt || 0) - 60e3) {
    Object.assign(s, { stoppedAt: null, stopWindow: null, handedOff: false, liftedAt: now });
  }
}

const stopText = (r, s) =>
  `[usage guard] ${pct(r)} of the 5-hour Claude limit is used (resets ${clock(r.resetsAt)}). ` +
  `Stop working now. Write ${path.join(s.root || '.', handoffName(s.id))} with: the task, what is done, what is left, ` +
  'and the exact next steps (Read it first if it already exists, then one Write). Then end your turn. ' +
  'Every other tool is blocked until the limit resets; the usage guard resumes this session after the reset if it is running.';

const handoffFile = (s) => path.join(s.root || '.', handoffName(s.id));

// At 85 %: the hand-off is written while there is room for it, and work carries on.
const handoffAskText = (r, s) =>
  `[usage guard] ${pct(r)} of the 5-hour Claude limit is used. Write ${handoffFile(s)} now, with one Write: ` +
  `"Session ${s.id}" on the first line, then the task, what is done, what is left, and the exact next steps. ` +
  'Then carry on working in small steps. Near the limit every tool is blocked without further warning, and after the reset a new session continues from this file alone.';

// At 90 %: one short update.
const handoffUpdateText = (r, s) =>
  `[usage guard] ${pct(r)} of the 5-hour Claude limit is used. Update ${handoffFile(s)} now with one small Edit: only what is left and the next steps. Then carry on.`;

// Just before the stop: the last update.
const LAST_UPDATE_GAP = 1.5; // % of usage since the hand-off was last written that makes a last update worth a step
const handoffLastText = (r, s) =>
  `[usage guard] ${pct(r)} of the 5-hour Claude limit is used: the stop is one or two steps away. Make this step one small Edit of ${handoffFile(s)}: ` +
  'what is left and the exact next steps, as they stand now. After the stop nothing more can be written.';

// The stop when the hand-off already exists: nothing more to write.
const hardStopText = (r, s) =>
  `[usage guard] ${pct(r)} of the 5-hour Claude limit is used (resets ${clock(r.resetsAt)}). Stop now and end your turn with one short sentence. ` +
  `Do not call any tool: all are blocked until the limit resets. ${handoffFile(s)}, written earlier, is what the next session continues from.`;

// The hand-off is named only when this session has one on disk.
const promptRefusedText = (r, s, sid) =>
  `[usage guard] ${pct(r)} of the 5-hour Claude limit is used, so this prompt was not sent to Claude. The limit resets at ${clock(r.resetsAt)}. ` +
  (s && s.root && fs.existsSync(handoffFile(s))
    ? `After the reset the usage guard, if it is running, continues from ${handoffName(sid)} in a new session.`
    : 'This session has no hand-off file, so nothing continues it by itself: send the prompt again after the reset.');

const subagentStopText = (r) =>
  `[usage guard] ${pct(r)} of the 5-hour Claude limit is used. Stop now: do not call more tools, except the one that hands your report back. ` +
  'Hand the main agent a short summary (a few lines) of what you did and what is left; it will write the hand-off.';

// The tool a sub-agent hands its report back with. It is never blocked: on 13 Nov 2026 a stopped
// sub-agent had it refused three times and wrote its long report again each time, which was
// 220k of the 307k weighted tokens used after that stop (the window ended at 96 %, not 90-95 %).
const REPORT_TOOLS = new Set(['SubagentHandback']);

const carefulText = (r) =>
  `[usage guard] ${pct(r)} of the 5-hour Claude limit is used: careful mode. ` +
  'Work in small steps: one small edit or command at a time, no large file reads or long outputs, short replies. ' +
  'You will be asked to write a hand-off file before the limit.';

// --- weekly limits: reported and warned about, never enforced (the user's choice, 13 Nov 2026) ---

const WEEKLY_STEP = 5; // after the first warning, once more for every this many points

// [{ label, percent, resetsAt }] from the usage file: all models, and one per model where the plan has it.
function weeklyOf(raw) {
  const ok = (b) => b && typeof b.percent === 'number' && Number.isFinite(b.percent);
  if (raw && Array.isArray(raw.weekly)) return raw.weekly.filter(ok).map((b) => ({ label: String(b.label || 'all models'), percent: b.percent, resetsAt: b.resetsAt || null }));
  return raw && ok(raw.seven_day) ? [{ label: 'all models', percent: raw.seven_day.percent, resetsAt: raw.seven_day.resetsAt || null }] : [];
}

const day = (ts) => (ts ? new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown');

// The weekly limits that reached a new warning level for this session (noted in s.weekly, so each
// level is said once per session and week).
function weeklyDue(s, r) {
  const at = r.cfg.weeklyWarnAt;
  if (!(at > 0)) return [];
  const due = [];
  for (const w of weeklyOf(r.raw)) {
    if (w.percent < at) continue;
    const level = Math.floor((w.percent - at) / WEEKLY_STEP);
    const seen = (s.weekly || {})[w.label];
    if (seen && seen.level >= level && (seen.resetsAt === w.resetsAt || sameReset(seen.resetsAt, w.resetsAt))) continue;
    s.weekly = { ...(s.weekly || {}), [w.label]: { resetsAt: w.resetsAt, level } };
    due.push(w);
  }
  return due;
}

const weeklyText = (due) =>
  '[usage guard] Weekly limit warning: ' +
  due.map((w) => `${Math.round(w.percent)}% of the weekly limit (${w.label}) is used, resets ${day(w.resetsAt)}`).join('; ') +
  '. This is a warning only: nothing is blocked for it. Tell the user in one sentence in your next reply.';

const busyText = (sid) =>
  '[usage guard] This session is being continued in the background by the usage guard ' +
  `(log: ${path.join(DIR, 'resume-' + safeId(sid) + '.log')}). Wait for that run to finish, or stop it, before working in this session.`;

function isHandoff(input, s) {
  if (!HANDOFF_TOOLS.has(input.tool_name) || !s.root) return false;
  const fp = input.tool_input && input.tool_input.file_path;
  if (typeof fp !== 'string' || !fp) return false;
  const norm = (p) => {
    const x = path.resolve(p).replace(/\\/g, '/');
    return process.platform === 'win32' ? x.toLowerCase() : x;
  };
  return norm(path.resolve(input.cwd || s.root, fp)) === norm(path.join(s.root, handoffName(s.id)));
}

const pre = (fields) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } });

// Is the guard running this session in the background right now (and this call is not from it)?
function guardBusy(sid) {
  if (process.env.USAGE_GUARD_RUN === sid) return false;
  const rec = readJSONQuiet(GUARD, {})[sid];
  return !!(rec && rec.resumedAt && rec.exitCode == null && rec.pid && pidAlive(rec.pid));
}

// PreToolUse: once stopped, block everything except the main agent's own hand-off file (which
// is auto-approved so it never waits on a permission prompt); in careful mode, add a reminder.
function onPre(input, now) {
  if (guardBusy(input.session_id)) return pre({ permissionDecision: 'deny', permissionDecisionReason: busyText(input.session_id) });
  const r = evaluate(now, { count: true, who: input.session_id + '|' + (input.agent_id || 'main') });
  const { s, readFailed } = loadSession(input, now);
  maybeLift(s, r, now);
  const agent = input.agent_id || 'main';
  const handoff = !input.agent_id && isHandoff(input, s);
  const win = r.state.win ? r.state.win.id : null;
  // s.ho: the hand-off of this window (asked for at 85 %, written, updated at 90 %)
  if (s.ho && s.ho.window !== win) s.ho = null;
  const hadHandoff = !!(s.ho && s.ho.wroteAt);
  if (handoff && WRITE_TOOLS.has(input.tool_name) && !(r.stage === 'stopped' && hadHandoff)) {
    s.handoffAt = now;
    s.ho = { ...(s.ho || {}), window: win, wroteAt: now, wrotePct: r.est == null ? null : Math.round(r.est) };
  }
  let out = null;
  if (r.stage === 'stopped') {
    if (input.agent_id) {
      recordStop(s, r, now);
      if (!REPORT_TOOLS.has(input.tool_name)) out = pre({ permissionDecision: 'deny', permissionDecisionReason: subagentStopText(r) });
    } else if (hadHandoff) {
      // the hand-off was written earlier in this window: the stop is final and costs one reply
      recordStop(s, r, now);
      out = pre({ permissionDecision: 'deny', permissionDecisionReason: hardStopText(r, s) });
    } else if (handoff) {
      out = pre({ permissionDecision: 'allow', permissionDecisionReason: 'usage guard: hand-off file' });
    } else {
      recordStop(s, r, now);
      out = pre({ permissionDecision: 'deny', permissionDecisionReason: stopText(r, s) });
    }
  } else if (handoff && s.stoppedAt && !s.handedOff) {
    // Still finishing the hand-off after the window rolled over.
    out = pre({ permissionDecision: 'allow', permissionDecisionReason: 'usage guard: hand-off file' });
  } else if (r.stage === 'careful') {
    s.notes = s.notes || {};
    const n = s.notes[agent] || {};
    if (n.window !== r.state.win.id || n.count >= REMIND_EVERY - 1) {
      s.notes[agent] = { window: r.state.win.id, count: 0 };
      out = pre({ additionalContext: carefulText(r) });
    } else {
      s.notes[agent] = { window: n.window, count: n.count + 1 };
    }
    // The main agent is asked for the hand-off at 85 % (again every REMIND_EVERY calls until it
    // is written) and for one short update at 90 %. These notes come before the reminder above.
    if (!input.agent_id && r.est != null && r.est >= r.cfg.handoffAt) {
      const ho = s.ho || (s.ho = { window: win });
      if (!ho.wroteAt) {
        ho.calls = ho.askedAt ? (ho.calls || 0) + 1 : 0;
        if (!ho.askedAt || ho.calls >= REMIND_EVERY) {
          ho.askedAt = now;
          ho.calls = 0;
          out = pre({ additionalContext: handoffAskText(r, s) });
        }
      } else if (r.est >= r.cfg.updateAt && !ho.updateAskedAt && (ho.wrotePct == null || ho.wrotePct < r.cfg.updateAt)) {
        ho.updateAskedAt = now;
        ho.updatePct = r.est;
        out = pre({ additionalContext: handoffUpdateText(r, s) });
      } else if (!ho.lastAskedAt && r.stopAt != null && r.est >= r.stopAt - Math.max(1, 2 * r.cps) && r.est - Math.max(ho.wrotePct || 0, ho.updatePct || 0) >= LAST_UPDATE_GAP) {
        // One or two steps before the stop: a last short update, so the new session does not
        // redo or miss what was done since the previous one. Skipped when the file is that recent.
        ho.lastAskedAt = now;
        out = pre({ additionalContext: handoffLastText(r, s) });
      }
    }
  }
  // Weekly limits: a warning for the main agent, added to whatever note this call already carries.
  const h = out && out.hookSpecificOutput;
  if (!input.agent_id && r.stage !== 'stopped' && !(h && h.permissionDecision)) {
    const due = weeklyDue(s, r);
    if (due.length) {
      if (h) h.additionalContext = (h.additionalContext ? h.additionalContext + '\n' : '') + weeklyText(due);
      else out = pre({ additionalContext: weeklyText(due) });
    }
  }
  persist(r.state, readFailed ? null : s, r.readStage);
  return out;
}

// Stop: a session that was stopped must leave a fresh hand-off (asked once), then the hand-off is
// recorded for the guard. Sessions that never had a tool blocked are left alone.
function onStop(input, now) {
  // The reply that ends a turn is a request to the model like any other, and no tool call
  // announces it: it is counted here. Without this, a conversation with few tool calls moved
  // the position only when a new reading arrived.
  const r = evaluate(now, { count: true, who: input.session_id + '|main' });
  const { s, readFailed } = loadSession(input, now);
  maybeLift(s, r, now);
  // The stop can be reached on this reply itself, with no tool blocked before it (the first real
  // stop of the new guard, 13 Nov 2026, was: no stop was recorded, so no new session was started
  // after the reset). A session with a hand-off of this window is recorded here. One without is
  // still left alone: a chat without tools is not asked for a hand-off.
  const win = r.state.win ? r.state.win.id : null;
  if (r.stage === 'stopped' && !s.stoppedAt && s.ho && s.ho.window === win && s.ho.wroteAt) recordStop(s, r, now);
  let out = null;
  if (s.stoppedAt && !s.handedOff) {
    let fresh = false;
    try {
      fresh = !!s.handoffAt && s.handoffAt >= s.stoppedAt - 2000 && fs.statSync(path.join(s.root || '.', handoffName(s.id))).mtimeMs >= s.stoppedAt - 2000;
      // a hand-off written earlier in the stopped window (at 85 %) counts: that is the point of writing it early
      if (!fresh && s.ho && s.ho.window === s.stopWindow && s.ho.wroteAt) fresh = fs.existsSync(handoffFile(s));
    } catch (_) { /* missing */ }
    const stillStopped = r.stage === 'stopped' && s.stopWindow === r.state.win.id;
    if (!fresh && stillStopped && !input.stop_hook_active) out = { decision: 'block', reason: stopText(r, s) };
    else Object.assign(s, { handedOff: true, handedOffAt: now, handoffMissing: !fresh });
  }
  persist(r.state, readFailed ? null : s, r.readStage);
  return out;
}

// UserPromptSubmit: while the window is stopped, a prompt is refused before it reaches Claude, so
// it costs nothing (on 13 Nov 2026 a "go" typed during a stop cost about a point). A session that
// has work in this window and no hand-off yet is let through once, so it can write one.
function onPrompt(input, now) {
  const r = evaluate(now);
  if (r.stage !== 'stopped') return null;
  const s = readJSONQuiet(sessionFile(input.session_id), null);
  const win = r.state.win ? r.state.win.id : null;
  const hasHandoff = !!(s && s.ho && s.ho.window === win && s.ho.wroteAt);
  if (s && s.seenAt && !s.handedOff && !hasHandoff) return null;
  persist(r.state, null, r.readStage);
  return { decision: 'block', reason: promptRefusedText(r, s, input.session_id) };
}

// A failed write must never drop the decision already made.
function persist(state, session, readStage) {
  try {
    writeJSON(STATE, keepStop(state, readStage, readJSONQuiet(STATE, null)));
  } catch (e) {
    logError(e);
  }
  if (!session) return;
  try {
    writeJSON(sessionFile(session.id), session);
  } catch (e) {
    logError(e);
  }
}

function pruneSessions(now) {
  for (const s of Object.values(readSessions())) {
    if (now - Math.max(s.seenAt || 0, s.guardSeenAt || 0, s.stoppedAt || 0) > SESSION_TTL) {
      try { fs.unlinkSync(sessionFile(s.id)); } catch (_) { /* gone */ }
    }
  }
}

// --- CLI -------------------------------------------------------------------------------------

const settingsFile = () => path.join(configDir(), 'settings.json');
const isOurs = (h) => h && typeof h.command === 'string' && h.command.includes('usage-hook.js');

function stripOurs(hooks) {
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev]
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (hooks[ev].length === 0) delete hooks[ev];
  }
}

function loadSettings() {
  const f = settingsFile();
  if (!fs.existsSync(f)) return {};
  const text = fs.readFileSync(f, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(f + ' is not valid JSON, so it was left untouched: ' + e.message);
  }
}

function install() {
  const f = settingsFile();
  const settings = loadSettings();
  if (fs.existsSync(f) && !fs.existsSync(f + '.bak-usage-guard')) fs.copyFileSync(f, f + '.bak-usage-guard');
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  stripOurs(settings.hooks);
  const script = path.resolve(__filename).replace(/\\/g, '/');
  const handler = (arg) => ({ type: 'command', command: `node "${script}" ${arg}`, timeout: 15 });
  (settings.hooks.PreToolUse = settings.hooks.PreToolUse || []).push({ matcher: '*', hooks: [handler('pre')] });
  (settings.hooks.Stop = settings.hooks.Stop || []).push({ hooks: [handler('stop')] });
  (settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || []).push({ hooks: [handler('prompt')] });
  writeJSON(f, settings);
  console.log('Installed the usage guard hooks in', f);
  console.log('Restart Claude Code sessions to pick them up. Keep `node scripts/usage-guard.js` running to resume after resets.');
}

function uninstall() {
  const f = settingsFile();
  const settings = loadSettings();
  if (settings.hooks) {
    stripOurs(settings.hooks);
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  writeJSON(f, settings);
  console.log('Removed the usage guard hooks from', f);
}

function status() {
  const now = Date.now();
  const r = evaluate(now);
  writeJSON(STATE, keepStop(r.state, r.readStage, readJSONQuiet(STATE, null)));
  if (r.est == null && r.stage === 'normal') return console.log('No usage data in', USAGE_FILE, '(is the extension patched and plan limits on?)');
  console.log(`Stage: ${r.stage}`);
  console.log(`Estimated 5-hour usage: ${r.est == null ? 'unknown' : r.est.toFixed(1) + '%'} (resets ${r.resetsAt ? new Date(r.resetsAt).toLocaleString() : 'unknown'})`);
  console.log(`One step costs about ${r.cps.toFixed(2)}% (${r.measured ? 'measured on the last readings' : 'not measured yet in this window'}); ${r.since} steps since the last reading`);
  if (r.stopAt != null) console.log(`Hand-off asked at ${r.cfg.handoffAt}%, stop when the position reaches ${r.stopAt.toFixed(1)}%${r.agents > 1 ? ` (${r.agents} agents working)` : ''}`);
  const weekly = weeklyOf(r.raw);
  for (const w of weekly) console.log(`Weekly limit (${w.label}): ${Math.round(w.percent)}% (resets ${day(w.resetsAt)})`);
  if (weekly.length) console.log(r.cfg.weeklyWarnAt > 0 ? `Weekly limits: a warning from ${r.cfg.weeklyWarnAt}%, never a stop` : 'Weekly limits: warnings are off');
  const past = stopStats();
  if (past) console.log(`After the last ${past.n} stop${past.n === 1 ? '' : 's'} usage rose ${past.mean.toFixed(1)}% on average (last one: stopped at ${Math.round(stopFrom(past.last) * 10) / 10}%, window ended at ${past.last.end}%)`);
  const e = readingStats();
  console.log(e
    ? `Estimate against the last ${e.n} real readings: mean error ${e.mean.toFixed(1)}%, worst ${e.worst > 0 ? '+' : ''}${e.worst.toFixed(1)}% (estimate minus real)`
    : 'Estimate against real readings: nothing logged yet');
  if (r.reason) console.log(`Note: ${r.reason}`);
  for (const s of Object.values(readSessions())) {
    if (s.stoppedAt) console.log(`Session ${s.id}: stopped ${new Date(s.stoppedAt).toLocaleString()}, hand-off ${s.handedOff ? (s.handoffMissing ? 'missing' : handoffName(s.id)) : 'pending'}, resume after ${new Date(s.resumeAt).toLocaleString()} in ${s.root}`);
  }
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'install') return install();
  if (cmd === 'uninstall') return uninstall();
  if (cmd === 'status') return status();
  if (cmd === 'reset') {
    for (const f of [STATE, CACHE, STEPS]) fs.rmSync(f, { force: true });
    return console.log('Usage guard state cleared.');
  }
  if (cmd !== 'pre' && cmd !== 'stop' && cmd !== 'prompt') {
    console.error('usage: usage-hook.js install | uninstall | status | reset | pre | stop | prompt');
    process.exitCode = 1;
    return;
  }
  if (process.env.USAGE_GUARD === 'off') return;
  try {
    let input = null;
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch (_) { /* no or bad stdin */ }
    if (!input || typeof input !== 'object' || !input.session_id || !input.hook_event_name) {
      logError('ignored hook call without a valid event on stdin');
      return; // never decide anything on input we cannot read
    }
    const now = Date.now();
    const out = (cmd === 'pre' ? onPre : cmd === 'prompt' ? onPrompt : onStop)(input, now);
    if (out) process.stdout.write(JSON.stringify(out));
    if (Math.random() < 0.02) {
      pruneSessions(now);
      trimReadings();
    }
  } catch (e) {
    logError(e); // fail open: never block Claude because the guard broke
  }
}

if (require.main === module) main();

module.exports = { onPre, onStop, onPrompt, stopStats, isHandoff, stripOurs, readSessions, sessionFile, handoffName, fetchFresh, readingStats, keepStop };
