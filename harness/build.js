'use strict';
// Builds page.html + data.js: the extension's real webview markup, script and stylesheet, fed with
// the extension's own demo events (run through its real handleRaw) outside VS Code.
const Module = require('module');
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, process.argv[2] || 'ext');
const ROOT = 'C:\\Users\\dev\\shop-api';

const handler = { get: (t, k) => (k === 'then' ? undefined : mock()), apply: () => mock(), construct: () => mock() };
function mock() { return new Proxy(function () {}, handler); }
const base = {
  workspace: { workspaceFolders: [{ uri: { fsPath: ROOT } }], getConfiguration: () => ({ get: () => undefined }) },
  commands: { executeCommand: async () => null },
  Uri: { file: (p) => ({ fsPath: p }), joinPath: (...a) => a.join('/') },
  version: '1.99.0',
};
const vscode = new Proxy(base, { get: (t, k) => (k in t ? t[k] : mock()) });
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : load.call(this, req, ...rest); };

const file = path.join(EXT, 'extension.js');
const src = fs.readFileSync(file, 'utf8');
const m = new Module(file, module);
m.filename = file;
m.paths = Module._nodeModulePaths(EXT);
m._compile(src + '\nmodule.exports.__t = { demoEvents, parallelDemoEvents, usageGuardDemoEvents, handleRaw, hookReply, refreshPlanFiles, take: () => { const x = events; events = []; return x; } };', file);
const T = m.exports.__t;

const realNow = Date.now;
async function run(raws, start = Date.parse('2026-11-13T09:00:00')) {
  let now = start;
  Date.now = () => now;
  for (const raw of raws) {
    await T.handleRaw({ ...raw, _demo: true });
    now += 4000 + (raw._pause || 0) * 4;
  }
  Date.now = realNow;
  return T.take();
}

// A stress session: long strings, many agents, many turns, a failure, and it ends waiting for approval.
function stress() {
  const s = 'stress-session';
  const f = (p) => path.join(ROOT, p);
  const pre = (tool, tool_input, extra) => ({ hook_event_name: 'PreToolUse', session_id: s, tool_name: tool, tool_input, ...extra });
  const post = (tool, tool_input, extra) => ({ hook_event_name: 'PostToolUse', session_id: s, tool_name: tool, tool_input, ...extra });
  const out = [{ hook_event_name: 'SessionStart', session_id: s }];
  const longPath = 'packages/internal-platform-services/src/features/authentication/providers/OpenIdConnectAuthorizationCodeFlowProviderImplementation.test.tsx';
  for (let turn = 0; turn < 7; turn++) {
    out.push({ hook_event_name: 'UserPromptSubmit', session_id: s, prompt: turn % 2 ? 'Fix it' : 'Refactor the authentication providers so every one of them shares the same token refresh logic, then update all the tests and the documentation — ' + 'and keep going '.repeat(6) });
    for (let i = 0; i < 6; i++) { out.push(pre('Read', { file_path: f('src/module' + turn + '/file' + i + '.ts') }), post('Read', { file_path: f('src/module' + turn + '/file' + i + '.ts') })); }
    out.push(pre('Grep', { pattern: 'refreshAccessTokenWithExponentialBackoffAndJitter|AuthorizationCodeFlow' }), post('Grep', { pattern: 'refreshAccessTokenWithExponentialBackoffAndJitter|AuthorizationCodeFlow' }));
    out.push(pre('Edit', { file_path: f(longPath), old_string: 'a', new_string: 'b' }, { _ranges: [{ start: 1204, end: 1260, symbol: 'refreshAccessTokenWithExponentialBackoffAndJitter' }] }), post('Edit', { file_path: f(longPath) }, { _ranges: [{ start: 1204, end: 1266, symbol: 'refreshAccessTokenWithExponentialBackoffAndJitter' }] }));
    out.push(pre('Bash', { command: 'pnpm --filter @internal/platform-services exec vitest run --reporter=verbose src/features/authentication && pnpm lint --fix' }));
    out.push(turn === 2
      ? { hook_event_name: 'PostToolUseFailure', session_id: s, tool_name: 'Bash', tool_input: { command: 'pnpm test' }, error: 'FAIL src/features/authentication/providers/OpenIdConnect.test.tsx > refresh > retries with backoff: expected 3 calls, received 4' }
      : post('Bash', { command: 'pnpm test' }));
    if (turn === 3) {
      const agents = ['Explore', 'general-purpose', 'TestWriter', 'Reviewer', 'security-and-compliance-auditor'].map((type, i) => ({ agent_id: 'st-a' + i, agent_type: type }));
      for (const a of agents) out.push(pre('Agent', { description: 'Check the ' + a.agent_type + ' side of the provider refactor in depth', subagent_type: a.agent_type, model: 'haiku' }), { hook_event_name: 'SubagentStart', session_id: s, ...a });
      for (let i = 0; i < 4; i++) for (const a of agents) out.push(pre('Read', { file_path: f('src/providers/p' + i + '.ts') }, a), post('Read', { file_path: f('src/providers/p' + i + '.ts') }, a));
      for (const a of agents) out.push({ hook_event_name: 'SubagentStop', session_id: s, ...a, last_assistant_message: 'Done with the ' + a.agent_type + ' review. ' + 'Nothing blocking was found. '.repeat(4) });
    }
    if (turn < 6) out.push({ hook_event_name: 'Stop', session_id: s, last_assistant_message: 'Turn ' + (turn + 1) + ' finished. ' + 'The providers now share one refresh helper and the tests pass. '.repeat(turn === 1 ? 10 : 2) });
  }
  out.push(pre('Bash', { command: 'git push --force-with-lease origin refactor/shared-token-refresh' }));
  out.push({ hook_event_name: 'PermissionRequest', session_id: s, tool_name: 'Bash', tool_input: { command: 'git push --force-with-lease origin refactor/shared-token-refresh' } });
  return out;
}

