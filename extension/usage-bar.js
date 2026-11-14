'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const vscode = require('vscode');
const { LocalUsage, configDir } = require('./usage-local');
const { fetchPlanUsage, PlanError } = require('./usage-plan');

const FULL = '█';
const EMPTY = '░';
const SHORT = { five_hour: '5h', seven_day: '7d' };
const TICK_MS = 30e3; // redraw + rescan of the local history
const ACTIVITY_GAP_MS = 20e3; // fetch again this soon after Claude Code writes a reply
const BURST_MAX_MS = 8e3; // while Claude Code keeps writing, do not wait longer than this for a pause
const USAGE_FILE = path.join(os.homedir(), '.claude-usage.json'); // shared with the usage guard and other windows
const USAGE_FILE_POLL_MS = 1000;

let item;
let out;
let local;
let timer;
let watcher;
let debounce;
let burstStart = 0; // when the current run of transcript writes began
let followUp; // one more fetch, when activity came too soon after the last one
let ownWrite = 0; // updatedAt of the usage file as this window last wrote it
let ctx;
const plan = { data: null, fetchedAt: 0, error: null, backoffUntil: 0, loggedRaw: false, busy: false };

function cfg() {
  const c = vscode.workspace.getConfiguration('claudeUsageBar');
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  return {
    usePlanLimits: c.get('usePlanLimits', false),
    refreshMs: Math.max(30, c.get('refreshSeconds', 60)) * 1000,
    width: clamp(c.get('barWidth', 8), 4, 20),
    warnAt: c.get('warnAt', 80),
    errorAt: c.get('errorAt', 95),
    guardThreshold: clamp(c.get('guardThreshold', 95), 1, 100),
    budget: Math.max(0, c.get('fiveHourTokenBudget', 0)),
    showReset: c.get('showResetTime', true),
    showWeekly: c.get('showWeekly', false),
  };
}

function bar(pct, width) {
  const p = Math.min(100, Math.max(0, pct));
  const n = Math.min(width, Math.max(p > 0 ? 1 : 0, Math.round((p / 100) * width)));
  return FULL.repeat(n) + EMPTY.repeat(width - n);
}

function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60e3));
  if (m >= 1440) return Math.floor(m / 1440) + 'd ' + Math.floor((m % 1440) / 60) + 'h';
  if (m >= 60) return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  return m + 'm';
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function when(ts, now) {
  if (!ts) return '';
  const d = ts - now;
  return d <= 0 ? 'resetting now' : 'resets in ' + fmtDur(d) + ' (' + (d > 20 * 3600e3 ? new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : clock(ts)) + ')';
}

// Short "(resets 03:00 PM)" for the bar; later than ~20 hours away it also gets the weekday ("Tue 03:00 AM").
function resetText(ts, now, approx) {
  if (!ts || ts <= now) return '';
  const t =
    ts - now > 20 * 3600e3
      ? new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : clock(ts);
  return ' (resets ' + (approx ? '~' : '') + t + ')';
}

