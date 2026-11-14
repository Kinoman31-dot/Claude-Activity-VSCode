'use strict';
// One-off (14 Nov 2026): settings for the usage guard and for customising the chart.
// Run from the project folder: node tools/patch-settings.js
const fs = require('fs');
const path = require('path');
const E = path.join(__dirname, '..', 'extension');
function patch(file, fn) {
  const f = path.join(E, file);
  let t = fs.readFileSync(f, 'utf8');
  const crlf = t.includes('\r\n');
  const eol = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
  fn({
    rep(a, b) {
      a = eol(a); b = eol(b);
      if (t.split(a).length !== 2) throw new Error(file + ': expected exactly one match for: ' + a.slice(0, 80));
      t = t.replace(a, () => b);
    },
    all(a, b) { if (!t.includes(a)) throw new Error(file + ': not found: ' + a); t = t.split(a).join(b); },
    between(start, end, b) {
      const i = t.indexOf(eol(start)), j = t.indexOf(eol(end));
      if (i < 0 || j < i) throw new Error(file + ': markers not found: ' + start.slice(0, 50));
      t = t.slice(0, i) + eol(b) + t.slice(j);
    },
  });
  fs.writeFileSync(f, t);
}

// ======================= extension.js =======================
patch('extension.js', ({ rep, all }) => {
  rep(`const MAX_EVENTS = 3000;`, `const MAX_EVENTS = 3000;   // the default; see maxEvents()
// how many events are kept (and stored for the workspace), from the settings
function maxEvents() {
  const n = Number(vscode.workspace.getConfiguration('claudeGraph').get('maxEvents'));
  return Number.isFinite(n) ? Math.min(20000, Math.max(200, Math.round(n))) : MAX_EVENTS;
}`);
  all(`slice(-MAX_EVENTS)`, `slice(-maxEvents())`);
  all(`if (events.length > MAX_EVENTS)`, `if (events.length > maxEvents())`);
  rep(`  return {
    autoPlan: cfg.get('autoShowPlan') !== false,
    group: cfg.get('groupRepeats') !== false,
    fold: cfg.get('foldEarlierTurns') !== false,
  };`, `  return {
    autoPlan: cfg.get('autoShowPlan') !== false,
    group: cfg.get('groupRepeats') !== false,
    fold: cfg.get('foldEarlierTurns') !== false,
    // how the chart looks and behaves
    density: cfg.get('density') === 'compact' ? 'compact' : 'comfortable',
    usage: cfg.get('showUsageStrip') !== false,
    answer: cfg.get('showAnswerBanner') !== false,
    timings: cfg.get('showTimings') !== false,
    follow: cfg.get('followNewActions') !== false,
    foldPhases: cfg.get('foldFinishedPhases') !== false,
    estimate: cfg.get('estimatePlanSteps') !== false,
    // where a newly opened panel starts (after that, the panel remembers what you chose in it)
    defaultView: ['flow', 'graph', 'plan'].includes(cfg.get('defaultView')) ? cfg.get('defaultView') : 'flow',
    aside: cfg.get('showActivityList') !== false,
    mode: cfg.get('activityListMode') === 'timeline' ? 'time' : 'agent',
  };`);
  rep(`    } else if (m.type === 'planRefresh') {`, `    } else if (m.type === 'settings') {
      vscode.commands.executeCommand('claudeGraph.openSettings');
    } else if (m.type === 'planRefresh') {`);
  rep(`    vscode.commands.registerCommand('claudeGraph.newPlan', newPlanConversation),`, `    vscode.commands.registerCommand('claudeGraph.newPlan', newPlanConversation),
    vscode.commands.registerCommand('claudeGraph.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + context.extension.id)),`);
  rep(`  <button id="update" role="menuitem"`, `  <button id="settings" role="menuitem" title="Everything that can be changed: the chart, the usage bar and the usage guard">Settings…</button>
  <button id="update" role="menuitem"`);
});

