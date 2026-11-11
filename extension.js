// Activity Graph for Claude Code
// Receives Claude Code hook events over a local HTTP port and draws them live.
'use strict';
const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const HOOK_PATH = '/claude-graph';
const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd', 'PermissionRequest', 'Notification',
];
const MAX_EVENTS = 3000;
const MAX_BODY = 25 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;

let context;
let server = null;
let port = 0;
let panel = null;           // the optional editor-tab copy
const views = new Set();    // every open webview: the docked view and the editor tab
let statusItem;
let events = [];
let seq = 0;
let queue = Promise.resolve();
let decoration;
const highlights = new Map(); // fsPath -> [{start, end, expires}]
let highlightTimer = null;
let demoTimers = [];
let waiting = false;      // Claude Code is blocked on a permission prompt
let storeFile = null;     // where received events are kept so a reload does not lose them

// ---------- workspace helpers ----------

function roots() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

function workspaceRoot() {
  return roots()[0] || null;
}

// one settings file per folder in the workspace, so every folder reports to this window
function settingsFiles() {
  return roots().map((r) => path.join(r, '.claude', 'settings.local.json'));
}

function isOurHook(h) {
  return h && h.type === 'http' && typeof h.url === 'string' &&
    /^http:\/\/127\.0\.0\.1:\d+\/claude-graph$/.test(h.url);
}

function readSettings(p) {
  if (!fs.existsSync(p)) return {};
  const text = fs.readFileSync(p, 'utf8').trim();
  return text ? JSON.parse(text) : {};
}

function installedPort() {
  for (const p of settingsFiles()) {
    try {
      const s = readSettings(p);
      for (const groups of Object.values(s.hooks || {})) {
        for (const g of groups || []) {
          for (const h of (g && g.hooks) || []) {
            if (isOurHook(h)) return Number(h.url.match(/:(\d+)\//)[1]);
          }
        }
      }
    } catch (e) { /* unreadable settings: treated as not installed */ }
  }
  return 0;
}

function hooksComplete() {
  const files = settingsFiles();
  return files.length > 0 && files.every((p) => {
    try {
      const hooks = readSettings(p).hooks || {};
      return HOOK_EVENTS.every((ev) => (hooks[ev] || []).some((g) => ((g && g.hooks) || []).some(isOurHook)));
    } catch (e) { return false; }
  });
}

function stripOurHooks(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return;
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev]
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurHook(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (hooks[ev].length === 0) delete hooks[ev];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
}

function writeHooks(install) {
  const files = settingsFiles();
  if (!files.length) throw new Error('Open a folder first: hooks are stored in the folder\'s .claude/settings.local.json.');
  // read everything first, so a broken file stops the whole operation before anything is written
  const loaded = files.map((p) => {
    try { return { p, settings: readSettings(p) }; }
    catch (e) { throw new Error(`${p} is not valid JSON, so it was left untouched. Fix it and try again.`); }
  });
  for (const { p, settings } of loaded) {
    stripOurHooks(settings);
    if (install) {
      settings.hooks = settings.hooks || {};
      for (const ev of HOOK_EVENTS) {
        settings.hooks[ev] = settings.hooks[ev] || [];
        settings.hooks[ev].push({
          hooks: [{ type: 'http', url: `http://127.0.0.1:${port}${HOOK_PATH}`, timeout: 5 }],
        });
      }
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
  }
}

// ---------- local server ----------

function preferredPort() {
  const existing = installedPort();
  if (existing) return existing;
  const root = workspaceRoot() || 'no-folder';
  const h = crypto.createHash('sha1').update(root).digest();
  return 47800 + (h.readUInt16BE(0) % 1000);
}

function listen(p) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(onRequest);
    s.once('error', reject);
    s.listen(p, '127.0.0.1', () => resolve(s));
  });
}

async function startServer() {
  const first = preferredPort();
  for (let i = 0; i < 25; i++) {
    try {
      server = await listen(first + i);
      port = first + i;
      return;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error('No free local port found for the activity graph.');
}

function onRequest(req, res) {
  if (req.method !== 'POST' || !req.url || !req.url.startsWith(HOOK_PATH)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) tooBig = true;
    else chunks.push(c);
  });
  req.on('end', () => {
    // Always answer straight away with an empty 200 so Claude Code is never held up.
    res.writeHead(200);
    res.end();
    if (tooBig) return;
    let raw;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return; }
    enqueue(raw);
  });
  req.on('error', () => {});
}

function enqueue(raw) {
  queue = queue.then(() => handleRaw(raw)).catch((e) => console.error('claude-graph', e));
}

// ---------- event normalisation ----------

function classify(tool) {
  if (!tool) return 'other';
  if (tool === 'Read' || tool === 'NotebookRead') return 'read';
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'edit';
  if (tool === 'Write') return 'write';
  if (tool === 'Grep' || tool === 'Glob' || tool === 'LS') return 'search';
  if (tool === 'Bash' || tool === 'BashOutput' || tool === 'PowerShell') return 'run';
  if (tool === 'Agent' || tool === 'Task') return 'spawn';
  if (tool === 'WebSearch' || tool === 'WebFetch') return 'web';
  if (tool === 'ExitPlanMode') return 'plan';
  if (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate' || tool === 'TaskList' || tool === 'TaskGet') return 'tasks';
  if (tool.startsWith('mcp__')) return 'mcp';
  return 'other';
}

function short(s, n) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function relPath(abs, cwd) {
  const rs = roots();
  for (const r of rs.length ? rs : [cwd].filter(Boolean)) {
    const rel = path.relative(r, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return (rs.length > 1 ? path.basename(r) + '/' : '') + rel.split(path.sep).join('/');
    }
  }
  // outside the workspace: the last two parts are enough to recognise the file
  const parts = abs.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : abs;
}

// A shell command without the "cd <folder> &&" that Claude Code often puts in front of it.
function cleanCommand(cmd) {
  if (typeof cmd !== 'string') return '';
  return cmd.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '');
}