function log(msg) {
  out.appendLine('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

async function fetchPlan(minGapMs) {
  const c = cfg();
  if (!c.usePlanLimits || plan.busy) return;
  const now = Date.now();
  if (now < plan.backoffUntil || now - plan.fetchedAt < minGapMs) return;
  plan.busy = true;
  plan.fetchedAt = now;
  try {
    const r = await fetchPlanUsage();
    plan.data = r;
    try {
      writeUsageFile(r);
    } catch (e) {
      log('Could not write Usage Guard reading: ' + e.message);
    }
    plan.error = null;
    log('Plan limits: ' + r.buckets.map((b) => b.key + '=' + b.percent + '%').join(', '));
    if (!plan.loggedRaw) {
      plan.loggedRaw = true;
      log('Raw answer (first of this session, no secrets in it): ' + r.raw);
    }
  } catch (e) {
    plan.error = e instanceof PlanError ? e : new PlanError('other', String((e && e.message) || e));
    if (plan.error.code === 'rate') plan.backoffUntil = Date.now() + (plan.error.retryAfterMs || 300e3);
    log('Plan limits failed (' + plan.error.code + '): ' + plan.error.message);
    if (plan.error.raw) log('Raw answer: ' + plan.error.raw);
  } finally {
    plan.busy = false;
  }
}

// The reading goes to a file the usage guard reads (and other VS Code windows, see adoptUsageFile).
// Written to a temporary file and renamed, so a reader never sees half of it.
function writeUsageFile(r) {
  const pick = (key) => {
    const bucket = r.byKey[key];
    return bucket ? { percent: bucket.percent, resetsAt: bucket.resetsAt } : null;
  };
  const weekly = r.buckets
    .filter((b) => b.key === 'seven_day' || b.model)
    .map((b) => ({ label: b.model || 'all models', percent: b.percent, resetsAt: b.resetsAt }));
  const data = { updatedAt: Date.now(), guardThreshold: cfg().guardThreshold, five_hour: pick('five_hour'), seven_day: pick('seven_day'), weekly };
  const text = JSON.stringify(data);
  const tmp = USAGE_FILE + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, USAGE_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    fs.writeFileSync(USAGE_FILE, text); // Windows refuses the rename while a reader has the file open
  }
  ownWrite = data.updatedAt;
}

// The usage guard asks Anthropic as well, before tool calls, and writes the same file; so does this
// extension in every other VS Code window. A reading there that is newer than ours is shown at
// once instead of waiting for our own next request, and it counts as our latest request.
function adoptUsageFile() {
  if (!cfg().usePlanLimits || plan.busy || !plan.data) return false;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {
    return false; // missing, or caught in the middle of a write: the next look gets it
  }
  const now = Date.now();
  if (!j || typeof j.updatedAt !== 'number' || j.updatedAt === ownWrite || j.updatedAt <= plan.fetchedAt || j.updatedAt > now + 5000) return false;
  const take = (b, v) => {
    if (!b || !v || typeof v.percent !== 'number' || !Number.isFinite(v.percent)) return;
    b.percent = Math.min(100, Math.max(0, v.percent));
    if (typeof v.resetsAt === 'number') b.resetsAt = v.resetsAt;
  };
  take(plan.data.byKey.five_hour, j.five_hour);
  take(plan.data.byKey.seven_day, j.seven_day);
  for (const w of Array.isArray(j.weekly) ? j.weekly : []) {
    if (w && w.label) take(plan.data.buckets.find((b) => b.model === w.label), w);
  }
  plan.fetchedAt = j.updatedAt;
  plan.error = null;
  const five = plan.data.byKey.five_hour;
  log('Plan limits, from the shared usage file: ' + (five ? 'five_hour=' + five.percent + '%' : 'no 5-hour figure'));
  return true;
}

// The graph tab shows the same numbers: each render also publishes a snapshot to this listener.
let listener = null;
let lastSnap = null;
function setUsageListener(fn) { listener = fn; if (lastSnap && fn) fn(lastSnap); }
function emitSnapshot(snap) { lastSnap = snap; if (listener) listener(snap); }

function render() {
  const c = cfg();
  const now = Date.now();
  const s = local.summary(now);
  const planOn = c.usePlanLimits;
  const live = planOn && plan.data;
  const stale = live && plan.error;

  const parts = [];
  let worst = 0;
  if (live) {
    const perModel = plan.data.buckets.filter((b) => b.model).map((b) => b.key);
    for (const key of c.showWeekly ? ['five_hour', 'seven_day', ...perModel] : ['five_hour']) {
      const b = plan.data.byKey[key];
      if (!b) continue;
      parts.push((SHORT[key] || b.short) + ' ' + bar(b.percent, c.width) + ' ' + Math.round(b.percent) + '%' + (c.showReset ? resetText(b.resetsAt, now) : ''));
      worst = Math.max(worst, b.percent);
    }
    if (!parts.length) {
      const b = plan.data.buckets[0];
      parts.push(b.label + ' ' + bar(b.percent, c.width) + ' ' + Math.round(b.percent) + '%' + (c.showReset ? resetText(b.resetsAt, now) : ''));
      worst = b.percent;
    }
  } else {
    // Local mode: the end of the current 5-hour block is our own estimate, hence the "~".
    const blockTok = s.block ? s.block.work : 0;
    const blockEnd = c.showReset && s.block ? resetText(s.block.end, now, true) : '';
    if (c.budget > 0) {
      const pct = (blockTok / c.budget) * 100;
      parts.push('5h ' + bar(pct, c.width) + ' ' + Math.round(pct) + '%' + blockEnd);
      worst = pct;
    } else {
      parts.push('5h ' + fmtTok(blockTok) + blockEnd);
    }
    if (c.showWeekly) parts.push('7d ' + fmtTok(s.week.work));
  }

  emitSnapshot({
    planOn, live: !!live, stale: !!stale,
    plan: live && plan.data.plan ? plan.data.plan : '',
    buckets: live ? plan.data.buckets.map((b) => ({ label: b.label, percent: b.percent, resetsAt: b.resetsAt })) : [],
    error: plan.error ? plan.error.message : '',
    fetchedAt: plan.fetchedAt,
    block: s.block ? { work: s.block.work, messages: s.block.messages, end: s.block.end } : null,
    week: { work: s.week.work, messages: s.week.messages },
    budget: c.budget, warnAt: c.warnAt, errorAt: c.errorAt, now,
  });

  const icon = planOn && (!live || stale) && plan.error ? '$(warning)' : '$(pulse)';
  item.text = icon + ' ' + parts.join('  ·  ');
  item.backgroundColor =
    worst >= c.errorAt
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : worst >= c.warnAt
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  md.appendMarkdown('**Claude usage**' + (live && plan.data.plan ? ' · ' + plan.data.plan + ' plan' : '') + '\n\n');

  if (planOn) {
    if (live) {
      md.appendMarkdown('*Plan limits, as Anthropic reports them (updated ' + clock(plan.fetchedAt) + ')*\n\n');
      for (const b of plan.data.buckets) {
        md.appendMarkdown('- ' + b.label + ': **' + Math.round(b.percent) + '%** ' + (b.resetsAt ? '· ' + when(b.resetsAt, now) : '') + '\n');
      }
      md.appendMarkdown('\n');
    }
    if (plan.error) {
      md.appendMarkdown('$(warning) ' + plan.error.message + (live ? ' (showing the last good numbers)' : '') + '\n\n');
    } else if (!live) {
      md.appendMarkdown('Loading plan limits…\n\n');
    }
  }

  md.appendMarkdown('*Claude Code history on this computer (not claude.ai chats)*\n\n');
  if (s.block) {
    const b = s.block;
    md.appendMarkdown(
      '- Current 5-hour block: **' + fmtTok(b.work) + ' tokens** in ' + b.messages + ' replies · ends in ' + fmtDur(b.end - now) + ' (' + clock(b.end) + ')\n' +
        '  - you sent ' + fmtTok(b.input) + ', Claude wrote ' + fmtTok(b.output) + ', cache writes ' + fmtTok(b.cacheCreate) + '\n'
    );
    const models = Object.entries(b.byModel).sort((x, y) => y[1] - x[1]);
    for (const [m, n] of models) md.appendMarkdown('  - ' + m + ': ' + fmtTok(n) + '\n');
  } else {
    md.appendMarkdown('- No Claude Code activity in the last 5 hours\n');
  }
  md.appendMarkdown('- Last 7 days: **' + fmtTok(s.week.work) + ' tokens** in ' + s.week.messages + ' replies\n');
  md.appendMarkdown('- Cache reads (not counted above): ' + fmtTok(s.week.cacheRead) + ' this week\n\n');
  if (!planOn) {
    md.appendMarkdown('No fill level yet: turn on plan limits for real percentages, or set a token budget in settings.\n\n');
  }
  md.appendMarkdown(
    '[Refresh](command:claudeUsageBar.refresh) · [Menu](command:claudeUsageBar.menu) · [Settings](command:workbench.action.openSettings?' +
      encodeURIComponent(JSON.stringify('claudeUsageBar')) +
      ')'
  );
  item.tooltip = md;
}

async function tick(force) {
  try {
    await local.scan();
    adoptUsageFile();
    await fetchPlan(force ? 5e3 : cfg().refreshMs - 1000);
  } catch (e) {
    log('Refresh failed: ' + ((e && e.stack) || e));
  }
  render();
}

// Claude Code wrote to its transcripts: usage has moved. Ask again, but no more often than every
// ACTIVITY_GAP_MS. When the activity came sooner than that after the last request, one more
// request is made as soon as the gap is over, so the last reply of a run is not left uncounted
// until the next minute (which is how the bar fell behind Claude Code's own banner).
async function afterActivity() {
  debounce = null;
  burstStart = 0;
  try {
    await local.scan();
    adoptUsageFile();
    const before = plan.fetchedAt;
    await fetchPlan(ACTIVITY_GAP_MS);
    if (plan.fetchedAt === before && !followUp && cfg().usePlanLimits) {
      followUp = setTimeout(async () => {
        followUp = null;
        try {
          adoptUsageFile();
          await fetchPlan(ACTIVITY_GAP_MS - 1000);
        } catch (e) {
          log('Follow-up refresh failed: ' + e);
        }
        render();
      }, Math.max(1000, before + ACTIVITY_GAP_MS - Date.now() + 250));
    }
  } catch (e) {
    log('Watch refresh failed: ' + e);
  }
  render();
}

function startWatching() {
  const root = local.root;
  try {
    watcher = fs.watch(root, { recursive: true }, () => {
      // Wait for a 2.5 s pause in the writing, but never longer than BURST_MAX_MS from its start.
      const now = Date.now();
      if (!burstStart) burstStart = now;
      clearTimeout(debounce);
      debounce = setTimeout(afterActivity, Math.max(0, Math.min(2500, burstStart + BURST_MAX_MS - now)));
    });
    watcher.on('error', () => {});
  } catch (e) {
    log('Could not watch ' + root + ' (' + e.message + '); falling back to a ' + TICK_MS / 1000 + ' s timer.');
  }
  // The shared usage file, by polling its date: it is replaced by rename, which a plain watch loses.
  fs.watchFile(USAGE_FILE, { interval: USAGE_FILE_POLL_MS }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs && adoptUsageFile()) render();
  });
}

