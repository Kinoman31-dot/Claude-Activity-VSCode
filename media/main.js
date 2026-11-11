// Webview side of the activity graph: turns hook events into a live node graph.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const canvas = $('graph');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const feed = $('feed');
  const groupsEl = $('groups');
  const requestsEl = $('requests');
  const promptsEl = $('prompts');
  let groups = new Map();     // actor node id -> grouped activity section
  const tip = $('tip');

  $('legend').innerHTML =
    '<span><i class="k-main"></i>Claude</span><span><i class="k-agent"></i>Sub-agent</span>' +
    '<span><i class="k-file"></i>Edited file</span><span><i class="k-read"></i>Read file</span>' +
    '<span><i class="k-section"></i>Code section</span>';

  // ---------- state ----------
  let nodes = new Map();
  let links = new Map();
  let pending = [];           // sub-agents requested but not yet started
  let feedById = new Map();   // toolUseId / key -> feed row
  let theme = {};
  let view = { x: 0, y: 0, k: 1 };
  let autoFit = true;
  let alpha = 0;              // layout energy
  let running = false;
  let width = 0, height = 0;
  let hover = null;
  let drag = null;
  let state = { port: 0, connected: false, hasFolder: true };
  let opts = { autoPlan: true, group: true, fold: true };   // user settings, sent by the extension
  let onlySession = '';     // the session being shown; empty means all of them
  let sessions = new Map(); // session id -> label for the picker

  const TOOL_LABEL = { run: 'Shell', search: 'Search', web: 'Web', mcp: 'Connector', other: 'Other', spawn: 'Agents', plan: 'Plan', tasks: 'Tasks' };
  const VERB = { read: 'read', edit: 'editing', write: 'writing', run: 'ran', search: 'searched', web: 'web', spawn: 'started agent', mcp: 'used', other: 'used', plan: 'proposed a plan:', tasks: 'task list,' };
  const REST = { spawn: 175, read: 125, edit: 120, section: 48 };

  function readTheme() {
    const cs = getComputedStyle(document.body);
    const v = (n, f) => cs.getPropertyValue(n).trim() || f;
    theme = {
      fg: v('--vscode-foreground', '#cccccc'),
      muted: v('--vscode-descriptionForeground', '#8b8b8b'),
      bg: v('--vscode-editor-background', '#1e1e1e'),
      main: v('--vscode-charts-purple', '#b180d7'),
      agent: v('--vscode-charts-blue', '#3794ff'),
      file: v('--vscode-charts-green', '#89d185'),
      section: v('--vscode-charts-yellow', '#cca700'),
      tool: v('--vscode-charts-orange', '#d18616'),
      err: v('--vscode-charts-red', '#f14c4c'),
      font: v('--vscode-font-family', 'sans-serif'),
    };
  }

  function reset() {
    nodes = new Map(); links = new Map(); pending = []; feedById = new Map();
    feed.textContent = ''; groupsEl.textContent = ''; promptsEl.textContent = ''; requestsEl.hidden = true; groups = new Map();
    flowReset();
    planReset();
    view = { x: 0, y: 0, k: 1 }; autoFit = true; hover = null;
  }

  // ---------- graph building ----------
  function node(id, kind, label, near) {
    let n = nodes.get(id);
    if (n) return n;
    const a = Math.random() * Math.PI * 2;
    const d = near ? 40 + Math.random() * 30 : 0;
    n = {
      id, kind, label,
      x: (near ? near.x : 0) + Math.cos(a) * d, y: (near ? near.y : 0) + Math.sin(a) * d,
      vx: 0, vy: 0, heat: 0, fail: 0, count: 0, active: 0, status: '', info: '', doing: '', doingHeat: 0,
    };
    nodes.set(id, n);
    alpha = 1;
    return n;
  }

  function link(a, b, kind, live) {
    const id = a.id + '>' + b.id;
    let l = links.get(id);
    if (!l) { l = { a, b, kind, heat: 0 }; links.set(id, l); alpha = Math.max(alpha, 0.6); }
    if (kind === 'edit') l.kind = 'edit'; // an edit link outranks a read link
    if (live) l.heat = 1;
    return l;
  }

  function sessionNode(e) {
    const n = node('s:' + e.session, 'main', 'Claude', null);
    return n;
  }

  function agentNode(e, session) {
    const id = 'a:' + e.session + ':' + e.agentId;
    let n = nodes.get(id);
    if (n) return n;
    // Match the start to the request that asked for it, so the agent hangs off whoever spawned it.
    let i = pending.findIndex((p) => p.session === e.session && p.type && p.type === e.agentType);
    if (i < 0) i = pending.findIndex((p) => p.session === e.session);
    const req = i >= 0 ? pending.splice(i, 1)[0] : null;
    const parent = (req && nodes.get(req.caller)) || session;
    n = node(id, 'agent', e.agentType || 'agent', parent);
    n.info = req ? req.desc : '';
    n.spawnKey = req ? req.key : null;
    n.status = 'running';
    link(parent, n, 'spawn', true);
    return n;
  }

  function basename(p) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }

  function apply(e, live) {
    const session = sessionNode(e);
    const actor = e.agentId ? agentNode(e, session) : session;
    const hot = live ? 1 : 0;
    const who = actor.kind === 'main' ? 'Claude' : actor.label;

    switch (e.ev) {
      case 'SessionStart':
        session.status = 'idle';
        break;
      case 'UserPromptSubmit':
        session.status = 'running'; session.heat = hot;
        addFeed(e, session, 'You', 'sent a prompt', '', null, 'note');
        break;
      case 'SubagentStart':
        actor.status = 'running'; actor.heat = hot;
        addFeed(e, actor, who, 'started', actor.info || '', null);
        break;
      case 'SubagentStop':
        actor.status = 'done'; actor.active = 0;
        addFeed(e, actor, who, 'finished', '', null, 'note');
        break;
      case 'Stop':
        session.status = 'idle'; session.active = 0;
        addFeed(e, session, 'Claude', 'finished the turn', '', null, 'note');
        break;
      case 'SessionEnd':
        session.status = 'done';
        break;
      case 'UsageGuard':
        addFeed(e, session, 'Usage guard', e.guardLabel || 'status', e.detail || '', null, 'guard', 'Guard');
        break;
      case 'PermissionRequest':
        addFeed(e, actor, who, 'needs your approval:', (KIND[e.action] || e.tool || '') + ' ' + (e.file || e.detail || ''), null, 'wait');
        break;
      case 'PreToolUse': {
        if (actor.kind === 'main') session.status = 'running';
        actor.heat = hot; actor.count++; actor.fail = 0;
        if (e.action === 'spawn') {
          pending.push({ session: e.session, caller: actor.id, type: e.subagentType, desc: e.detail || '', key: feedKey(e) });
          addFeed(e, actor, who, 'started agent', (e.subagentType ? e.subagentType + ': ' : '') + (e.detail || ''), null, '', 'Agents');
          break; // the agent node itself appears on SubagentStart
        }
        if (e.file) {
          const f = fileNode(e, actor);
          f.heat = hot; f.active++; f.count++;
          link(actor, f, e.action === 'read' ? 'read' : 'edit', live);
          if (e.action !== 'read') f.edited = true;
          sections(e, f, live, false);
          actor.doing = VERB[e.action] + ' ' + f.label; actor.doingHeat = hot;
          addFeed(e, actor, who, VERB[e.action], e.file, { file: e.abs, line: firstLine(e) }, '', e.action === 'read' ? 'Read' : 'Edit');
        } else {
          const name = TOOL_LABEL[e.action] || e.tool;
          actor.tools = actor.tools || {};
          actor.tools[name] = (actor.tools[name] || 0) + 1;
          actor.doing = name + (e.detail && e.action !== 'mcp' && e.action !== 'other' ? ': ' + e.detail : '');
          actor.doingHeat = hot;
          // task-list bookkeeping is counted, not listed: the Plan view shows it properly
          if (e.action === 'tasks') noteCat(actor, name);
          else addFeed(e, actor, who, VERB[e.action] || 'used', e.detail || e.tool || '', null, '', name);
        }
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const failed = e.ev === 'PostToolUseFailure';
        if (e.file) {
          const f = fileNode(e, actor);
          f.active = Math.max(0, f.active - 1);
          if (failed) f.fail = hot; else sections(e, f, live, true);
        } else if (failed) {
          actor.fail = hot;
        }
        if (failed) markFailed(e);
        break;
      }
    }
    flowApply(e, actor, session, live);
    planApply(e, live);
    alpha = Math.max(alpha, 0.25);
  }

  function fileNode(e, actor) {
    const f = node('f:' + e.abs, 'file', basename(e.file), actor);
    f.path = e.file; f.abs = e.abs;
    return f;
  }

  function firstLine(e) { return e.ranges && e.ranges.length ? e.ranges[0].start : 0; }

  // A "section" is the function, class or heading an edit landed in (or a line range when unnamed).
  function sections(e, f, live, done) {
    if (e.action !== 'edit' || !e.ranges) return;
    for (const r of e.ranges) {
      if (!r.symbol && !done) continue; // unnamed ranges shift after the edit, so wait for the final lines
      const key = r.symbol || ('L' + r.start + '–' + r.end);
      const s = node('x:' + e.abs + ':' + key, 'section', r.symbol || ('lines ' + r.start + '–' + r.end), f);
      s.abs = e.abs; s.line = r.start; s.path = e.file;
      s.info = 'lines ' + r.start + '–' + r.end;
      s.heat = live ? 1 : 0;
      if (done) s.count++;
      link(f, s, 'section', live);
    }
  }


  // ---------- flowchart: boxes in order, one column per agent, one section per turn ----------
  const flowEl = $('flow');
  const flowGrid = $('flowGrid');
  const SVGNS = 'http://www.w3.org/2000/svg';
  const KIND = { read: 'Read', edit: 'Edit', write: 'Write', run: 'Shell', search: 'Search', web: 'Web', spawn: 'Start agent', mcp: 'Connector', plan: 'Propose plan', tasks: 'Task list', guard: 'Usage guard' };
  const SNAKE = '<svg class="snake" aria-hidden="true"><rect class="trail" pathLength="100"/><rect class="body" pathLength="100"/><rect class="tip" pathLength="100"/></svg>';
  let turns = [];                 // one section per request, oldest first
  let turnBySession = new Map();  // session id -> its latest turn
  let lanes = new Map();          // actor node id -> column
  let actions = new Map();        // action key -> { b: box, item }
  let timed = new Set();          // boxes with an action still running
  let linesQueued = false;
  let lastUserScroll = 0;
  let replayClock = 0;            // during a replay, "now" is the time of the event being shown

  function clock() { return replayClock || Date.now(); }

  function flowReset() {
    turns = []; turnBySession = new Map(); lanes = new Map(); actions = new Map(); timed = new Set();
    flowGrid.textContent = '';
  }

  // A turn is everything done for one request. Starting a new one folds the previous one away.
  function newTurn(sessionId, prompt) {
    const prev = turnBySession.get(sessionId);
    if (prev && opts.fold) { prev.el.classList.add('folded'); prev.head.setAttribute('aria-expanded', 'false'); }
    const el = document.createElement('section'); el.className = 'turn';
    const head = document.createElement('button'); head.className = 'turnHead'; head.setAttribute('aria-expanded', 'true');
    head.type = 'button';
    const chev = document.createElement('span'); chev.className = 'chev';
    const q = document.createElement('span'); q.className = 'q'; q.textContent = prompt || 'Session in progress';
    const meta = document.createElement('span'); meta.className = 'meta';
    head.append(chev, q, meta);
    head.title = prompt || '';
    head.setAttribute('aria-label', (prompt || 'Session in progress') + ', toggle flowchart turn');
    const body = document.createElement('div'); body.className = 'turnBody';
    const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('class', 'lines');
    const grid = document.createElement('div'); grid.className = 'grid';
    body.append(svg, grid);
    el.append(body);
    flowGrid.append(el);
    promptsEl.prepend(head);
    requestsEl.hidden = false;
    const T = { el, head, meta, svg, grid, lanes: [], seq: 0, actions: 0, agents: 0, dirty: true, t0: 0, t1: 0 };
    head.addEventListener('click', () => {
      const folded = el.classList.toggle('folded');
      head.setAttribute('aria-expanded', String(!folded));
      lastUserScroll = Date.now();
      T.dirty = true;
      queueLines();
    });
    promptsEl.scrollTop = 0;
    turns.push(T);
    turnBySession.set(sessionId, T);
    return T;
  }

  function turnMeta(T) {
    const took = T.t0 && T.t1 > T.t0 ? fmtDur(T.t1 - T.t0) : '';
    T.meta.textContent = T.actions + (T.actions === 1 ? ' action' : ' actions') +
      (T.agents ? ', ' + T.agents + (T.agents === 1 ? ' sub-agent' : ' sub-agents') : '') + (took ? ', ' + took : '');
  }

  function fmtDur(ms) {
    if (!(ms >= 100) || ms > 6 * 3600e3) return '';
    if (ms < 10000) return (ms / 1000).toFixed(1) + 's';
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    const sec = Math.round(ms / 1000);
    return Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's';
  }

  function flowLane(actor, sessionId) {
    const T = turnBySession.get(sessionId) || newTurn(sessionId, null);
    let L = lanes.get(actor.id);
    if (!L) { L = { cur: null, waitBox: null }; lanes.set(actor.id, L); }
    if (L.turn === T) return L;
    // first box for this agent in this turn: give it a column and a header
    setCurrent(L, null);
    clearWait(L);
    const started = actor.spawnKey ? actions.get(actor.spawnKey) : null;
    L.turn = T;
    L.actor = actor;
    L.from = started && started.b.turn === T ? started.b : null;
    L.boxes = [];
    T.lanes.push(L);
    const head = flowBox(L, 'head link ' + actor.kind, actor.kind === 'main' ? 'Claude' : actor.label, actor.info || (actor.kind === 'main' ? 'main agent' : 'sub-agent'));
    head.el.title = 'Click to show this agent in the graph';
    head.el.addEventListener('click', () => showInGraph(actor.id));
    if (actor.kind !== 'main') { T.agents++; turnMeta(T); }
    if (actor.status === 'running') setCurrent(L, head);
    return L;
  }

  function flowBox(L, cls, kind, text) {
    const T = L.turn;
    const el = document.createElement('div');
    el.className = 'box ' + cls;
    const top = document.createElement('span'); top.className = 'top';
    const k = document.createElement('span'); k.className = 'kind'; k.textContent = kind;
    const n = document.createElement('span'); n.className = 'n'; n.hidden = true;
    const dur = document.createElement('span'); dur.className = 'dur';
    top.append(k, n, dur);
    const t = document.createElement('span'); t.className = 'text'; t.textContent = text || '';
    const sub = document.createElement('span'); sub.className = 'sub'; sub.hidden = true;
    const list = document.createElement('ol'); list.className = 'items'; list.hidden = true;
    el.append(top, t, sub, list);
    el.title = kind + (text ? '\n' + text : '');
    T.grid.append(el);
    const b = { el, kind, n, dur, t, sub, list, row: 0, seq: ++T.seq, turn: T, lane: L, items: [], expanded: false, gk: null, wait: false };
    L.boxes.push(b);
    T.dirty = true;
    queueLines();
    return b;
  }

  // Compact: each column packs its own boxes. Aligned: every box takes the row of its position in
  // time, so boxes side by side really did happen in that order.
  function layout(T) {
    T.dirty = false;
    const agents = T.lanes.filter((L) => L.actor.kind !== 'main');
    const rightCount = Math.ceil(agents.length / 2);
    const mainCol = rightCount + 1;
    const columnCount = rightCount * 2 + 1;
    T.grid.style.gridTemplateColumns = 'repeat(' + columnCount + ', 230px)';
    T.grid.style.width = Math.max(flowEl.clientWidth - 44, columnCount * 230 + (columnCount - 1) * 44) + 'px';
    T.grid.style.justifyContent = 'center';
    for (const L of T.lanes) {
      let r = L.from ? L.from.row : 1;
      if (L.actor.kind === 'main') L.col = mainCol;
      else {
        const i = agents.indexOf(L);
        L.col = i < rightCount ? mainCol + i + 1 : mainCol - (i - rightCount) - 1;
      }
      for (const b of L.boxes) {
        const row = ui.align ? b.seq : r++;
        if (b.row !== row) { b.row = row; b.el.style.gridRow = String(row); }
        b.el.style.gridColumn = String(L.col);
      }
    }
  }

  // Marks the box an agent is on right now; the light runs round it until the agent moves on or stops.
  function setCurrent(L, b) {
    if (L.cur && L.cur !== b) {
      L.cur.el.classList.remove('current');
      const old = L.cur.el.querySelector('.snake');
      if (old) old.remove();
    }
    L.cur = b || null;
    if (b && !b.el.classList.contains('current')) {
      b.el.classList.add('current');
      b.el.insertAdjacentHTML('beforeend', SNAKE);
    }
    queueLines();
  }

  // Claude Code has stopped to ask permission: the box it is on turns into a "waiting for you" box.
  function setWait(L) {
    const b = L.cur || (L.boxes && L.boxes[L.boxes.length - 1]);
    if (!b || L.waitBox === b) return false;
    clearWait(L);
    L.waitBox = b; b.wait = true;
    b.el.classList.add('waiting');
    if (b.items.length) render(b); else { b.sub.textContent = 'Waiting for your approval'; b.sub.hidden = false; }
    return true;
  }

  function clearWait(L) {
    const b = L.waitBox;
    if (!b) return;
    L.waitBox = null; b.wait = false;
    b.el.classList.remove('waiting');
    if (b.items.length) render(b); else { b.sub.textContent = ''; b.sub.hidden = true; }
  }

  function rangeText(r) {
    return (r.symbol ? r.symbol + ', ' : '') + (r.start === r.end ? 'line ' + r.start : 'lines ' + r.start + '–' + r.end);
  }

  function openItem(item, ev) {
    if (item.planLink) { ui.view = 'plan'; applyUi(); return; }
    if (!item.file) return;
    if (ev && ev.shiftKey) showInGraph('f:' + item.file);
    else vscode.postMessage({ type: 'open', file: item.file, line: item.line || 0 });
  }

  // An action joins the previous box when it is the same kind of action by the same agent,
  // so six reads in a row become one "Read ×6" box that opens into the full list.
  function addAction(L, e) {
    const gk = e.action === 'spawn' ? null : e.action + (KIND[e.action] ? '' : ':' + e.tool);
    let b = L.boxes[L.boxes.length - 1];
    if (!(b && gk && opts.group && b.gk === gk)) {
      b = flowBox(L, 'act k-' + e.action, KIND[e.action] || e.tool || 'Tool', '');
      b.gk = gk;
      const box = b;
      b.el.addEventListener('click', (ev) => {
        if (box.items.length > 1) { box.expanded = !box.expanded; lastUserScroll = Date.now(); hideTip(); render(box); }
        else openItem(box.items[0], ev);
      });
      b.el.addEventListener('mouseenter', () => { if (box.items.length === 1) showDiff(box.el, box.items[0]); });
      b.el.addEventListener('mouseleave', hideTip);
    }
    const item = {
      text: e.action === 'spawn' ? (e.subagentType ? e.subagentType + ': ' : '') + (e.detail || '') : (e.file || e.detail || ''),
      file: e.abs || null, line: firstLine(e), fail: false, t0: e.t, t1: 0,
      sub: e.ranges && e.ranges.length && e.ranges[0].symbol ? e.ranges[0].symbol : (e.lines ? e.lines + ' lines' : ''),
      diff: e.diff && e.diff.length ? e.diff : null,
      planLink: e.action === 'plan' || e.action === 'tasks',
    };
    b.items.push(item);
    actions.set(feedKey(e), { b, item });
    timed.add(b);
    L.turn.actions++; turnMeta(L.turn);
    render(b);
    setCurrent(L, b);
    return b;
  }

  function boxTime(b) {
    let total = 0, running = false;
    for (const i of b.items) {
      if (i.t1) total += i.t1 - i.t0; else { total += Math.max(0, clock() - i.t0); running = true; }
    }
    b.dur.textContent = fmtDur(total);
    b.dur.classList.toggle('live', running);
    if (!running) timed.delete(b);
  }

  function render(b) {
    const n = b.items.length, last = b.items[n - 1];
    const fails = b.items.filter((i) => i.fail).length;
    const open = b.expanded && n > 1;
    b.n.hidden = n < 2; b.n.textContent = '×' + n;
    b.t.textContent = last.text; b.t.hidden = open;
    const sub = b.wait ? 'Waiting for your approval'
      : n === 1 ? last.sub : open ? '' : 'and ' + (n - 1) + ' more' + (fails ? ', ' + fails + ' failed' : '');
    b.sub.textContent = sub; b.sub.hidden = !sub;
    b.el.classList.toggle('fail', fails > 0);
    b.el.classList.toggle('group', n > 1);
    b.el.classList.toggle('open', open);
    b.el.classList.toggle('link', n > 1 || !!last.file || last.planLink);
    b.el.title = n > 1 ? (open ? 'Click to collapse' : 'Click to show all ' + n + ':\n' + b.items.map((i) => i.text).join('\n'))
      : last.diff ? '' : b.kind + ' ' + last.text + (last.sub ? '\n' + last.sub : '') + (last.file ? '\nClick to open, Shift+click to show in the graph' : last.planLink ? '\nClick to see the plan as a flowchart' : '');
    boxTime(b);
    b.list.hidden = !open;
    b.list.textContent = '';
    if (open) {
      for (const item of b.items) {
        const li = document.createElement('li');
        if (item.fail) li.className = 'fail';
        if (item.file) li.classList.add('link');
        const row = document.createElement('span'); row.className = 'row';
        const t = document.createElement('span'); t.className = 'text'; t.textContent = item.text;
        const d = document.createElement('span'); d.className = 'dur'; d.textContent = item.t1 ? fmtDur(item.t1 - item.t0) : '';
        row.append(t, d);
        li.append(row);
        if (item.sub) { const s2 = document.createElement('span'); s2.className = 'sub'; s2.textContent = item.sub; li.append(s2); }
        if (!item.diff) li.title = item.text + (item.sub ? '\n' + item.sub : '');
        li.addEventListener('click', (ev) => { ev.stopPropagation(); openItem(item, ev); });
        li.addEventListener('mouseenter', () => showDiff(li, item));
        li.addEventListener('mouseleave', hideTip);
        b.list.append(li);
      }
    }
    b.turn.dirty = true;
    queueLines();
  }

  // before and after of an edit, shown beside the box while the pointer is on it
  function showDiff(anchor, item) {
    if (!item.diff) return;
    tip.textContent = '';
    tip.className = 'diff';
    const h = document.createElement('div'); h.className = 'dh';
    h.textContent = item.text + (item.sub ? '  ' + item.sub : '');
    tip.append(h);
    for (const d of item.diff) {
      const pre = document.createElement('pre');
      for (const [sign, text] of [['-', d.o], ['+', d.n]]) {
        if (!text) continue;
        for (const line of text.split('\n')) {
          const row = document.createElement('span'); row.className = sign === '-' ? 'del' : 'add';
          row.textContent = sign + ' ' + line + '\n';
          pre.append(row);
        }
      }
      tip.append(pre);
    }
    tip.hidden = false;
    const s0 = stage.getBoundingClientRect(), r = anchor.getBoundingClientRect();
    let x = r.right - s0.left + 12;
    if (x + tip.offsetWidth > s0.width - 8) x = Math.max(8, r.left - s0.left - tip.offsetWidth - 12);
    const y = Math.max(8, Math.min(r.top - s0.top, s0.height - tip.offsetHeight - 8));
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }

  function hideTip() { tip.hidden = true; tip.className = ''; }

  function flowApply(e, actor, session, live) {
    let made = null;
    if (replayClock) replayClock = e.t;
    if (e.ev === 'UserPromptSubmit') {
      const T = newTurn(e.session, e.detail || 'New request');
      T.t0 = e.t;
      const L = flowLane(session, e.session);
      setCurrent(L, L.boxes[0]);
      made = L.boxes[0];
    } else if (e.ev === 'UsageGuard') {
      if (e.guardStage === 'resumed') newTurn(e.session, 'Usage guard resumed session');
      const L = flowLane(session, e.session);
      made = flowBox(L, 'k-guard ' + (e.guardStage || 'careful'), 'Usage guard',
        (e.guardLabel || 'Status') + (e.detail ? ': ' + e.detail : ''));
    } else if (e.ev === 'SubagentStart') {
      made = flowLane(actor, e.session).boxes[0];
    } else if (e.ev === 'SubagentStop' || e.ev === 'Stop') {
      const L = flowLane(e.ev === 'Stop' ? session : actor, e.session);
      clearWait(L);
      // anything this agent left open is over now
      for (const b of L.boxes) { let touched = false; for (const i of b.items) if (!i.t1) { i.t1 = i.t0; touched = true; } if (touched) boxTime(b); }
      made = flowBox(L, 'term' + (e.detail ? ' said' : ''), e.ev === 'Stop' ? 'Finished the turn' : 'Finished', e.detail || '');
      setCurrent(L, null);
      if (e.ev === 'Stop') { L.turn.t1 = e.t; turnMeta(L.turn); }
    } else if (e.ev === 'PreToolUse' && e.action === 'tasks') {
      // task-list bookkeeping lives in the Plan view; as boxes it would only break up the real work
    } else if (e.ev === 'PreToolUse') {
      const L = flowLane(actor, e.session);
      clearWait(L);
      made = addAction(L, e);
    } else if (e.ev === 'PermissionRequest' || (e.ev === 'Notification' && e.ntype === 'permission_prompt')) {
      const L = flowLane(actor, e.session);
      if (setWait(L)) made = L.waitBox;
    } else if (e.ev === 'PostToolUse' || e.ev === 'PostToolUseFailure') {
      const a = actions.get(feedKey(e)) || (!e.toolUseId && actions.get([e.session, e.agentId, e.tool, e.file].join('|')));
      if (a) {
        if (a.b.lane.waitBox === a.b) clearWait(a.b.lane);
        a.item.t1 = Math.max(e.t, a.item.t0);
        if (e.ev === 'PostToolUseFailure') {
          a.item.fail = true; a.item.sub = 'failed' + (e.error ? ': ' + e.error : '');
        } else if (e.ranges && e.ranges.length) {
          a.item.line = e.ranges[0].start;
          a.item.sub = e.ranges.map(rangeText).join('; ');
        }
        render(a.b);
      }
    }
    if (made && live && Date.now() - lastUserScroll > 4000 && !flowEl.hidden) {
      made.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }

  // After history is loaded, an action with no recorded end and no recent start is not really running.
  function closeStale() {
    const now = Date.now();
    for (const b of [...timed]) {
      for (const i of b.items) if (!i.t1 && now - i.t0 > 15 * 60e3) i.t1 = i.t0;
      boxTime(b);
    }
  }

  setInterval(() => { for (const b of [...timed]) boxTime(b); }, 1000);

  function queueLines() {
    if (linesQueued) return;
    linesQueued = true;
    requestAnimationFrame(drawLines);
  }

  function svgPath(T, d, cls, colour) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', cls);
    if (colour) p.style.setProperty('--c', colour);
    T.svg.append(p);
  }

  // Arrows: down each column from one box to the next, and across from each "Start agent" box
  // to the column of the agent it started.
  function drawLines() {
    linesQueued = false;
    if (flowEl.hidden) return;
    for (const T of turns) {
      if (T.el.classList.contains('folded')) continue;
      if (T.dirty) layout(T);
      T.svg.setAttribute('width', T.grid.scrollWidth);
      T.svg.setAttribute('height', T.grid.scrollHeight);
      T.svg.textContent = '';
      for (const L of T.lanes) {
        for (let i = 1; i < L.boxes.length; i++) {
          const p = L.boxes[i - 1].el, c = L.boxes[i].el;
          const x = c.offsetLeft + c.offsetWidth / 2, y1 = p.offsetTop + p.offsetHeight, y2 = c.offsetTop;
          const on = L.cur === L.boxes[i];
          const colour = on ? getComputedStyle(c).getPropertyValue('--accent') : '';
          svgPath(T, 'M' + x + ' ' + y1 + ' V' + (y2 - 6), 'seq' + (on ? ' on' : ''), colour);
          svgPath(T, 'M' + x + ' ' + y2 + ' l-4.5 -7 h9 z', 'seqHead' + (on ? ' on' : ''), colour);
        }
        if (L.from && L.boxes.length) {
          const a = L.from.el, b = L.boxes[0].el;
          const right = b.offsetLeft > a.offsetLeft;
          const dir = right ? 1 : -1;
          const x1 = right ? a.offsetLeft + a.offsetWidth : a.offsetLeft;
          const y1 = a.offsetTop + a.offsetHeight / 2;
          const x2 = right ? b.offsetLeft - 7 : b.offsetLeft + b.offsetWidth + 7;
          const y2 = b.offsetTop + b.offsetHeight / 2;
          const far = Math.abs(x2 - x1) > 120;
          const gy = a.offsetTop - 11;
          svgPath(T, far
            ? 'M' + x1 + ' ' + y1 + ' h' + (dir * 14) + ' V' + gy + ' H' + (x2 - dir * 14) + ' V' + y2 + ' H' + x2
            : 'M' + x1 + ' ' + y1 + ' h' + (dir * 14) + ' V' + y2 + ' H' + x2, 'spawn');
          svgPath(T, 'M' + x2 + ' ' + y2 + ' l' + (dir * -7) + ' -4.5 v9 z', 'spawnHead');
        }
      }
    }
  }
  flowEl.addEventListener('wheel', () => { lastUserScroll = Date.now(); }, { passive: true });
  flowEl.addEventListener('pointerdown', () => { lastUserScroll = Date.now(); });

  // ---------- moving between the two views ----------
  function showInGraph(id) {
    const n = nodes.get(id);
    if (!n) return;
    ui.view = 'graph'; applyUi();
    autoFit = false;
    view.k = Math.max(view.k, 1.1);
    view.x = width / 2 - n.x * view.k; view.y = height / 2 - n.y * view.k;
    n.heat = 1; hover = n;
    kick();
  }

  function showInFlow(id) {
    const L = lanes.get(id);
    if (!L || !L.boxes || !L.boxes.length) return;
    ui.view = 'flow'; applyUi();
    L.turn.el.classList.remove('folded'); L.turn.head.setAttribute('aria-expanded', 'true');
    L.turn.dirty = true; queueLines();
    const b = L.cur || L.boxes[L.boxes.length - 1];
    lastUserScroll = Date.now();
    requestAnimationFrame(() => {
      b.el.scrollIntoView({ block: 'center', inline: 'center' });
      b.el.classList.remove('flash'); void b.el.offsetWidth; b.el.classList.add('flash');
    });
  }

  // ---------- plan: the proposed plan and the task list, each drawn as a flowchart ----------
  const planEl = $('plan');
  let plans = new Map();   // session id -> { plan: {title, steps, state}, tasks: [] }

  function planReset() { plans = new Map(); renderPlans(); }

  function clean(text) {
    return text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]+/g, '').replace(/^\[[ xX]\]\s*/, '').trim();
  }

  // Turns the plan's markdown into steps: numbered items first, then bullets, then headings.
  function parsePlan(md) {
    const lines = md.split('\n');
    let title = '';
    const heads = [], items = [];
    let phase = '';
    for (const raw of lines) {
      const h = raw.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
      if (h) {
        const text = clean(h[2]);
        if (h[1].length === 1 && !title) { title = text; continue; }
        phase = text; heads.push({ text, details: [] });
        continue;
      }
      const li = raw.match(/^(\s*)(\d+[.)]|[-*+])\s+(.*)$/);
      if (li) {
        items.push({ indent: li[1].replace(/\t/g, '    ').length, numbered: /\d/.test(li[2]), text: clean(li[3]), phase, details: [] });
      } else if (raw.trim() && heads.length) {
        heads[heads.length - 1].details.push(clean(raw));
      }
    }
    let steps = [];
    const numbered = items.filter((i) => i.numbered);
    const pool = numbered.length >= 2 ? items.filter((i) => i.numbered || i.indent > Math.min(...numbered.map((n) => n.indent))) : items;
    if (pool.length >= 2) {
      const top = Math.min(...(numbered.length >= 2 ? numbered : pool).map((i) => i.indent));
      for (const i of pool) {
        if (i.indent <= top && (numbered.length < 2 || i.numbered)) steps.push({ text: i.text, phase: i.phase, details: [], status: 'pending' });
        else if (steps.length) steps[steps.length - 1].details.push(i.text);
      }
    } else if (heads.length >= 2) {
      steps = heads.map((h) => ({ text: h.text, phase: '', details: h.details.slice(0, 3), status: 'pending' }));
    } else {
      steps = lines.map((l) => clean(l)).filter(Boolean).slice(0, 12).map((text) => ({ text, phase: '', details: [], status: 'pending' }));
      if (steps.length && !title && steps.length > 1) title = '';
    }
    return { title: title || 'Proposed plan', steps: steps.slice(0, 40) };
  }

  function planFor(sessionId) {
    let S = plans.get(sessionId);
    if (!S) { S = { plan: null, tasks: [] }; plans.set(sessionId, S); }
    return S;
  }

  function planApply(e, live) {
    if (e.ev === 'UserPromptSubmit' || e.ev === 'Stop') {
      const S = plans.get(e.session);
      if (S && S.plan && S.plan.state === 'waiting') { S.plan.state = 'changes'; renderPlans(); }
      return;
    }
    if (e.action !== 'plan' && e.action !== 'tasks') return;
    const S = planFor(e.session);
    if (e.action === 'plan') {
      if (e.ev === 'PreToolUse' || e.ev === 'PermissionRequest') {
        if (e.plan) { S.plan = parsePlan(e.plan); S.plan.state = 'waiting'; }
        else if (!S.plan) S.plan = { title: 'Proposed plan', steps: [], state: 'waiting' };
        else S.plan.state = 'waiting';
        if (live && opts.autoPlan && e.ev === 'PreToolUse') { ui.view = 'plan'; applyUi(); }
      } else if (e.ev === 'PostToolUse' && S.plan) S.plan.state = 'approved';
      else if (e.ev === 'PostToolUseFailure' && S.plan) S.plan.state = 'changes';
    } else if (e.todos && e.ev === 'PreToolUse') {
      S.tasks = e.todos.map((t, i) => ({ id: String(i + 1), text: t.text, details: [], status: t.status }));
    } else if (e.task && e.tool === 'TaskCreate') {
      if (e.ev === 'PreToolUse') {
        S.tasks.push({ id: String(S.tasks.length + 1), key: feedKey(e), text: e.task.subject, details: e.task.desc && e.task.desc !== e.task.subject ? [e.task.desc] : [], status: 'pending' });
      } else if (e.ev === 'PostToolUse' && e.task.id) {
        const t = S.tasks.find((x) => x.key === feedKey(e)) || S.tasks.find((x) => x.text === e.task.subject);
        if (t) t.id = e.task.id;
      }
    } else if (e.task && e.tool === 'TaskUpdate' && e.ev === 'PreToolUse') {
      const t = S.tasks.find((x) => x.id === e.task.id) || S.tasks[Number(e.task.id) - 1];
      if (t) {
        if (e.task.status === 'deleted') S.tasks.splice(S.tasks.indexOf(t), 1);
        else { if (e.task.status) t.status = e.task.status; if (e.task.subject) t.text = e.task.subject; }
      }
    } else return;
    renderPlans();
  }

  function planChart(title, stateText, stateCls, steps, word) {
    const sec = document.createElement('section'); sec.className = 'pchart';
    const head = document.createElement('div'); head.className = 'phead';
    const h = document.createElement('h3'); h.textContent = title;
    const st = document.createElement('span'); st.className = 'pstate ' + stateCls; st.textContent = stateText;
    head.append(h, st);
    const flowBoxes = document.createElement('div'); flowBoxes.className = 'pflow';
    const add = (el) => {
      if (flowBoxes.children.length) { const a = document.createElement('i'); a.className = 'parrow'; flowBoxes.append(a); }
      flowBoxes.append(el);
    };
    const pill = (text, cls) => { const el = document.createElement('div'); el.className = 'box term ppill ' + (cls || ''); el.textContent = text; return el; };
    add(pill('Start'));
    let phase = '';
    steps.forEach((s2, i) => {
      if (s2.phase && s2.phase !== phase) {
        phase = s2.phase;
        const ph = document.createElement('div'); ph.className = 'phase'; ph.textContent = phase;
        add(ph);
      }
      const done = s2.status === 'completed', doing = s2.status === 'in_progress';
      const el = document.createElement('div');
      el.className = 'box pstep ' + (done ? 'done' : doing ? 'doing current' : 'todo');
      const top = document.createElement('span'); top.className = 'top';
      const k = document.createElement('span'); k.className = 'kind'; k.textContent = word + ' ' + (i + 1);
      const d = document.createElement('span'); d.className = 'dur'; d.textContent = done ? 'done' : doing ? 'in progress' : '';
      top.append(k, d);
      const t = document.createElement('span'); t.className = 'text'; t.textContent = s2.text;
      el.append(top, t);
      if (s2.details && s2.details.length) {
        const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = s2.details.join('\n');
        el.append(sub);
      }
      if (doing) el.insertAdjacentHTML('beforeend', SNAKE);
      add(el);
    });
    const allDone = steps.length > 0 && steps.every((x) => x.status === 'completed');
    add(pill('Done', allDone ? 'reached' : ''));
    sec.append(head, flowBoxes);
    return sec;
  }

  function renderPlans() {
    planEl.textContent = '';
    let any = false;
    for (const S of plans.values()) {
      if (S.plan) {
        any = true;
        const text = { waiting: 'Waiting for your approval', approved: 'Approved', changes: 'Not approved yet' }[S.plan.state] || '';
        planEl.append(planChart(S.plan.title, text, S.plan.state, S.plan.steps, 'Step'));
      }
      if (S.tasks.length) {
        any = true;
        const done = S.tasks.filter((t) => t.status === 'completed').length;
        planEl.append(planChart('Task list', done + ' of ' + S.tasks.length + ' done', done === S.tasks.length ? 'approved' : '', S.tasks, 'Task'));
      }
    }
    $('viewPlan').classList.toggle('has', any);
    if (!any) {
      const p = document.createElement('p'); p.className = 'pempty';
      p.textContent = 'No plan yet. When Claude Code proposes a plan (plan mode) or makes a task list, it appears here as a flowchart, and tasks are marked off as they get done.';
      planEl.append(p);
    }
  }

  // ---------- feed ----------
  const CAT_ORDER = ['Read', 'Edit', 'Shell', 'Search', 'Web', 'Agents', 'Guard', 'Connector', 'Other'];

  function row(e, who, what, target, open, cls, withWho) {
    const li = document.createElement('li');
    if (cls) li.className = cls;
    const time = document.createElement('time');
    time.textContent = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    li.append(time);
    if (withWho) { const w = document.createElement('span'); w.className = 'who'; w.textContent = who + ' '; li.append(w); }
    const v = document.createElement('span'); v.className = 'what'; v.textContent = what + ' ';
    const t = document.createElement('span'); t.className = 'target'; t.textContent = target;
    li.append(v, t);
    li.title = who + ' ' + what + ' ' + target;
    if (open && open.file) {
      li.classList.add('link');
      li.addEventListener('click', () => vscode.postMessage({ type: 'open', file: open.file, line: open.line }));
    }
    return li;
  }

  // One collapsible section per agent, holding that agent's actions and a count per action type.
  function group(actor) {
    let g = groups.get(actor.id);
    if (g) return g;
    const el = document.createElement('details'); el.open = true; el.className = 'group ' + actor.kind;
    const sum = document.createElement('summary');
    const dot = document.createElement('i'); dot.className = 'dot';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = actor.kind === 'main' ? 'Claude' : actor.label;
    const state = document.createElement('span'); state.className = 'state';
    sum.append(dot, name, state);
    const desc = document.createElement('div'); desc.className = 'desc'; desc.textContent = actor.info || ''; desc.hidden = !actor.info;
    const counts = document.createElement('div'); counts.className = 'cats';
    const list = document.createElement('ol');
    el.append(sum, desc, counts, list);
    groupsEl.append(el);
    g = { el, state, counts, list, cats: {}, actor };
    groups.set(actor.id, g);
    return g;
  }

  function noteCat(actor, cat) {
    const g = group(actor);
    g.cats[cat] = (g.cats[cat] || 0) + 1;
    g.counts.textContent = '';
    for (const c of CAT_ORDER.concat(Object.keys(g.cats).filter((k) => !CAT_ORDER.includes(k)))) {
      if (!g.cats[c]) continue;
      const chip = document.createElement('span'); chip.textContent = c + ' ' + g.cats[c];
      g.counts.append(chip);
    }
  }

  function addFeed(e, actor, who, what, target, open, cls, cat) {
    const li = row(e, who, what, target, open, cls, true);
    feed.prepend(li);
    while (feed.children.length > 250) feed.lastChild.remove();

    const g = group(actor);
    const li2 = row(e, who, what, target, open, cls, who === 'You');
    g.list.prepend(li2);
    while (g.list.children.length > 120) g.list.lastChild.remove();
    if (cat) noteCat(actor, cat);
    if (cls !== 'wait') feedById.set(feedKey(e), [li, li2]);
    if (feedById.size > 600) feedById.delete(feedById.keys().next().value);
  }

  function feedKey(e) {
    return e.toolUseId || [e.session, e.agentId, e.tool, e.file || e.detail].join('|');
  }

  function markFailed(e) {
    let rows = feedById.get(feedKey(e));
    if (!rows && !e.toolUseId) rows = feedById.get([e.session, e.agentId, e.tool, e.file].join('|'));
    for (const li of rows || []) {
      li.classList.add('fail');
      const v = li.querySelector('.what');
      if (v && !v.textContent.startsWith('failed')) v.textContent = 'failed: ' + v.textContent;
      if (e.error) li.title = e.error;
    }
  }

  // ---------- layout ----------
  function radius(n) {
    if (n.kind === 'main') return 15;
    if (n.kind === 'agent') return 10;
    if (n.kind === 'file') return n.edited ? 7 : 5;
    return 4;
  }

  function step() {
    const list = [...nodes.values()];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        if (d2 > 160000) continue;
        const f = 3400 / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
      a.vx -= a.x * 0.006; a.vy -= a.y * 0.006;
    }
    for (const l of links.values()) {
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - (REST[l.kind] || 90)) * 0.045;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      l.a.vx += fx; l.a.vy += fy; l.b.vx -= fx; l.b.vy -= fy;
    }
    for (const n of list) {
      if (drag && drag.node === n) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx * alpha; n.y += n.vy * alpha;
    }
    alpha *= 0.985;
    if (alpha < 0.02) alpha = 0;
  }

  function fit(immediate) {
    if (!nodes.size || !width) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes.values()) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y);
    }
    const k = Math.min(1.5, Math.min(width / (x1 - x0 + 170), height / (y1 - y0 + 150)));
    const tx = width / 2 - ((x0 + x1) / 2) * k, ty = height / 2 - ((y0 + y1) / 2) * k;
    const s = immediate ? 1 : 0.12;
    view.k += (k - view.k) * s; view.x += (tx - view.x) * s; view.y += (ty - view.y) * s;
  }

  // ---------- drawing ----------
  function color(n) {
    if (n.kind === 'main') return theme.main;
    if (n.kind === 'agent') return theme.agent;
    if (n.kind === 'file') return n.edited ? theme.file : theme.muted;
    return theme.section;
  }

  function shape(n, r) {
    ctx.beginPath();
    if (n.kind === 'file') {
      if (ctx.roundRect) ctx.roundRect(n.x - r, n.y - r, r * 2, r * 2, 2.5); else ctx.rect(n.x - r, n.y - r, r * 2, r * 2);
    } else if (n.kind === 'section') {
      ctx.moveTo(n.x, n.y - r * 1.25); ctx.lineTo(n.x + r * 1.25, n.y); ctx.lineTo(n.x, n.y + r * 1.25); ctx.lineTo(n.x - r * 1.25, n.y);
      ctx.closePath();
    } else {
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    }
  }

  function draw(now) {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);
    const many = nodes.size > 90;

    for (const l of links.values()) {
      const dim = l.b.status === 'done' ? 0.45 : 1;
      ctx.globalAlpha = (l.kind === 'read' ? 0.22 : 0.42) * dim + l.heat * 0.5;
      ctx.strokeStyle = l.kind === 'read' ? theme.muted : l.kind === 'section' ? theme.section
        : l.kind === 'spawn' ? theme.agent : theme.file;
      ctx.lineWidth = (1 + l.heat * 1.5) / Math.max(view.k, 0.6);
      ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); ctx.stroke();
    }
    ctx.lineJoin = 'round';

    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const n of nodes.values()) {
      const r = radius(n);
      const c = n.fail > 0.05 ? theme.err : color(n);
      const dim = n.status === 'done' ? 0.45 : 1;
      // glow for anything that just happened
      if (n.heat > 0.03 || n.fail > 0.03) {
        ctx.globalAlpha = Math.max(n.heat, n.fail) * 0.28;
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 4 + Math.max(n.heat, n.fail) * 6, 0, Math.PI * 2); ctx.fill();
      }
      // steady pulse ring while an agent is working or a file is being touched
      if (n.status === 'running' || n.active > 0) {
        const p = (now / 1100 + (n.x + n.y) * 0.002) % 1;
        ctx.globalAlpha = (1 - p) * 0.55;
        ctx.strokeStyle = c; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 3 + p * 8, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = dim;
      shape(n, r);
      if (n.kind === 'file' && !n.edited) {
        ctx.fillStyle = theme.bg; ctx.fill();
        ctx.strokeStyle = c; ctx.lineWidth = 1.3;
        ctx.stroke();
      } else {
        ctx.fillStyle = c; ctx.fill();
      }
      if (hover === n) {
        ctx.strokeStyle = theme.fg; ctx.lineWidth = 1.5; shape(n, r + 2.5); ctx.stroke();
      }
      const showLabel = !many || n.kind === 'main' || n.kind === 'agent' || n.heat > 0.05 || hover === n;
      if (showLabel && view.k > 0.45) {
        const big = n.kind === 'main' || n.kind === 'agent';
        const quiet = n.kind === 'section' || (n.kind === 'file' && !n.edited);
        ctx.font = (big ? '600 12px ' : quiet ? '10px ' : '11px ') + theme.font;
        const text = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label;
        const ty = n.y + r + (n.kind === 'section' ? 6 : 5);
        label(text, n.x, ty, quiet ? theme.muted : theme.fg, dim);
        // what the agent is doing right now, fading out once it moves on
        if (big && n.doing && n.doingHeat > 0.05) {
          ctx.font = '10px ' + theme.font;
          const d = n.doing.length > 34 ? n.doing.slice(0, 33) + '…' : n.doing;
          label(d, n.x, ty + 15, n.fail > 0.05 ? theme.err : theme.muted, Math.min(1, n.doingHeat * 1.6));
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // text with a background-coloured outline so lines never cut through it
  function label(text, x, y, fill, a) {
    ctx.globalAlpha = a;
    ctx.lineWidth = 3; ctx.strokeStyle = theme.bg; ctx.strokeText(text, x, y);
    ctx.fillStyle = fill; ctx.fillText(text, x, y);
  }

  function frame(now) {
    let busy = alpha > 0 || !!drag;
    if (alpha > 0) step();
    for (const n of nodes.values()) {
      n.heat *= 0.972; n.fail *= 0.985; n.doingHeat *= 0.994;
      if (n.heat > 0.03 || n.fail > 0.03 || n.doingHeat > 0.05 || n.status === 'running' || n.active > 0) busy = true;
    }
    for (const l of links.values()) { l.heat *= 0.965; if (l.heat > 0.03) busy = true; }
    if (autoFit && (alpha > 0 || busy)) fit(false);
    draw(now);
    if (busy) requestAnimationFrame(frame); else running = false;
  }

  function kick() {
    if (!running) { running = true; requestAnimationFrame(frame); }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    width = stage.clientWidth; height = stage.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    if (autoFit) fit(true);
    kick();
  }

  // ---------- header and empty state ----------
  function refreshChrome() {
    let agents = 0, files = 0, edited = 0;
    for (const n of nodes.values()) {
      if (n.kind === 'agent' && n.status === 'running') agents++;
      if (n.kind === 'file') { files++; if (n.edited) edited++; }
    }
    const st = $('status');
    let waitingNow = false;
    for (const L of lanes.values()) if (L.waitBox) waitingNow = true;
    st.className = 'status' + (waitingNow ? ' wait' : state.connected ? ' on' : '');
    st.textContent = waitingNow ? 'Waiting for your approval' : state.connected ? 'Connected' : 'Not connected';
    st.title = state.port ? 'Listening on 127.0.0.1:' + state.port : '';
    $('counts').textContent = nodes.size
      ? agents + (agents === 1 ? ' agent running · ' : ' agents running · ') + files + (files === 1 ? ' file' : ' files') + ' · ' + edited + ' edited'
      : '';
    for (const g of groups.values()) {
      const st = g.actor.status === 'running' ? 'working' : g.actor.status === 'done' ? 'finished' : 'idle';
      g.state.textContent = st;
      g.el.classList.toggle('working', st === 'working');
      g.el.classList.toggle('finished', st === 'finished');
    }
    $('connect').hidden = state.connected;
    if (state.extVersion) {
      $('update').title = 'Installed: v' + state.extVersion + ' on VS Code ' + state.vscodeVersion +
        '. Click to install a newer .vsix of this extension.';
    }
    $('empty').hidden = nodes.size > 0 || ui.view === 'plan';
    $('emptyHint').textContent = state.connected
      ? 'Start Claude Code in this folder and give it a task. Its actions appear here as they happen.'
      : state.hasFolder
        ? 'Connect this workspace, then start Claude Code in this folder.'
        : 'Open a folder in VS Code, then connect it.';
  }

  // ---------- interaction ----------
  function world(ev) {
    const b = canvas.getBoundingClientRect();
    return { x: (ev.clientX - b.left - view.x) / view.k, y: (ev.clientY - b.top - view.y) / view.k, sx: ev.clientX - b.left, sy: ev.clientY - b.top };
  }

  function pick(p) {
    let best = null, bd = Infinity;
    for (const n of nodes.values()) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < radius(n) + 7 / view.k && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  function tipText(n) {
    const tools = n.tools ? '\n' + Object.keys(n.tools).map((k) => k + ' ×' + n.tools[k]).join(' · ') : '';
    if (n.kind === 'main') return 'Claude (main agent)\n' + n.count + ' actions' + tools + '\nClick to see its steps';
    if (n.kind === 'agent') return 'Sub-agent: ' + n.label + (n.info ? '\n' + n.info : '') + '\n' + n.count + ' actions' + (n.status === 'done' ? ' · finished' : '') + tools + '\nClick to see its steps';
    if (n.kind === 'file') return n.path + '\n' + n.count + (n.count === 1 ? ' touch' : ' touches') + (n.edited ? ' · edited' : ' · read only') + '\nClick to open';
    return n.label + '\n' + n.path + ', ' + n.info + '\nClick to open';
  }

  canvas.addEventListener('pointerdown', (ev) => {
    const p = world(ev);
    const n = pick(p);
    drag = { node: n, sx: p.sx, sy: p.sy, vx: view.x, vy: view.y, moved: false };
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add('dragging');
    kick();
  });
  canvas.addEventListener('pointermove', (ev) => {
    const p = world(ev);
    if (drag) {
      if (Math.hypot(p.sx - drag.sx, p.sy - drag.sy) > 4) drag.moved = true;
      if (drag.node) { drag.node.x = p.x; drag.node.y = p.y; alpha = Math.max(alpha, 0.3); }
      else if (drag.moved) { view.x = drag.vx + p.sx - drag.sx; view.y = drag.vy + p.sy - drag.sy; autoFit = false; }
      return;
    }
    const n = pick(p);
    if (n !== hover) { hover = n; kick(); }
    canvas.classList.toggle('pointing', !!n);
    if (n) {
      tip.hidden = false; tip.className = ''; tip.textContent = tipText(n);
      tip.style.left = Math.min(p.sx + 14, width - 200) + 'px'; tip.style.top = p.sy + 16 + 'px';
    } else tip.hidden = true;
  });
  canvas.addEventListener('pointerup', () => {
    const d = drag; drag = null;
    canvas.classList.remove('dragging');
    if (!d || !d.node || d.moved) return;
    if (d.node.abs) vscode.postMessage({ type: 'open', file: d.node.abs, line: d.node.line || 0 });
    else if (d.node.kind === 'main' || d.node.kind === 'agent') showInFlow(d.node.id);
  });
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; if (hover) { hover = null; kick(); } });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = world(ev);
    const k = Math.min(3, Math.max(0.2, view.k * Math.exp(-ev.deltaY * 0.0015)));
    view.x = p.sx - p.x * k; view.y = p.sy - p.y * k; view.k = k;
    autoFit = false; kick();
  }, { passive: false });

  const ui = Object.assign({ mode: 'agent', view: 'flow', align: false }, (vscode.getState && vscode.getState()) || {});
  function applyUi() {
    const byAgent = ui.mode !== 'time';
    groupsEl.hidden = !byAgent; feed.hidden = byAgent;
    $('modeAgent').classList.toggle('on', byAgent); $('modeTime').classList.toggle('on', !byAgent);
    const flowView = ui.view === 'flow', planView = ui.view === 'plan', graphView = !flowView && !planView;
    flowEl.hidden = !flowView; planEl.hidden = !planView; canvas.hidden = !graphView; $('legend').hidden = !graphView;
    $('viewFlow').classList.toggle('on', flowView); $('viewGraph').classList.toggle('on', graphView); $('viewPlan').classList.toggle('on', planView);
    $('fit').hidden = planView;
    $('align').hidden = !flowView; $('align').classList.toggle('on', !!ui.align);
    $('align').setAttribute('aria-pressed', String(!!ui.align));
    for (const T of turns) T.dirty = true;
    $('fit').textContent = flowView ? 'Latest' : 'Fit';
    $('fit').title = flowView ? 'Scroll to the most recent action' : 'Fit the graph to the panel';
    if (vscode.setState) vscode.setState(ui);
    if (flowView) queueLines(); else if (graphView) resize();
  }
  $('modeAgent').addEventListener('click', () => { ui.mode = 'agent'; applyUi(); });
  $('modeTime').addEventListener('click', () => { ui.mode = 'time'; applyUi(); });
  $('viewFlow').addEventListener('click', () => { ui.view = 'flow'; applyUi(); });
  $('viewGraph').addEventListener('click', () => { ui.view = 'graph'; applyUi(); });
  $('viewPlan').addEventListener('click', () => { ui.view = 'plan'; applyUi(); });
  $('align').addEventListener('click', () => { ui.align = !ui.align; applyUi(); });

  // ---------- sessions, rebuild and replay ----------
  let history = [];
  let replayTimer = null;
  let replayList = [];
  let replayPos = 0;
  const sessionPick = $('sessionPick');

  function shown(e) { return !onlySession || e.session === onlySession; }

  function noteSession(e) {
    let label = sessions.get(e.session);
    const fresh = label === undefined;
    if (fresh) label = '';
    if (!label && e.ev === 'UserPromptSubmit' && e.detail) label = e.detail.length > 42 ? e.detail.slice(0, 41) + '…' : e.detail;
    if (fresh || label !== sessions.get(e.session)) { sessions.set(e.session, label); fillPicker(); }
  }

  function fillPicker() {
    sessionPick.textContent = '';
    const all = document.createElement('option'); all.value = ''; all.textContent = 'All sessions (' + sessions.size + ')';
    sessionPick.append(all);
    let i = 0;
    for (const [id, label] of sessions) {
      const o = document.createElement('option'); o.value = id; o.textContent = 'Session ' + (++i) + (label ? ': ' + label : '');
      sessionPick.append(o);
    }
    if (onlySession && !sessions.has(onlySession)) onlySession = '';
    sessionPick.value = onlySession;
    sessionPick.hidden = sessions.size < 2;
  }

  // draw everything again from the stored events, for a new filter or changed settings
  function rebuild() {
    if (replayTimer) { clearInterval(replayTimer); replayTimer = null; replayClock = 0; $('replay').textContent = 'Replay'; }
    reset();
    for (const e of history) if (shown(e)) apply(e, false);
    closeStale();
    for (let i = 0; i < 260 && alpha > 0; i++) step(); // settle the graph before showing it
    fit(true);
    queueLines(); refreshChrome(); kick();
  }
  sessionPick.addEventListener('change', () => { onlySession = sessionPick.value; rebuild(); });

  function stopReplay() {
    if (!replayTimer) return;
    clearInterval(replayTimer); replayTimer = null;
    replayClock = 0;
    for (; replayPos < replayList.length; replayPos++) apply(replayList[replayPos], false);
    $('replay').textContent = 'Replay';
    closeStale(); refreshChrome(); kick(); queueLines();
  }
  $('replay').addEventListener('click', () => {
    if (replayTimer) { stopReplay(); return; }
    replayList = history.filter(shown);
    if (!replayList.length) return;
    reset();
    replayPos = 0; replayClock = replayList[0].t; lastUserScroll = 0;
    $('replay').textContent = 'Stop';
    refreshChrome();
    replayTimer = setInterval(() => {
      if (replayPos >= replayList.length) { stopReplay(); return; }
      apply(replayList[replayPos++], true);
      refreshChrome(); kick();
    }, 150);
  });

  $('fit').addEventListener('click', () => {
    if (ui.view === 'flow') {
      lastUserScroll = 0;
      const all = [...flowGrid.querySelectorAll('.box')].filter((el) => el.offsetParent);
      const cur = all.filter((el) => el.classList.contains('current'));
      const target = cur.length ? cur[cur.length - 1] : all[all.length - 1];
      if (target) target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      return;
    }
    autoFit = true; fit(true); kick();
  });
  $('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  $('connect').addEventListener('click', () => vscode.postMessage({ type: 'connect' }));
  $('demo').addEventListener('click', () => vscode.postMessage({ type: 'demo' }));
  $('parallelDemo').addEventListener('click', () => vscode.postMessage({ type: 'parallelDemo' }));
  $('usageGuardDemo').addEventListener('click', () => vscode.postMessage({ type: 'usageGuardDemo' }));
  $('update').addEventListener('click', () => vscode.postMessage({ type: 'update' }));

  // ---------- messages from the extension ----------
  window.addEventListener('message', (m) => {
    const msg = m.data;
    if (!msg) return;
    if (msg.type === 'init') {
      history = (msg.events || []).slice();
      sessions = new Map(); onlySession = '';
      for (const e of history) noteSession(e);
      fillPicker();
      rebuild();
    } else if (msg.type === 'event') {
      history.push(msg.event);
      noteSession(msg.event);
      if (shown(msg.event)) {
        if (replayTimer) replayList.push(msg.event); // played when its turn comes
        else apply(msg.event, true);
      }
    } else if (msg.type === 'state') {
      const o = Object.assign({ autoPlan: true, group: true, fold: true }, msg.opts || {});
      const redo = o.group !== opts.group || o.fold !== opts.fold;
      state = msg; opts = o;
      if (redo && history.length) rebuild();
    }
    refreshChrome();
    kick();
  });

  new MutationObserver(() => { readTheme(); kick(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new ResizeObserver(() => { resize(); for (const T of turns) T.dirty = true; queueLines(); }).observe(stage);
  readTheme();
  applyUi();
  resize();
  refreshChrome();
  vscode.postMessage({ type: 'ready' });
})();
