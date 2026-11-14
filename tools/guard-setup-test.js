'use strict';
// Turns the usage guard on and off the way the extension does, in a throw-away home folder:
// the real guard scripts are run by Node.js, but against a temporary Claude settings file.
//   node tools/guard-setup-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const assert = require('assert/strict');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-setup-test-'));
os.homedir = () => home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.USAGE_GUARD_DIR = path.join(home, '.claude-usage-guard');
process.env.USAGE_FILE = path.join(home, '.claude-usage.json');
process.env.USAGE_GUARD_AUTOSTART = 'off';
process.env.USAGE_GUARD_FETCH = 'off';
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
// another tool's hook, which must survive
const settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other' }] }] } }));

const store = { 'claudeUsageGuard.enabled': false, 'claudeUsageGuard.handoffAt': 80, 'claudeUsageGuard.weeklyWarnAt': 70 };
const said = [];
const vscode = {
  workspace: {
    getConfiguration: (section) => ({
      get: (k, d) => (section + '.' + k in store ? store[section + '.' + k] : d),
      update: async (k, v) => { store[section + '.' + k] = v; },
      inspect: (k) => ({ globalValue: store[section + '.' + k] }),
    }),
    onDidChangeConfiguration: () => ({}),
  },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => said.push('log: ' + l), show() {} }),
    createStatusBarItem: () => ({ show() {} }),
    onDidChangeWindowState: () => ({}),
    showInformationMessage: async (m) => { said.push('info: ' + m); },
    showWarningMessage: async (m) => { said.push('warning: ' + m); },
    showErrorMessage: async (m) => { said.push('error: ' + m); },
  },
  commands: { registerCommand: () => ({}), executeCommand: async () => {} },
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class {},
  MarkdownString: class { appendMarkdown() {} },
  ConfigurationTarget: { Global: 1 },
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : load.call(this, request, ...rest); };

const bar = require(path.join(__dirname, '..', 'extension', 'usage-bar.js'));
const G = bar._guard;
const hooks = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks || {};
const ours = () => Object.values(hooks()).flat().flatMap((g) => g.hooks || []).filter((h) => String(h.command).includes('usage-hook.js'));
const step = (s) => console.log('ok  ' + s);

(async () => {
  const state = new Map();
  bar.activateUsageBar({ subscriptions: [], globalState: { get: (k) => state.get(k), update: async (k, v) => { state.set(k, v); } } });
  assert.equal(G.guardInstalled(), null);
  step('starts off');

  assert.equal(await G.setGuard(true), true);
  const mine = ours();
  assert.equal(mine.length, 3, 'three hooks: before a tool, end of turn, prompt');
  const shipped = path.join(process.env.USAGE_GUARD_DIR, 'scripts', 'usage-hook.js');
  const norm = (s) => s.replace(/\\/g, '/').toLowerCase();   // the hook command may use either kind of slash
  assert.ok(mine.every((h) => norm(h.command).includes(norm(shipped))), 'they run the copy in the guard folder, not the one inside the extension');
  assert.ok(fs.existsSync(shipped) && fs.existsSync(path.join(path.dirname(shipped), 'usage-core.js')));
  assert.equal(store['claudeUsageGuard.enabled'], true, 'the setting shows the real state');
  assert.equal(hooks().PreToolUse.some((g) => (g.hooks || []).some((h) => h.command === 'echo other')), true, 'the other hook is kept');
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.USAGE_GUARD_DIR, 'config.json'), 'utf8'));
  assert.deepEqual(cfg, { handoffAt: 80, weeklyWarnAt: 70 }, 'only the thresholds that were set are written');
  step('turned on with no file to pick: 3 hooks, scripts in ' + path.dirname(shipped).replace(home, '~') + ', config ' + JSON.stringify(cfg));

  assert.equal(await G.setGuard(true), true);
  assert.equal(ours().length, 3, 'on twice does not add hooks twice');
  step('turning it on again changes nothing');

  assert.equal(await G.setGuard(false), true);
  assert.equal(ours().length, 0);
  assert.equal(store['claudeUsageGuard.enabled'], false);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).model, 'x');
  assert.equal(hooks().PreToolUse.length, 1, 'the other hook is still there');
  step('turned off: guard hooks gone, everything else in the settings file kept');

  store['claudeUsageGuard.carefulAt'] = 90;   // above the hand-off at 80: not a usable order
  assert.equal(await G.setGuard(true), false);
  assert.equal(ours().length, 0);
  assert.equal(store['claudeUsageGuard.enabled'], false);
  step('thresholds in the wrong order: refused, nothing installed (' + said.filter((s) => s.startsWith('error')).pop() + ')');

  bar.deactivateUsageBar();
  fs.rmSync(home, { recursive: true, force: true });
  console.log('ALL OK');
  process.exit(0);
})().catch((e) => {
  console.error('FAILED: ' + ((e && e.stack) || e));
  console.error(said.slice(-6).join('\n'));
  try { bar.deactivateUsageBar(); } catch (_) { /* not started */ }
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(1);
});