async function enablePlanLimits() {
  const pick = await vscode.window.showWarningMessage(
    'Show your real plan-limit percentages?',
    {
      modal: true,
      detail:
        'Every minute (and after each Claude Code reply) this extension will read the sign-in token that Claude Code keeps in ' +
        path.join(configDir(), '.credentials.json') +
        ' and send it to api.anthropic.com, the same address Claude Code uses for /usage. The token goes nowhere else and the extension never renews or changes it.\n\n' +
        'Anthropic has not published this address as a stable interface, so it could stop working one day.',
    },
    'Turn on'
  );
  if (pick !== 'Turn on') return;
  await vscode.workspace.getConfiguration('claudeUsageBar').update('usePlanLimits', true, vscode.ConfigurationTarget.Global);
  plan.error = null;
  await tick(true);
}

async function disablePlanLimits() {
  await vscode.workspace.getConfiguration('claudeUsageBar').update('usePlanLimits', false, vscode.ConfigurationTarget.Global);
  plan.data = null;
  plan.error = null;
  render();
}

function usageHookSettings() {
  const file = path.join(configDir(), 'settings.json');
  if (!fs.existsSync(file)) return { file, settings: {} };
  try {
    const text = fs.readFileSync(file, 'utf8');
    const settings = text.trim() ? JSON.parse(text) : {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('the settings file must contain a JSON object');
    }
    return { file, settings };
  } catch (e) {
    throw new Error(`Could not read Claude settings at ${file}: ${e.message}`);
  }
}