// ======================= media/main.js =======================
patch('media/main.js', ({ rep }) => {
  rep(`  let opts = { autoPlan: true, group: true, fold: true };   // user settings, sent by the extension`,
      `  // user settings, sent by the extension
  const OPT_DEFAULTS = { autoPlan: true, group: true, fold: true, density: 'comfortable', usage: true, answer: true, timings: true, follow: true, foldPhases: true, estimate: true, defaultView: 'flow', aside: true, mode: 'agent' };
  let opts = Object.assign({}, OPT_DEFAULTS);`);
  rep(`    const show = !!answerTurn && !flowEl.hidden;`, `    const show = !!answerTurn && !flowEl.hidden && opts.answer !== false;`);
  rep(`    if (made && live && Date.now() - lastUserScroll > 4000 && !flowEl.hidden) {`, `    if (made && live && opts.follow !== false && Date.now() - lastUserScroll > 4000 && !flowEl.hidden) {`);
  rep(`      const closed = want ? want === 'closed' : allDone;`, `      const closed = want ? want === 'closed' : allDone && opts.foldPhases !== false;`);
  rep(`        const guess = S.plan.state === 'approved' ? inferSteps(S.plan.steps, S) : [];`, `        const guess = S.plan.state === 'approved' && opts.estimate !== false ? inferSteps(S.plan.steps, S) : [];`);
  rep(`    if (id && id !== planUi.now && !planEl.hidden && Date.now() - planUi.touched > 4000) now.go(false);`, `    if (id && id !== planUi.now && !planEl.hidden && opts.follow !== false && Date.now() - planUi.touched > 4000) now.go(false);`);
  rep(`  function renderUsage(u) {
    const el = $('usage');
    el.textContent = '';
    if (!u) { el.hidden = true; return; }`, `  let lastUsage = null;
  function renderUsage(u) {
    const el = $('usage');
    lastUsage = u;
    el.textContent = '';
    if (!u || opts.usage === false) { el.hidden = true; return; }`);
  rep(`  const ui = Object.assign({ mode: 'agent', view: 'flow', align: false }, (vscode.getState && vscode.getState()) || {});`,
      `  // a panel opened for the first time starts the way the settings say; after that it keeps what you chose in it
  let uiFresh = !(vscode.getState && vscode.getState());
  const ui = Object.assign({ mode: 'agent', view: 'flow', align: false }, (vscode.getState && vscode.getState()) || {});`);
  rep(`      const o = Object.assign({ autoPlan: true, group: true, fold: true }, msg.opts || {});
      const redo = o.group !== opts.group || o.fold !== opts.fold;
      state = msg; opts = o;
      if (redo && history.length) rebuild();`, `      const o = Object.assign({}, OPT_DEFAULTS, msg.opts || {});
      const redo = o.group !== opts.group || o.fold !== opts.fold;
      const looks = o.density !== opts.density || o.timings !== opts.timings || o.answer !== opts.answer;
      const plansChanged = o.foldPhases !== opts.foldPhases || o.estimate !== opts.estimate;
      const usageChanged = o.usage !== opts.usage;
      state = msg; opts = o;
      document.body.classList.toggle('compact', opts.density === 'compact');
      document.body.classList.toggle('noTimes', opts.timings === false);
      if (uiFresh) {
        uiFresh = false;
        ui.view = opts.defaultView; ui.mode = opts.mode; if (opts.aside === false) ui.aside = false;
        applyUi();
      }
      if (redo && history.length) rebuild();
      else {
        if (looks) { placeAnswer(); for (const T of turns) T.dirty = true; queueLines(); }
        if (plansChanged) renderPlans();
      }
      if (usageChanged) renderUsage(lastUsage);`);
  rep(`  send('clear', 'clear'); send('update', 'update');`, `  send('clear', 'clear'); send('update', 'update'); send('settings', 'settings');`);
});