// "mcp__server__tool_name" reads better as "server: tool name".
function mcpName(tool) {
  const parts = String(tool).split('__').filter(Boolean).slice(1);
  if (!parts.length) return tool;
  const name = (s) => s.replace(/[_-]+/g, ' ').trim();
  return parts.length > 1 ? name(parts[0]) + ': ' + name(parts.slice(1).join(' ')) : name(parts[0]);
}

// What a tool with no category of its own was used for, when its input says so.
function otherDetail(tool, input) {
  if (tool === 'Skill' && input.skill) return short(String(input.skill).replace(/^.*:/, ''), 80);
  if (tool === 'ToolSearch' && input.query) return short(String(input.query).replace(/^select:/, ''), 80);
  if (tool === 'AskUserQuestion' && Array.isArray(input.questions) && input.questions[0]) return short(input.questions[0].question, 120);
  return tool;
}

function clip(text) {
  if (typeof text !== 'string' || !text) return '';
  const lines = text.replace(/\n$/, '').split('\n');
  const out = lines.slice(0, 14).map((l) => (l.length > 110 ? l.slice(0, 109) + '…' : l));
  if (lines.length > 14) out.push('… ' + (lines.length - 14) + ' more lines');
  return out.join('\n');
}

// The id Claude Code gave a new task, wherever the tool result happens to carry it.
function findTaskId(resp) {
  if (resp == null) return null;
  if (typeof resp === 'object') {
    const id = (resp.task && resp.task.id) || resp.taskId || resp.id;
    if (id != null) return String(id);
  }
  const text = typeof resp === 'string' ? resp : JSON.stringify(resp);
  const m = text.match(/#(\d+)/) || text.match(/"(?:taskId|id)"\s*:\s*"?(\w+)/);
  return m ? m[1] : null;
}

function planTitle(plan) {
  const lines = plan.split('\n').map((l) => l.trim()).filter(Boolean);
  const h = lines.find((l) => /^#{1,3}\s+/.test(l));
  return short((h || lines[0] || 'Plan').replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, ''), 90);
}

function locate(text, needle) {
  if (typeof needle !== 'string' || !needle.trim()) return null;
  const i = text.indexOf(needle);
  if (i < 0) return null;
  const start = text.slice(0, i).split('\n').length;
  const lines = needle.replace(/\n$/, '').split('\n').length;
  return { start, end: start + lines - 1 };
}

const CONTAINER_KINDS = new Set([1, 2, 3, 4, 5, 8, 9, 10, 11, 14, 22]); // module…function, string (markdown headings), struct

function deepestSymbol(symbols, line0) {
  let best = null;
  const visit = (list) => {
    for (const s of list || []) {
      const r = s.range || (s.location && s.location.range);
      if (!r || line0 < r.start.line || line0 > r.end.line) continue;
      if (CONTAINER_KINDS.has(s.kind) || !best) best = s;
      visit(s.children);
    }
  };
  visit(symbols);
  return best ? best.name : null;
}

const SYMBOL_RE = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?(?:static\s+)?(?:function\*?|class|def|fn|func|interface|struct|enum|impl|trait|module|namespace)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\(|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s+(?:(?:async|static|public|private|protected|override)\s+)*(?!(?:if|for|while|switch|catch|return|else|do|try)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
  /^#{1,6}\s+(.{1,60})/,
];

function heuristicSymbol(lines, line1) {
  for (let i = Math.min(line1, lines.length) - 1, n = 0; i >= 0 && n < 400; i--, n++) {
    for (const re of SYMBOL_RE) {
      const m = lines[i].match(re);
      if (m) return m[1].trim();
    }
  }
  return null;
}

async function symbolFor(abs, text, line1) {
  try {
    const call = vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', vscode.Uri.file(abs));
    const symbols = await Promise.race([call, new Promise((r) => setTimeout(() => r(null), 1200))]);
    if (Array.isArray(symbols) && symbols.length) {
      const name = deepestSymbol(symbols, line1 - 1);
      if (name) return name;
    }
  } catch (e) { /* fall through to the text scan */ }
  return heuristicSymbol(text.split('\n'), line1);
}

async function rangesFor(raw, action, abs, isPost) {
  const input = raw.tool_input || {};
  if (Array.isArray(raw._ranges)) return raw._ranges; // demo events
  if (!abs) return [];
  if (action === 'read') {
    const start = Number(input.offset);
    const limit = Number(input.limit);
    if (!start || !limit) return [];
    return [{ start, end: start + limit - 1 }];
  }
  if (action !== 'edit') return [];
  let text;
  try {
    if (fs.statSync(abs).size > MAX_FILE) return [];
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) { return []; }
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  const out = [];
  for (const e of edits.slice(0, 12)) {
    // Before the edit the file still holds old_string; afterwards it holds new_string.
    const r = locate(text, isPost ? e.new_string : e.old_string) || (isPost ? null : locate(text, e.new_string));
    if (!r) continue;
    r.symbol = await symbolFor(abs, text, r.start);
    out.push(r);
  }
  return out;
}

async function handleRaw(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.hook_event_name !== 'string') return;
  const ev = raw.hook_event_name;
  const input = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
  const action = raw.tool_name ? classify(raw.tool_name) : null;
  const e = {
    id: ++seq,
    t: Date.now(),
    ev,
    session: raw.session_id || 'session',
    agentId: raw.agent_id || null,
    agentType: raw.agent_type || null,
    tool: raw.tool_name || null,
    toolUseId: raw.tool_use_id || null,
    action,
  };
  if (ev === 'UserPromptSubmit') e.detail = short(raw.prompt, 140);
  if (ev === 'PostToolUseFailure') e.error = short(raw.error, 140);
  if (ev === 'Stop' || ev === 'SubagentStop') e.detail = short(raw.last_assistant_message, ev === 'Stop' ? 900 : 420);
  if (ev === 'Notification') { e.detail = short(raw.message, 160); e.ntype = raw.notification_type || null; }

  if (action) {
    const filePath = input.file_path || input.notebook_path;
    if (typeof filePath === 'string' && ['read', 'edit', 'write'].includes(action)) {
      const abs = path.isAbsolute(filePath) ? filePath : path.resolve(raw.cwd || workspaceRoot() || '.', filePath);
      e.abs = abs;
      e.file = relPath(abs, raw.cwd);
      if (ev === 'PreToolUse' || ev === 'PostToolUse') {
        e.ranges = await rangesFor(raw, action, abs, ev === 'PostToolUse');
      }
    }
    if (ev === 'PreToolUse' && action === 'edit') {
      e.diff = (Array.isArray(input.edits) ? input.edits : [input]).slice(0, 3)
        .map((x) => ({ o: clip(x && x.old_string), n: clip(x && x.new_string) })).filter((d) => d.o || d.n);
    }
    if (ev === 'PreToolUse' && action === 'write' && typeof input.content === 'string') {
      e.lines = input.content.split('\n').length;
    }
    if (action === 'run') {
      // the plain-words description when Claude Code gives one; the command itself goes in the tooltip
      const cmd = cleanCommand(input.command);
      e.detail = short(input.description || cmd, 140);
      if (input.description && cmd) e.cmd = short(cmd, 400);
    }
    else if (action === 'search') e.detail = short(input.pattern || input.path, 100);
    else if (action === 'web') e.detail = short(input.query || input.url, 120);
    else if (action === 'spawn') {
      e.detail = short(input.description || input.prompt, 100);
      e.subagentType = input.subagent_type || null;
      // the model Claude Code was asked to run the agent on (haiku, sonnet, opus...), when it was given
      e.model = typeof input.model === 'string' && input.model ? short(input.model, 30) : null;
    } else if (action === 'plan') {
      if (typeof input.plan === 'string' && input.plan.trim()) {
        e.plan = input.plan.slice(0, 12000);
        e.detail = planTitle(input.plan);
      } else e.detail = 'Plan ready for your approval';
    } else if (action === 'tasks') {
      if (raw.tool_name === 'TodoWrite' && Array.isArray(input.todos)) {
        e.todos = input.todos.slice(0, 80).map((t) => ({
          text: short((t && (t.content || t.subject || t.activeForm)) || '', 160), status: (t && t.status) || 'pending',
        }));
        e.detail = e.todos.length + (e.todos.length === 1 ? ' task' : ' tasks');
      } else if (raw.tool_name === 'TaskCreate') {
        e.task = { subject: short(input.subject, 160), desc: short(input.description, 260) };
        if (ev === 'PostToolUse') e.task.id = findTaskId(raw.tool_response);
        e.detail = 'add: ' + e.task.subject;
      } else if (raw.tool_name === 'TaskUpdate') {
        e.task = { id: input.taskId != null ? String(input.taskId) : null, status: input.status || null, subject: input.subject ? short(input.subject, 160) : null };
        e.detail = 'task ' + (e.task.id || '') + (e.task.status ? ': ' + String(e.task.status).replace('_', ' ') : '');
      } else e.detail = raw.tool_name;
    } else if (action === 'mcp') e.detail = mcpName(raw.tool_name);
    else if (action === 'other') e.detail = otherDetail(raw.tool_name, input);
  }

  events.push(e);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  if (!raw._demo) persist(e);
  if (ev === 'PermissionRequest' || (ev === 'Notification' && e.ntype === 'permission_prompt')) waiting = true;
  else if (ev !== 'Notification') waiting = false;
  post({ type: 'event', event: e });
  if (!views.size && vscode.workspace.getConfiguration('claudeGraph').get('openOnActivity')) showDefault();
  updateStatus();

  if (ev === 'PostToolUse' && action === 'edit' && e.abs && e.ranges && e.ranges.length) {
    addHighlight(e.abs, e.ranges);
  }
}

// ---------- saved history ----------

function persist(e) {
  if (!storeFile) return;
  fs.appendFile(storeFile, JSON.stringify(e) + '\n', () => {});
}

function loadHistory() {
  if (!storeFile) return;
  try {
    if (!fs.existsSync(storeFile)) return;
    const lines = fs.readFileSync(storeFile, 'utf8').split('\n').filter(Boolean);
    const kept = lines.slice(-MAX_EVENTS);
    events = [];
    for (const line of kept) { try { events.push(JSON.parse(line)); } catch (e) { /* skip a damaged line */ } }
    seq = events.reduce((m, e) => Math.max(m, e.id || 0), 0);
    if (lines.length > MAX_EVENTS) fs.writeFileSync(storeFile, kept.join('\n') + '\n');
  } catch (e) { events = []; }
}

// ---------- editor highlights ----------

function addHighlight(abs, ranges) {
  const cfg = vscode.workspace.getConfiguration('claudeGraph');
  if (!cfg.get('highlightEdits')) return;
  const ttl = Math.max(1, Number(cfg.get('highlightSeconds')) || 12) * 1000;
  const list = highlights.get(abs) || [];
  for (const r of ranges) list.push({ start: r.start, end: r.end, expires: Date.now() + ttl });
  highlights.set(abs, list);
  applyHighlights();
}

function applyHighlights() {
  const now = Date.now();
  let next = Infinity;
  for (const [file, list] of highlights) {
    const live = list.filter((h) => h.expires > now);
    if (live.length) highlights.set(file, live); else highlights.delete(file);
    for (const h of live) next = Math.min(next, h.expires);
  }
  for (const editor of vscode.window.visibleTextEditors) {
    const list = highlights.get(editor.document.uri.fsPath) || [];
    const last = Math.max(0, editor.document.lineCount - 1);
    editor.setDecorations(decoration, list.map((h) => new vscode.Range(
      Math.min(last, Math.max(0, h.start - 1)), 0, Math.min(last, Math.max(0, h.end - 1)), 0)));
  }
  clearTimeout(highlightTimer);
  if (next !== Infinity) highlightTimer = setTimeout(applyHighlights, Math.max(50, next - now + 20));
}

// ---------- panel ----------

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

function html(webview) {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>Claude Activity</title>
</head>
<body>
<header>
  <span id="status" class="status"></span>
  <span id="counts" class="counts"></span>
  <select id="sessionPick" title="Show one Claude Code session, or all of them" hidden></select>
  <button id="viewFlow" class="seg" title="One box per action, in order">Flowchart</button><button id="viewGraph" class="seg" title="Agents, files and code sections as a network">Graph</button><button id="viewPlan" class="seg" title="The proposed plan and task list as a flowchart">Plan</button><button id="align" class="seg gap" title="Line boxes up across agents in the order they happened. Leaves gaps, but shows what ran at the same time.">Align by time</button>
  <span class="spacer"></span>
  <button id="connect" class="primary" hidden>Connect this workspace</button>
  <button id="toggleAside" class="seg" title="Show or hide the activity list on the right">Activity</button>
  <button id="replay" title="Play the whole session again from the start">Replay</button>
  <button id="update" title="Install a newer version of this extension from a .vsix file">Update</button>
  <button id="fit" title="Fit the graph to the panel">Fit</button>
  <button id="clear" title="Remove everything from the graph">Clear</button>
</header>
<main>
  <div id="stage">
    <canvas id="graph"></canvas>
    <div id="plan" hidden></div>
    <div id="flow"><div id="flowInner"><svg id="flowLines"></svg><div id="flowGrid"></div></div></div>
    <div id="empty">
      <p class="big">Waiting for Claude Code</p>
      <p id="emptyHint"></p>
      <p><button id="demo">Play a demo</button> <button id="parallelDemo">Parallel agents demo</button></p>
    </div>
    <div id="tip" hidden></div>
    <div id="legend"></div>
  </div>
  <aside><section id="requests" hidden><h2>Requests</h2><div id="prompts"></div></section><div class="aside-head"><h2>Activity</h2><span class="spacer"></span><button id="modeAgent" class="seg" title="Group actions under the agent that did them">By agent</button><button id="modeTime" class="seg" title="All actions in time order">Timeline</button></div><div id="groups"></div><ol id="feed" hidden></ol></aside>
</main>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
}

function post(msg) {
  for (const w of views) w.postMessage(msg);
}

function options() {
  const cfg = vscode.workspace.getConfiguration('claudeGraph');
  return {
    autoPlan: cfg.get('autoShowPlan') !== false,
    group: cfg.get('groupRepeats') !== false,
    fold: cfg.get('foldEarlierTurns') !== false,
  };
}

function postState() {
  post({
    type: 'state',
    port,
    connected: installedPort() === port && port !== 0,
    hasFolder: !!workspaceRoot(),
    extVersion: context.extension.packageJSON.version,
    vscodeVersion: vscode.version,
    opts: options(),
  });
}

// wires one webview (docked view or editor tab) to the shared event stream
function attach(webview, onGone) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  };
  webview.html = html(webview);
  views.add(webview);
  webview.onDidReceiveMessage((m) => {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'ready') {
      webview.postMessage({ type: 'init', events });
      postState();
    } else if (m.type === 'open' && typeof m.file === 'string') {
      openFile(m.file, Number(m.line) || 0);
    } else if (m.type === 'connect') {
      vscode.commands.executeCommand('claudeGraph.installHooks');
    } else if (m.type === 'clear') {
      vscode.commands.executeCommand('claudeGraph.clear');
    } else if (m.type === 'demo' || m.type === 'parallelDemo') {
      vscode.commands.executeCommand(m.type === 'parallelDemo' ? 'claudeGraph.parallelDemo' : 'claudeGraph.demo');
    } else if (m.type === 'update') {
      vscode.commands.executeCommand('claudeGraph.update');
    }
  });
  onGone(() => views.delete(webview));
}