function installedUsageHook(settings) {
  for (const groups of Object.values((settings && settings.hooks) || {})) {
    for (const group of groups || []) {
      for (const hook of (group && group.hooks) || []) {
        if (!hook || typeof hook.command !== 'string' || !hook.command.includes('usage-hook.js')) continue;
        const match = hook.command.match(/\bnode\s+"([^"]*usage-hook\.js)"\s+(?:pre|stop|prompt)(?:\s|$)/i);
        return { script: match ? path.resolve(match[1]) : null };
      }
    }
  }
  return null;
}

// ---------- usage guard: set up, on and off, thresholds ----------
// The guard is a set of Claude Code hooks (scripts run by Node.js). It is on when its hooks are in
// Claude Code's user settings. Turning it on needs no file to be picked: the scripts ship with this
// extension and are put in ~/.claude-usage-guard/scripts, a place that stays the same when the
// extension is updated. A guard that is already installed from somewhere else is left where it is.
const GUARD_HOME = process.env.USAGE_GUARD_DIR || path.join(os.homedir(), '.claude-usage-guard');
// setting name -> the name the guard uses in its config.json
const GUARD_KEYS = { carefulAt: 'line', handoffAt: 'handoffAt', updateAt: 'updateAt', endAt: 'endAt', weeklyWarnAt: 'weeklyWarnAt' };
let guardSyncing = false;