// A plan being carried out. withTasks: Claude keeps numbered tasks (phase 1 done, step 3 in progress).
// Without: no tasks at all, so progress is estimated from the files worked on.
function planRun(withTasks) {
  const s = withTasks ? 'plan-tasks' : 'plan-run';
  const f = (p) => path.join(ROOT, p);
  const plan = ['# Add request validation', '', '## Context', 'Requests are not validated today.', '', '## Understand',
    '1. Read \x60src/server.ts\x60 and note how routes are registered', '2. Review the tests in tests/server.test.ts', '', '## Build',
    '3. Add a validate middleware in \x60src/middleware/validate.ts\x60', '4. Register it in src/server.ts before the routes', '5. Document the new errors in README.md', '',
    '## Verify', '6. Run the test suite', '7. Run lint'].join('\n');
  const pre = (tool, tool_input) => ({ hook_event_name: 'PreToolUse', session_id: s, tool_name: tool, tool_input });
  const post = (tool, tool_input) => ({ hook_event_name: 'PostToolUse', session_id: s, tool_name: tool, tool_input });
  const both = (tool, input) => [pre(tool, input), post(tool, input)];
  const out = [{ hook_event_name: 'UserPromptSubmit', session_id: s, prompt: 'Add request validation to the API' },
    ...both('TaskCreate', { subject: '1. An old task from earlier work', description: '' }),
    pre('TaskUpdate', { taskId: '1', status: 'completed' }),
    ...both('ExitPlanMode', { plan })];
  if (withTasks) {
    for (let i = 1; i <= 7; i++) out.push(...both('TaskCreate', { subject: i + '. Step ' + i + ' of the plan' }));
    out.push(pre('TaskUpdate', { taskId: '2', status: 'completed' }), pre('TaskUpdate', { taskId: '3', status: 'completed' }), pre('TaskUpdate', { taskId: '4', status: 'in_progress' }));
  }
  out.push(...both('Read', { file_path: f('src/server.ts') }), ...both('Read', { file_path: f('tests/server.test.ts') }),
    ...both('Write', { file_path: f('src/middleware/validate.ts'), content: 'x' }), pre('Edit', { file_path: f('src/server.ts'), old_string: 'a', new_string: 'b' }));
  return out;
}

(async () => {
  const data = {
    empty: [],
    demo: await run(T.demoEvents()),
    parallel: await run(T.parallelDemoEvents()),
    guard: await run(T.usageGuardDemoEvents()),
    stress: await run(stress()),
  };
  data.planrun = await run(planRun(false));
  data.plantasks = await run(planRun(true));
  console.log('hook reply on approval:', JSON.stringify(T.hookReply({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', session_id: 'x' })).slice(0, 130));
  console.log('hook reply otherwise:', JSON.stringify(T.hookReply({ hook_event_name: 'PostToolUse', tool_name: 'Read', session_id: 'x' })));
  // Refresh reads a changed plan file again, once
  {
    const dir = path.join(require('os').tmpdir(), 'plan-refresh-test-' + process.pid, '.claude', 'plans');
    fs.mkdirSync(dir, { recursive: true });
    const pf = path.join(dir, 'p.md');
    fs.writeFileSync(pf, '# Test plan\n\n1. First step\n2. Second step\n');
    await T.handleRaw({ hook_event_name: 'PostToolUse', session_id: 'pf', tool_name: 'Write', tool_input: { file_path: pf, content: 'x' } });
    const r0 = T.refreshPlanFiles();
    fs.writeFileSync(pf, '# Test plan\n\n1. First step\n2. Second step\n3. A step added by hand\n');
    const r1 = T.refreshPlanFiles();
    const r2 = T.refreshPlanFiles();
    const evs = T.take();
    console.log('plan refresh: unchanged', JSON.stringify(r0), '| changed', JSON.stringify(r1), '| again', JSON.stringify(r2), '| last event', evs[evs.length - 1].ev, /added by hand/.test(evs[evs.length - 1].planUpdate));
    fs.rmSync(path.join(require('os').tmpdir(), 'plan-refresh-test-' + process.pid), { recursive: true, force: true });
  }
  // two sessions at once, so the session picker shows
  data.multi = data.demo.concat((await run(T.parallelDemoEvents())).map((e) => ({ ...e, id: e.id + 100000 })));
  fs.writeFileSync(path.join(__dirname, 'data.js'), 'window.DATA = ' + JSON.stringify(data) + ';\n');

  const body = src.slice(src.indexOf('<body>') + 6, src.indexOf('<script nonce='));
  const rel = path.basename(EXT);
  fs.writeFileSync(path.join(__dirname, 'page-' + rel + '.html'), `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="theme.css" rel="stylesheet"><link href="${rel}/media/main.css" rel="stylesheet"><title>Claude Activity</title></head>
<body>${body}<script src="data.js"></script><script src="stub.js"></script><script src="${rel}/media/main.js"></script></body></html>`);
  console.log(Object.entries(data).map(([k, v]) => k + ':' + v.length).join(' '));
  process.exit(0);
})();