// ======================= media/main.css =======================
{
  const f = path.join(E, 'media', 'main.css');
  const css = `
/* ================= settings pass (14 Nov 2026) ================= */
/* claudeGraph.density = compact: more of the chart on screen */
body.compact #flowInner { padding-top: 8px; }
body.compact .turn .grid { row-gap: 18px; }
body.compact .box { min-height: 36px; padding: 5px 10px 6px; gap: 1px; }
body.compact .box.act > .text { -webkit-line-clamp: 1; }
body.compact .box.head, body.compact .box.term { padding: 4px 14px 5px; }
body.compact .group li, body.compact #feed li { line-height: 1.45; }
body.compact .pcol { gap: 6px; padding: 8px; }
body.compact .pcard { padding: 5px 9px 6px; }
body.compact .pbody { -webkit-line-clamp: 2; }
/* claudeGraph.showTimings = false */
body.noTimes .box .dur { display: none; }
`;
  if (!fs.readFileSync(f, 'utf8').includes('settings pass (14 Nov 2026)')) fs.appendFileSync(f, css);
}

// ======================= usage-bar.js: the usage guard, set up and switched from the settings =======================
patch('usage-bar.js', ({ rep, between }) => {
  between(`async function chooseUsageHookScript() {`, `async function firstRunHint() {`, `// ---------- usage guard: set up, on and off, thresholds ----------
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
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\\n');
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

`);
  rep(`    vscode.commands.registerCommand('claudeUsageBar.enableUsageGuard', enableUsageGuard),
    vscode.commands.registerCommand('claudeUsageBar.disableUsageGuard', disableUsageGuard),`,
      `    vscode.commands.registerCommand('claudeUsageBar.enableUsageGuard', () => setGuard(true)),
    vscode.commands.registerCommand('claudeUsageBar.disableUsageGuard', () => setGuard(false)),
    vscode.commands.registerCommand('claudeUsageBar.guardStatus', guardStatus),
    vscode.commands.registerCommand('claudeUsageBar.guardSettings', openGuardSettings),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (guardSyncing || !e.affectsConfiguration('claudeUsageGuard')) return;
      if (e.affectsConfiguration('claudeUsageGuard.enabled')) setGuard(gcfg().get('enabled') === true, true);
      else if (guardInstalled()) writeGuardConfig();
    }),`);
  rep(`  timer = setInterval(() => tick(false), TICK_MS);
  startWatching();`, `  // the guard: show its real state in the settings, and keep the shipped scripts current when they are the ones in use
  try {
    const installed = guardInstalled();
    if (installed && installed.script) ctx.globalState.update('usageHookScriptPath', installed.script);
    if (installed && installed.script && path.resolve(path.dirname(installed.script)) === path.resolve(GUARD_HOME, 'scripts')) deployBundledGuard();
    syncGuardSetting();
  } catch (e) { log('Usage guard check failed: ' + e.message); }

  timer = setInterval(() => tick(false), TICK_MS);
  startWatching();`);
  rep(`module.exports = { activateUsageBar,`, `module.exports = { _guard: { setGuard, writeGuardConfig, guardInstalled, guardScript }, activateUsageBar,`);
});