function gcfg() { return vscode.workspace.getConfiguration('claudeUsageGuard'); }

function guardInstalled() {
  try { return installedUsageHook(usageHookSettings().settings); } catch (e) { return null; }
}

function deployBundledGuard() {
  const from = path.join(__dirname, 'guard');
  const to = path.join(GUARD_HOME, 'scripts');
  if (!fs.existsSync(path.join(from, 'usage-hook.js'))) return null;
  fs.mkdirSync(to, { recursive: true });
  for (const n of fs.readdirSync(from)) fs.copyFileSync(path.join(from, n), path.join(to, n));
  return path.join(to, 'usage-hook.js');
}

// The guard's hook script: the one the installed hooks point at, else the path from the settings,
// else the one used last time, else the copy that ships with the extension.
function guardScript(forInstall) {
  const installed = guardInstalled();
  if (installed && installed.script && fs.existsSync(installed.script)) return installed.script;
  const set = String(gcfg().get('scriptPath') || '').trim();
  if (set) {
    if (path.basename(set).toLowerCase() !== 'usage-hook.js' || !fs.existsSync(set)) throw new Error('The setting claudeUsageGuard.scriptPath does not point to a usage-hook.js file: ' + set);
    return set;
  }
  const remembered = ctx.globalState.get('usageHookScriptPath');
  if (remembered && fs.existsSync(remembered)) return remembered;
  const shipped = path.join(GUARD_HOME, 'scripts', 'usage-hook.js');
  return forInstall ? deployBundledGuard() : fs.existsSync(shipped) ? shipped : null;
}

// Runs one command of the guard's hook script (install, uninstall, status) and returns what it printed.
function runUsageHook(script, action) {
  return new Promise((resolve, reject) => {
    execFile('node', [script, action], { cwd: path.dirname(script), windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve((stdout || stderr || '').trim());
    });
  });
}

function nodeAvailable() {
  return new Promise((resolve) => execFile('node', ['--version'], { windowsHide: true, timeout: 8000 }, (error) => resolve(!error)));
}