// the docked view: lives in the bottom panel by default and can be dragged to either side bar
const dockedProvider = {
  resolveWebviewView(view) {
    attach(view.webview, (cb) => view.onDidDispose(cb));
  },
};

function showDocked() {
  return vscode.commands.executeCommand('claudeGraph.view.focus');
}

// Opens the chart where the user wants it: an editor tab by default, like a Claude Code session.
function showDefault() {
  return vscode.workspace.getConfiguration('claudeGraph').get('openIn') === 'panel' ? showDocked() : showPanel();
}

function showPanel() {
  if (panel) {
    panel.reveal(undefined, true);
    return;
  }
  panel = vscode.window.createWebviewPanel('claudeGraph', 'Claude Activity', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
  attach(panel.webview, (cb) => panel.onDidDispose(() => { panel = null; cb(); }));
}

async function openFile(file, line) {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One, preserveFocus: false, selection: new vscode.Range(pos, pos),
    });
  } catch (e) {
    vscode.window.showWarningMessage(`Could not open ${file}`);
  }
}

function updateStatus() {
  if (!statusItem) return;
  const connected = port && installedPort() === port;
  statusItem.backgroundColor = waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  if (waiting) {
    statusItem.text = '$(bell) Claude is waiting for you';
    statusItem.tooltip = 'Claude Code needs your approval to continue. Click to open the chart.';
    return;
  }
  statusItem.text = connected ? '$(type-hierarchy) Claude Graph' : '$(type-hierarchy) Claude Graph (not connected)';
  statusItem.tooltip = connected
    ? `Listening for Claude Code on 127.0.0.1:${port}. ${events.length} events received.`
    : 'Click to open the graph, then connect this workspace.';
}