// ======================= package.json =======================
{
  const f = path.join(E, 'package.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const cmds = j.contributes.commands;
  const title = (id, t) => { const c = cmds.find((x) => x.command === id); if (c) c.title = t; else cmds.push({ command: id, title: t }); };
  title('claudeUsageBar.enableUsageGuard', 'Claude Usage Guard: Turn On');
  title('claudeUsageBar.disableUsageGuard', 'Claude Usage Guard: Turn Off');
  title('claudeUsageBar.guardStatus', 'Claude Usage Guard: Show Status');
  title('claudeUsageBar.guardSettings', 'Claude Usage Guard: Open Settings');
  title('claudeGraph.openSettings', 'Claude Graph: Open Settings');

  const graph = j.contributes.configuration.find((c) => c.title === 'Claude Graph').properties;
  Object.assign(graph, {
    'claudeGraph.defaultView': { type: 'string', enum: ['flow', 'graph', 'plan'], enumDescriptions: ['Flowchart: boxes in the order things happened', 'Graph: agents, files and code sections as a network', 'Plan: the proposed plan and the task list'], default: 'flow', description: 'The view a newly opened chart starts in. After that the panel remembers the view you chose in it.' },
    'claudeGraph.density': { type: 'string', enum: ['comfortable', 'compact'], enumDescriptions: ['Roomy boxes; an action may take two lines', 'Smaller boxes and lists, one line per action: more of the chart on screen'], default: 'comfortable', description: 'How much room boxes and list lines take.' },
    'claudeGraph.showActivityList': { type: 'boolean', default: true, description: 'Show the activity list in a newly opened chart. The Activity button in the chart switches it at any time.' },
    'claudeGraph.activityListMode': { type: 'string', enum: ['byAgent', 'timeline'], enumDescriptions: ['Actions grouped under the agent that did them', 'All actions in time order'], default: 'byAgent', description: 'How the activity list is arranged in a newly opened chart.' },
    'claudeGraph.showUsageStrip': { type: 'boolean', default: true, description: 'Show the Claude usage strip along the bottom of the chart. The usage bar in the status bar is not affected.' },
    'claudeGraph.showAnswerBanner': { type: 'boolean', default: true, description: 'Show Claude\'s answer in a banner above the flowchart.' },
    'claudeGraph.showTimings': { type: 'boolean', default: true, description: 'Show how long each action took on its box.' },
    'claudeGraph.followNewActions': { type: 'boolean', default: true, description: 'Scroll to the newest action (and, in the Plan view, to the step being worked on) as work goes on. Scrolling yourself always pauses this for a few seconds.' },
    'claudeGraph.foldFinishedPhases': { type: 'boolean', default: true, description: 'In the Plan view, fold a phase away when all its steps are done.' },
    'claudeGraph.estimatePlanSteps': { type: 'boolean', default: true, description: 'In the Plan view, estimate the status of steps nobody reports on from the files Claude works on ("Started", "Likely done").' },
    'claudeGraph.maxEvents': { type: 'number', default: 3000, minimum: 200, maximum: 20000, description: 'How many events the chart keeps and stores for the workspace. Older ones are dropped.' },
  });

  if (!j.contributes.configuration.some((c) => c.title === 'Claude Usage Guard')) {
    const pct = (def, text) => ({ type: ['number', 'null'], default: null, minimum: 1, maximum: 100, markdownDescription: text + ' Leave empty for the guard\'s own value (' + def + ').' });
    j.contributes.configuration.push({
      title: 'Claude Usage Guard',
      properties: {
        'claudeUsageGuard.enabled': { type: 'boolean', default: false, markdownDescription: 'Turn the usage guard on or off. On: Claude Code is asked for a hand-off file and then stopped shortly before the 5-hour limit, and continues in a new session after the reset. This adds or removes the guard\'s hooks in Claude Code\'s user settings (`~/.claude/settings.json`); other hooks are kept. Needs Node.js. Applies to Claude Code sessions started afterwards.' },
        'claudeUsageGuard.carefulAt': pct(75, 'Percent of the 5-hour limit from which Claude is asked to work in small steps.'),
        'claudeUsageGuard.handoffAt': pct(85, 'Percent from which Claude is asked to write the hand-off file.'),
        'claudeUsageGuard.updateAt': pct(90, 'Percent from which Claude is asked for one short update of the hand-off file.'),
        'claudeUsageGuard.endAt': pct(95, 'Percent a session must end at or below. The guard stops a little earlier, leaving room for the final reply.'),
        'claudeUsageGuard.weeklyWarnAt': { type: ['number', 'null'], default: null, minimum: 0, maximum: 100, markdownDescription: 'Percent of a weekly limit from which Claude warns you (it never stops for a weekly limit). `0` switches the warning off. Leave empty for the guard\'s own value (80).' },
        'claudeUsageGuard.scriptPath': { type: 'string', default: '', markdownDescription: 'Only if you keep the guard scripts somewhere of your own: the full path of `usage-hook.js`. Empty uses the guard that is already installed, or else the copy that ships with this extension.' },
      },
    });
  }
  const gt = j.contributes.configuration.find((c) => c.title === 'Claude Usage Bar').properties['claudeUsageBar.guardThreshold'];
  if (gt) gt.description = 'Upper bound for the usage guard: it never stops later than this percentage, whatever its own settings say.';
  fs.writeFileSync(f, JSON.stringify(j, null, '\t') + '\n');
}
console.log('settings patch applied');