// The thresholds set in VS Code are written to the guard's config.json. A setting left empty is
// not written, so the guard keeps its own value (or one you put in that file by hand).
function writeGuardConfig() {
  const file = path.join(GUARD_HOME, 'config.json');
  let cur = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) cur = j; } catch (e) { /* none yet */ }
  const next = { ...cur };
  for (const [name, key] of Object.entries(GUARD_KEYS)) {
    const v = gcfg().get(name);
    if (typeof v === 'number' && Number.isFinite(v)) next[key] = Math.min(100, Math.max(0, v));
  }
  const order = ['line', 'handoffAt', 'updateAt', 'endAt'].map((k) => next[k]).filter((v) => typeof v === 'number');
  if (order.some((v, i) => i > 0 && v <= order[i - 1])) {
    vscode.window.showWarningMessage('Usage guard thresholds must rise in this order: careful mode, hand-off, update, end. Nothing was changed.');
    return false;
  }
  if (JSON.stringify(next) === JSON.stringify(cur)) return true;
  fs.mkdirSync(GUARD_HOME, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  log('Usage guard settings written to ' + file + ': ' + JSON.stringify(next));
  return true;
}

// The checkbox in the settings always shows what is really installed.
async function syncGuardSetting() {
  const on = !!guardInstalled();
  if (gcfg().get('enabled') === on) return;
  guardSyncing = true;
  try { await gcfg().update('enabled', on, vscode.ConfigurationTarget.Global); } catch (e) { /* settings not writable: the menu still works */ }
  guardSyncing = false;
}

async function setGuard(on, quiet) {
  let ok = false;
  try {
    const installed = guardInstalled();
    if (on === !!installed) {
      if (!quiet) vscode.window.showInformationMessage(on ? 'The usage guard is already on.' : 'The usage guard is already off.');
      ok = true;
    } else {
      if (!(await nodeAvailable())) throw new Error('Node.js was not found. The usage guard runs on Node.js: install it from nodejs.org, restart VS Code, and try again.');
      const script = on ? guardScript(true) : (installed.script && fs.existsSync(installed.script) ? installed.script : guardScript(false));
      if (!script) throw new Error('The usage guard scripts were not found. Set claudeUsageGuard.scriptPath to your usage-hook.js file.');
      if (on && !writeGuardConfig()) throw new Error('The thresholds in the settings are not in rising order.');
      const result = await runUsageHook(script, on ? 'install' : 'uninstall');
      await ctx.globalState.update('usageHookScriptPath', script);
      log('Usage guard ' + (on ? 'on' : 'off') + ' (' + script + '): ' + result);
      vscode.window.showInformationMessage((on ? 'Usage guard is on. ' : 'Usage guard is off. ') + 'This applies to Claude Code sessions started from now on; restart a running session to apply it there.');
      ok = true;
    }
  } catch (e) {
    vscode.window.showErrorMessage('Could not turn the usage guard ' + (on ? 'on' : 'off') + ': ' + e.message);
  }
  await syncGuardSetting();
  return ok;
}

async function guardStatus() {
  try {
    const installed = guardInstalled();
    const script = guardScript(false);
    out.appendLine('');
    out.appendLine('Usage guard: ' + (installed ? 'ON' : 'OFF') + (script ? ' · scripts: ' + path.dirname(script) : ' · scripts not set up yet (they are put in place when you turn it on)'));
    if (script) out.appendLine(await runUsageHook(script, 'status'));
    out.show(true);
  } catch (e) {
    vscode.window.showErrorMessage('Could not read the usage guard status: ' + e.message);
  }
}

const openGuardSettings = () => vscode.commands.executeCommand('workbench.action.openSettings', 'claudeUsageGuard');