// ---------- update ----------

// The extension is installed from a local .vsix, so VS Code cannot update it by itself.
// This installs a newer .vsix over the current one and offers to reload.
async function updateExtension() {
  const current = context.extension.packageJSON.version;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Install update',
    title: `Choose the new .vsix (installed: v${current}, VS Code ${vscode.version})`,
    filters: { 'VS Code extension': ['vsix'] },
    defaultUri: context.globalState.get('lastVsixFolder') ? vscode.Uri.file(context.globalState.get('lastVsixFolder')) : undefined,
  });
  if (!picked || !picked.length) return;
  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', picked[0]);
    await context.globalState.update('lastVsixFolder', path.dirname(picked[0].fsPath));
  } catch (e) {
    vscode.window.showErrorMessage(`Update failed: ${e.message || e}`);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Update installed. Reload the window to start using it.', 'Reload Window');
  if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
}

// ---------- automatic updates from a folder ----------

// The extension is installed from a file, so there is no store to update it from. Instead it watches
// one folder (Downloads by default) for a newer claude-activity-graph-x.y.z.vsix and installs that.
const VSIX_NAME = /^claude-activity-graph-(\d+)\.(\d+)\.(\d+)(?: ?\(\d+\))?\.vsix$/;
let updateWatcher = null;
let updateTimer = null;
let updateBusy = false;
let installedNow = null;   // version installed in this window and waiting for a reload