async function menu() {
  const on = cfg().usePlanLimits;
  const guardOn = !!guardInstalled();
  const picks = [
    { label: '$(refresh) Refresh now', run: () => tick(true) },
    on
      ? { label: '$(eye-closed) Stop reading plan limits', description: 'back to local token counts only', run: disablePlanLimits }
      : { label: '$(pulse) Show plan-limit percentages', description: 'reads your Claude sign-in token', run: enablePlanLimits },
    guardOn
      ? { label: '$(circle-slash) Turn the usage guard off', description: 'it is on: Claude Code is stopped near the 5-hour limit', run: () => setGuard(false) }
      : { label: '$(shield) Turn the usage guard on', description: 'stop Claude Code near the 5-hour limit, with a hand-off', run: () => setGuard(true) },
    { label: '$(info) Usage guard status', run: guardStatus },
    { label: '$(settings) Usage guard settings', description: 'thresholds, weekly warning', run: openGuardSettings },
    { label: '$(gear) Usage bar settings', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'claudeUsageBar') },
    { label: '$(output) Show log', run: () => out.show(true) },
  ];
  const p = await vscode.window.showQuickPick(picks, { placeHolder: 'Claude usage · the guard is ' + (guardOn ? 'on' : 'off') });
  if (p) await p.run();
}

async function firstRunHint() {
  if (ctx.globalState.get('askedPlanLimits') || cfg().usePlanLimits) return;
  await ctx.globalState.update('askedPlanLimits', true);
  const pick = await vscode.window.showInformationMessage(
    'Claude Usage Bar is showing token counts from this computer. Want the real plan-limit percentages (5-hour and weekly) as a filled bar instead?',
    'Show plan limits',
    'Not now'
  );
  if (pick === 'Show plan limits') await enablePlanLimits();
}

function activateUsageBar(context) {
  ctx = context;
  out = vscode.window.createOutputChannel('Claude Usage Bar');
  local = new LocalUsage();
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'Claude Usage';
  item.command = 'claudeUsageBar.menu';
  item.text = '$(sync~spin) Claude usage';
  item.show();

  context.subscriptions.push(
    item,
    out,
    vscode.commands.registerCommand('claudeUsageBar.refresh', () => tick(true)),
    vscode.commands.registerCommand('claudeUsageBar.menu', menu),
    vscode.commands.registerCommand('claudeUsageBar.enablePlanLimits', enablePlanLimits),
    vscode.commands.registerCommand('claudeUsageBar.disablePlanLimits', disablePlanLimits),
    vscode.commands.registerCommand('claudeUsageBar.enableUsageGuard', () => setGuard(true)),
    vscode.commands.registerCommand('claudeUsageBar.disableUsageGuard', () => setGuard(false)),
    vscode.commands.registerCommand('claudeUsageBar.guardStatus', guardStatus),
    vscode.commands.registerCommand('claudeUsageBar.guardSettings', openGuardSettings),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (guardSyncing || !e.affectsConfiguration('claudeUsageGuard')) return;
      if (e.affectsConfiguration('claudeUsageGuard.enabled')) setGuard(gcfg().get('enabled') === true, true);
      else if (guardInstalled()) writeGuardConfig();
    }),
    vscode.commands.registerCommand('claudeUsageBar.showLog', () => out.show(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeUsageBar')) tick(true);
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) tick(false);
    })
  );

  // the guard: show its real state in the settings, and keep the shipped scripts current when they are the ones in use
  try {
    const installed = guardInstalled();
    if (installed && installed.script) ctx.globalState.update('usageHookScriptPath', installed.script);
    if (installed && installed.script && path.resolve(path.dirname(installed.script)) === path.resolve(GUARD_HOME, 'scripts')) deployBundledGuard();
    syncGuardSetting();
  } catch (e) { log('Usage guard check failed: ' + e.message); }

  timer = setInterval(() => tick(false), TICK_MS);
  startWatching();
  tick(true);
  setTimeout(firstRunHint, 4000);
}

function deactivateUsageBar() {
  clearInterval(timer);
  clearTimeout(debounce);
  clearTimeout(followUp);
  fs.unwatchFile(USAGE_FILE);
  if (watcher) watcher.close();
}

module.exports = { _guard: { setGuard, writeGuardConfig, guardInstalled, guardScript }, activateUsageBar, deactivateUsageBar, setUsageListener, refreshUsage: () => tick(true), getUsageSnapshot: () => lastSnap };