function updateFolder() {
  const set = String(vscode.workspace.getConfiguration('claudeGraph').get('updateFolder') || '').trim();
  if (!set) return path.join(os.homedir(), 'Downloads');
  return set.startsWith('~') ? path.join(os.homedir(), set.slice(1)) : set;
}

function newer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function findUpdate() {
  const running = String(context.extension.packageJSON.version).split('.').map(Number);
  const current = installedNow && newer(installedNow, running) ? installedNow : running;
  let best = null;
  let names = [];
  try { names = fs.readdirSync(updateFolder()); } catch (e) { return null; }
  for (const name of names) {
    const m = name.match(VSIX_NAME);
    if (!m) continue;
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    const file = path.join(updateFolder(), name);
    try { if (fs.statSync(file).size < 1000) continue; } catch (e) { continue; }
    if (newer(v, current) && (!best || newer(v, best.v))) best = { v, file, version: v.join('.') };
  }
  return best;
}

async function checkForUpdate() {
  const mode = vscode.workspace.getConfiguration('claudeGraph').get('autoUpdate') || 'ask';
  if (mode === 'off' || updateBusy) return;
  const found = findUpdate();
  if (!found) return;
  updateBusy = true;
  try {
    if (mode !== 'install') {
      if (context.globalState.get('skippedUpdate') === found.version) return;
      const choice = await vscode.window.showInformationMessage(
        `Claude Graph ${found.version} is in ${updateFolder()}. Install it?`, 'Install', 'Always install', 'Skip this version');
      if (choice === 'Skip this version') { await context.globalState.update('skippedUpdate', found.version); return; }
      if (choice === 'Always install') {
        await vscode.workspace.getConfiguration('claudeGraph').update('autoUpdate', 'install', vscode.ConfigurationTarget.Global);
      } else if (choice !== 'Install') return;
    }
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(found.file));
    installedNow = found.v;
    const reload = await vscode.window.showInformationMessage(
      `Claude Graph updated to ${found.version}. Reload the window to start using it.`, 'Reload Window');
    if (reload === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Graph could not install the update: ${e.message || e}`);
  } finally {
    updateBusy = false;
  }
}

function scheduleUpdateCheck(delay) {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(checkForUpdate, delay);
}

function watchForUpdates() {
  if (updateWatcher) { try { updateWatcher.close(); } catch (e) { /* already closed */ } updateWatcher = null; }
  if ((vscode.workspace.getConfiguration('claudeGraph').get('autoUpdate') || 'ask') === 'off') return;
  try {
    // wait a few seconds after a change so a download has finished writing
    updateWatcher = fs.watch(updateFolder(), (kind, name) => { if (!name || VSIX_NAME.test(String(name))) scheduleUpdateCheck(4000); });
    updateWatcher.on('error', () => {});
  } catch (e) { /* folder missing or not watchable: the focus check below still covers it */ }
  scheduleUpdateCheck(5000);
}

// ---------- demo ----------

const DEMO_PLAN = `# Add rate limiting to the API

## Understand
1. Map the middleware chain in src/server.ts
   - note where auth and logging are registered
2. Check how existing tests start the server

## Build
3. Write a rateLimit middleware with a configurable limit
4. Register it in createApp, before auth
5. Add the limit to the config defaults

## Verify
6. Write tests for requests under and over the limit
7. Run the tests and lint
`;

function demoEvents() {
  const s = 'demo-session';
  const root = workspaceRoot() || '/project';
  const f = (p) => path.join(root, p);
  const pre = (tool, tool_input, extra) => ({ hook_event_name: 'PreToolUse', session_id: s, tool_name: tool, tool_input, ...extra });
  const post = (tool, tool_input, extra) => ({ hook_event_name: 'PostToolUse', session_id: s, tool_name: tool, tool_input, ...extra });
  const a1 = { agent_id: 'demo-a1', agent_type: 'Explore' };
  const a2 = { agent_id: 'demo-a2', agent_type: 'general-purpose' };
  return [
    { hook_event_name: 'SessionStart', session_id: s },
    { hook_event_name: 'UserPromptSubmit', session_id: s, prompt: 'Add rate limiting to the API and update the tests' },
    pre('ExitPlanMode', { plan: DEMO_PLAN }),
    { hook_event_name: 'PermissionRequest', session_id: s, tool_name: 'ExitPlanMode', tool_input: { plan: DEMO_PLAN }, _pause: 3200 },
    post('ExitPlanMode', { plan: DEMO_PLAN }),
    ...['Map the existing middleware', 'Write the rate limit middleware', 'Wire it into the server', 'Test and lint'].flatMap((subject, i) => [
      pre('TaskCreate', { subject }), { ...post('TaskCreate', { subject }), tool_response: { task: { id: String(i + 1) } } },
    ]),
    pre('TaskUpdate', { taskId: '1', status: 'in_progress' }), post('TaskUpdate', { taskId: '1', status: 'in_progress' }),
    pre('Grep', { pattern: 'rateLimit' }),
    post('Grep', { pattern: 'rateLimit' }),
    pre('Read', { file_path: f('src/server.ts') }),
    post('Read', { file_path: f('src/server.ts') }),
    pre('Agent', { description: 'Map the middleware chain', subagent_type: 'Explore' }),
    { hook_event_name: 'SubagentStart', session_id: s, ...a1 },
    pre('Agent', { description: 'Write limiter tests', subagent_type: 'general-purpose' }),
    { hook_event_name: 'SubagentStart', session_id: s, ...a2 },
    pre('Glob', { pattern: 'src/middleware/**' }, a1),
    post('Glob', { pattern: 'src/middleware/**' }, a1),
    pre('Read', { file_path: f('src/middleware/auth.ts') }, a1),
    post('Read', { file_path: f('src/middleware/auth.ts') }, a1),
    pre('Read', { file_path: f('tests/server.test.ts') }, a2),
    post('Read', { file_path: f('tests/server.test.ts') }, a2),
    pre('Read', { file_path: f('src/middleware/logger.ts') }, a1),
    post('Read', { file_path: f('src/middleware/logger.ts') }, a1),
    pre('Read', { file_path: f('src/server.ts') }, a1),
    post('Read', { file_path: f('src/server.ts') }, a1),
    pre('TaskUpdate', { taskId: '1', status: 'completed' }), post('TaskUpdate', { taskId: '1', status: 'completed' }),
    pre('TaskUpdate', { taskId: '2', status: 'in_progress' }), post('TaskUpdate', { taskId: '2', status: 'in_progress' }),
    pre('Write', { file_path: f('src/middleware/rateLimit.ts') }),
    post('Write', { file_path: f('src/middleware/rateLimit.ts') }),
    pre('Write', { file_path: f('tests/rateLimit.test.ts') }, a2),
    post('Write', { file_path: f('tests/rateLimit.test.ts') }, a2),
    { hook_event_name: 'SubagentStop', session_id: s, ...a1 },
    post('Agent', { description: 'Map the middleware chain', subagent_type: 'Explore' }),
    pre('TaskUpdate', { taskId: '2', status: 'completed' }), post('TaskUpdate', { taskId: '2', status: 'completed' }),
    pre('TaskUpdate', { taskId: '3', status: 'in_progress' }), post('TaskUpdate', { taskId: '3', status: 'in_progress' }),
    pre('Edit', { file_path: f('src/server.ts'), old_string: '  app.use(logger);\n  app.use(auth);', new_string: '  app.use(logger);\n  app.use(rateLimit(config.rateLimit));\n  app.use(auth);' }, { _ranges: [{ start: 41, end: 48, symbol: 'createApp' }] }),
    post('Edit', { file_path: f('src/server.ts') }, { _ranges: [{ start: 41, end: 50, symbol: 'createApp' }] }),
    pre('Bash', { command: 'npm test -- rateLimit' }, a2),
    { hook_event_name: 'PostToolUseFailure', session_id: s, tool_name: 'Bash', tool_input: { command: 'npm test -- rateLimit' }, error: '1 test failed', ...a2 },
    pre('Edit', { file_path: f('tests/rateLimit.test.ts') }, { ...a2, _ranges: [{ start: 18, end: 27, symbol: 'blocks after limit' }] }),
    post('Edit', { file_path: f('tests/rateLimit.test.ts') }, { ...a2, _ranges: [{ start: 18, end: 29, symbol: 'blocks after limit' }] }),
    pre('Edit', { file_path: f('src/server.ts') }, { _ranges: [{ start: 88, end: 93, symbol: 'registerRoutes' }] }),
    post('Edit', { file_path: f('src/server.ts') }, { _ranges: [{ start: 88, end: 96, symbol: 'registerRoutes' }] }),
    pre('Bash', { command: 'npm test -- rateLimit' }, a2),
    post('Bash', { command: 'npm test -- rateLimit' }, a2),
    { hook_event_name: 'SubagentStop', session_id: s, ...a2 },
    post('Agent', { description: 'Write limiter tests', subagent_type: 'general-purpose' }),
    pre('Edit', { file_path: f('src/config.ts') }, { _ranges: [{ start: 12, end: 15, symbol: 'defaults' }] }),
    post('Edit', { file_path: f('src/config.ts') }, { _ranges: [{ start: 12, end: 17, symbol: 'defaults' }] }),
    pre('TaskUpdate', { taskId: '3', status: 'completed' }), post('TaskUpdate', { taskId: '3', status: 'completed' }),
    pre('TaskUpdate', { taskId: '4', status: 'in_progress' }), post('TaskUpdate', { taskId: '4', status: 'in_progress' }),
    pre('Bash', { command: 'npm run lint' }),
    { hook_event_name: 'PermissionRequest', session_id: s, tool_name: 'Bash', tool_input: { command: 'npm run lint' }, _pause: 2600 },
    post('Bash', { command: 'npm run lint' }),
    pre('TaskUpdate', { taskId: '4', status: 'completed' }), post('TaskUpdate', { taskId: '4', status: 'completed' }),
    { hook_event_name: 'Stop', session_id: s, last_assistant_message: 'Rate limiting is in place: a new middleware, wired into createApp, with a configurable limit. The limiter tests pass and lint is clean.' },
    { hook_event_name: 'UserPromptSubmit', session_id: s, prompt: 'Document the new limiter in the README' },
    pre('Read', { file_path: f('README.md') }),
    post('Read', { file_path: f('README.md') }),
    pre('Read', { file_path: f('src/middleware/rateLimit.ts') }),
    post('Read', { file_path: f('src/middleware/rateLimit.ts') }),
    pre('Read', { file_path: f('src/config.ts') }),
    post('Read', { file_path: f('src/config.ts') }),
    pre('Edit', { file_path: f('README.md') }, { _ranges: [{ start: 34, end: 34, symbol: 'Configuration' }] }),
    post('Edit', { file_path: f('README.md') }, { _ranges: [{ start: 34, end: 47, symbol: 'Configuration' }] }),
    { hook_event_name: 'Stop', session_id: s, last_assistant_message: 'Added a Configuration section to the README covering the rate limit setting.' },
  ];
}

function parallelDemoEvents() {
  const s = 'parallel-demo-session';
  const root = workspaceRoot() || '/project';
  const f = (p) => path.join(root, p);
  const pre = (tool, tool_input, extra) => ({ hook_event_name: 'PreToolUse', session_id: s, tool_name: tool, tool_input, ...extra });
  const post = (tool, tool_input, extra) => ({ hook_event_name: 'PostToolUse', session_id: s, tool_name: tool, tool_input, ...extra });
  const explore = { agent_id: 'parallel-explore', agent_type: 'Explore' };
  const tests = { agent_id: 'parallel-tests', agent_type: 'TestWriter' };
  const review = { agent_id: 'parallel-review', agent_type: 'Reviewer' };
  return [
    { hook_event_name: 'SessionStart', session_id: s },
    { hook_event_name: 'UserPromptSubmit', session_id: s, prompt: 'Use three agents in parallel to review the API, prepare tests, and check edge cases. After they all finish, integrate the work and run the full test suite.' },
    pre('Agent', { description: 'Explore the API and report integration points', subagent_type: 'Explore' }),
    { hook_event_name: 'SubagentStart', session_id: s, ...explore },
    pre('Agent', { description: 'Prepare focused API tests', subagent_type: 'TestWriter' }),
    { hook_event_name: 'SubagentStart', session_id: s, ...tests },
    pre('Agent', { description: 'Review configuration and edge cases', subagent_type: 'Reviewer' }),
    { hook_event_name: 'SubagentStart', session_id: s, ...review },
    pre('Glob', { pattern: 'src/**' }, explore),
    post('Glob', { pattern: 'src/**' }, explore),
    pre('Read', { file_path: f('src/server.ts') }, explore),
    post('Read', { file_path: f('src/server.ts') }, explore),
    pre('Read', { file_path: f('tests/server.test.ts') }, tests),
    post('Read', { file_path: f('tests/server.test.ts') }, tests),
    pre('Read', { file_path: f('src/config.ts') }, review),
    post('Read', { file_path: f('src/config.ts') }, review),
    pre('Read', { file_path: f('src/middleware/auth.ts') }, explore),
    post('Read', { file_path: f('src/middleware/auth.ts') }, explore),
    pre('Write', { file_path: f('tests/api.test.ts') }, tests),
    post('Write', { file_path: f('tests/api.test.ts') }, tests),
    pre('Read', { file_path: f('README.md') }, review),
    post('Read', { file_path: f('README.md') }, review),
    pre('Read', { file_path: f('src/middleware/logger.ts') }, explore),
    post('Read', { file_path: f('src/middleware/logger.ts') }, explore),
    pre('Edit', { file_path: f('tests/api.test.ts') }, { ...tests, _ranges: [{ start: 12, end: 22, symbol: 'API edge cases' }] }),
    post('Edit', { file_path: f('tests/api.test.ts') }, { ...tests, _ranges: [{ start: 12, end: 26, symbol: 'API edge cases' }] }),
    pre('Read', { file_path: f('src/config.ts') }, review),
    post('Read', { file_path: f('src/config.ts') }, review),
    { hook_event_name: 'SubagentStop', session_id: s, ...tests, last_assistant_message: 'Added focused API tests, including edge cases.' },
    { hook_event_name: 'SubagentStop', session_id: s, ...explore, last_assistant_message: 'Mapped the API flow and identified the integration points.' },
    { hook_event_name: 'SubagentStop', session_id: s, ...review, last_assistant_message: 'Reviewed configuration and reported the relevant edge cases.' },
    pre('Edit', { file_path: f('src/server.ts') }, { _ranges: [{ start: 41, end: 48, symbol: 'createApp' }] }),
    post('Edit', { file_path: f('src/server.ts') }, { _ranges: [{ start: 41, end: 50, symbol: 'createApp' }] }),
    pre('Bash', { command: 'npm test' }),
    post('Bash', { command: 'npm test' }),
    { hook_event_name: 'Stop', session_id: s, last_assistant_message: 'All three agents finished before I integrated their work. The full npm test suite passed.' },
  ];
}

function playDemo() {
  demoTimers.forEach(clearTimeout);
  demoTimers = [];
  if (!views.size) showDefault();
  let at = 500;
  for (const raw of demoEvents()) {
    demoTimers.push(setTimeout(() => enqueue({ ...raw, _demo: true }), at));
    at += 450 + (raw._pause || 0);
  }
}

function playParallelDemo() {
  demoTimers.forEach(clearTimeout);
  demoTimers = [];
  if (!views.size) showDefault();
  let at = 500;
  for (const raw of parallelDemoEvents()) {
    demoTimers.push(setTimeout(() => enqueue({ ...raw, _demo: true }), at));
    at += 450 + (raw._pause || 0);
  }
}

// ---------- activation ----------

async function activate(ctx) {
  context = ctx;
  decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.wordHighlightStrongForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusItem.command = 'claudeGraph.show';
  statusItem.show();

  ctx.subscriptions.push(
    decoration,
    statusItem,
    vscode.window.onDidChangeVisibleTextEditors(applyHighlights),
    vscode.window.registerWebviewViewProvider('claudeGraph.view', dockedProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('claudeGraph')) postState();
      if (ev.affectsConfiguration('claudeGraph.updateFolder') || ev.affectsConfiguration('claudeGraph.autoUpdate')) watchForUpdates();
    }),
    vscode.commands.registerCommand('claudeGraph.checkUpdate', async () => {
      await context.globalState.update('skippedUpdate', undefined);
      if (!findUpdate()) vscode.window.showInformationMessage(`No newer Claude Graph file in ${updateFolder()}. Installed: ${context.extension.packageJSON.version}.`);
      else checkForUpdate();
    }),
    vscode.commands.registerCommand('claudeGraph.show', showDefault),
    vscode.commands.registerCommand('claudeGraph.showDocked', showDocked),
    vscode.commands.registerCommand('claudeGraph.showTab', showPanel),
    vscode.commands.registerCommand('claudeGraph.demo', playDemo),
    vscode.commands.registerCommand('claudeGraph.parallelDemo', playParallelDemo),
    vscode.commands.registerCommand('claudeGraph.update', updateExtension),
    vscode.commands.registerCommand('claudeGraph.clear', () => {
      events = [];
      waiting = false;
      if (storeFile) fs.rm(storeFile, { force: true }, () => {});
      demoTimers.forEach(clearTimeout);
      post({ type: 'init', events });
      updateStatus();
    }),
    vscode.commands.registerCommand('claudeGraph.installHooks', () => {
      try {
        writeHooks(true);
        vscode.window.showInformationMessage(
          'Connected. Claude Code sessions in this folder now report to the graph. If a session is already running and nothing appears, restart it.');
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
      postState();
      updateStatus();
    }),
    vscode.commands.registerCommand('claudeGraph.removeHooks', () => {
      try {
        writeHooks(false);
        vscode.window.showInformationMessage('Disconnected. The graph hooks were removed from .claude/settings.local.json.');
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
      postState();
      updateStatus();
    }),
    { dispose: () => { if (server) server.close(); clearTimeout(highlightTimer); clearTimeout(updateTimer); if (updateWatcher) updateWatcher.close(); demoTimers.forEach(clearTimeout); } },
  );

  if (ctx.storageUri) {
    try {
      fs.mkdirSync(ctx.storageUri.fsPath, { recursive: true });
      storeFile = path.join(ctx.storageUri.fsPath, 'events.jsonl');
      loadHistory();
    } catch (e) { storeFile = null; }
  }

  try {
    const wanted = installedPort();
    await startServer();
    // Rewrite the hooks when the saved port was taken (for example by a second window on this folder)
    // or when they were installed by an older version that listened to fewer events.
    if (wanted && (wanted !== port || !hooksComplete())) {
      try { writeHooks(true); } catch (e) { /* reported when the user connects manually */ }
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Graph could not start: ${e.message}`);
  }
  updateStatus();

  // coming back to the window (for example after downloading a new file) is a good moment to look
  if (vscode.window.onDidChangeWindowState) {
    ctx.subscriptions.push(vscode.window.onDidChangeWindowState((w) => { if (w.focused) scheduleUpdateCheck(1500); }));
  }
  watchForUpdates();
}

function deactivate() {
  if (server) server.close();
}

module.exports = { activate, deactivate, _test: { findUpdate, checkForUpdate, locate, heuristicSymbol, classify, stripOurHooks, isOurHook } };
