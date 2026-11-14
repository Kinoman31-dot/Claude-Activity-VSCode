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
  // user settings, sent by the extension
  const OPT_DEFAULTS = { autoPlan: true, group: true, fold: true, density: 'comfortable', usage: true, answer: true, timings: true, follow: true, foldPhases: true, estimate: true, defaultView: 'flow', aside: true, mode: 'agent' };
  let opts = Object.assign({}, OPT_DEFAULTS);
  let onlySession = '';     // the session being shown; empty means all of them
  let sessions = new Map(); // session id -> label for the picker
  let tagged = false;       // whether the chart was drawn with session tags (more than one session shown)
  // "Session 2" when several sessions share the chart, so two Claudes are never mistaken for one
  function sessionTag(id) {
    if (onlySession || sessions.size < 2) return '';
    let i = 0;
    for (const k of sessions.keys()) { i++; if (k === id) return 'Session ' + i; }
    return '';
  }

  const TOOL_LABEL = { run: 'Shell', search: 'Search', web: 'Web', mcp: 'Connector', other: 'Other', spawn: 'Agents', plan: 'Plan', tasks: 'Tasks' };
  const VERB = { read: 'read', edit: 'editing', write: 'writing', run: 'ran', search: 'searched', web: 'web', spawn: 'started agent', mcp: 'used', other: 'used', plan: 'proposed a plan:', tasks: 'task list,' };
  const REST = { spawn: 175, read: 125, edit: 120, section: 48 };
  // friendlier names for tools that have no category of their own
  const NICE = { EnterPlanMode: 'Plan mode', ToolSearch: 'Tool lookup', AskUserQuestion: 'Question', SubagentHandback: 'Report back', Skill: 'Skill' };
  // "Prompts" that Claude Code sends itself (a sub-agent's report, a background task finishing) are not requests from you.
  const AUTO_RE = /^\s*<(agent-message|task-notification|system-reminder|local-command)/;
  function tidyFile(f) {
    if (!f || !/^([A-Za-z]:[\\/]|\/)/.test(f)) return f || '';
    const parts = f.split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : f;
  }
  function tidyCmd(c) { return (c || '').replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, ''); }
  function promptText(d) { return (d || '').replace(/<[/]?pasted_content[^>]*>/g, '').trim() || 'Pasted text'; }
  function isAuto(e) { return e.ev === 'UserPromptSubmit' && AUTO_RE.test(e.detail || ''); }
  function autoLabel(e) { return /^\s*<agent-message/.test(e.detail || '') ? 'Sub-agent reported back' : 'Background update'; }

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
      'm-haiku': v('--vscode-charts-green', '#89d185'),
      'm-sonnet': v('--vscode-charts-blue', '#3794ff'),
      'm-opus': v('--vscode-charts-purple', '#b180d7'),
      'm-fable': v('--vscode-charts-orange', '#d18616'),
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
    n.session = e.session;
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
    const model = req && req.model ? req.model : null;
    n = node(id, 'agent', (e.agentType || 'agent') + (model ? ' · ' + model : ''), parent);
    n.model = model;
    n.session = e.session;
    n.info = req ? req.desc : '';
    n.spawnKey = req ? req.key : null;
    n.status = 'running';
    link(parent, n, 'spawn', true);
    return n;
  }

  // haiku / sonnet / opus / fable, from an alias or a full model id
  function modelFamily(m) { const x = String(m).toLowerCase().match(/haiku|sonnet|opus|fable/); return x ? x[0] : 'other'; }

  function basename(p) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }

  // a session that only starts or ends, with no work in it, is not worth showing
  function bare(e) { return e.ev === 'SessionStart' || e.ev === 'SessionEnd'; }

  function apply(e, live) {
    if (bare(e) && !nodes.has('s:' + e.session)) return;
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
        if (isAuto(e)) addFeed(e, session, 'Claude', 'received:', autoLabel(e).toLowerCase(), null, 'note');
        else addFeed(e, session, 'You', 'sent a prompt', '', null, 'note ask');
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
          pending.push({ session: e.session, caller: actor.id, type: e.subagentType, desc: e.detail || '', key: feedKey(e), model: e.model || null });
          addFeed(e, actor, who, e.model ? 'started ' + e.model + ' agent:' : 'started agent', (e.model || !e.subagentType ? '' : e.subagentType + ': ') + (e.detail || ''), null, '', 'Agents', e.subagentType ? 'Agent type: ' + e.subagentType : '');
          break; // the agent node itself appears on SubagentStart
        }
        if (e.file) {
          const f = fileNode(e, actor);
          f.heat = hot; f.active++; f.count++;
          link(actor, f, e.action === 'read' ? 'read' : 'edit', live);
          if (e.action !== 'read') f.edited = true;
          sections(e, f, live, false);
          actor.doing = VERB[e.action] + ' ' + f.label; actor.doingHeat = hot;
          addFeed(e, actor, who, VERB[e.action], tidyFile(e.file), { file: e.abs, line: firstLine(e) }, '', e.action === 'read' ? 'Read' : 'Edit');
        } else {
          const name = TOOL_LABEL[e.action] || e.tool;
          actor.tools = actor.tools || {};
          actor.tools[name] = (actor.tools[name] || 0) + 1;
          actor.doing = name + (e.detail && e.action !== 'mcp' && e.action !== 'other' ? ': ' + e.detail : '');
          actor.doingHeat = hot;
          // task-list bookkeeping is counted, not listed: the Plan view shows it properly
          if (e.action === 'tasks') noteCat(actor, name);
          else {
            const nice = NICE[e.tool] || e.tool || '';
            const target = e.action === 'other' && e.detail && e.detail !== e.tool ? nice + ': ' + e.detail : (e.action === 'other' ? nice : e.action === 'run' ? tidyCmd(e.detail) : e.detail || e.tool || '');
            addFeed(e, actor, who, VERB[e.action] || 'used', target, null, '', name, e.cmd);
          }
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
    const f = node('f:' + e.abs, 'file', basename(tidyFile(e.file)), actor);
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
  const answerBar = document.createElement('div'); answerBar.id = 'answerBar'; answerBar.hidden = true;
  answerBar.title = 'Click to show the whole answer, or to shrink it again';
  const answerHead = document.createElement('div'); answerHead.className = 'ah';
  const answerLabel = document.createElement('b'); answerLabel.textContent = "Claude's answer";
  const answerWhich = document.createElement('span'); answerWhich.className = 'which';
  answerHead.append(answerLabel, answerWhich);
  const answerText = document.createElement('div'); answerText.className = 'txt';
  answerBar.append(answerHead, answerText);
  stage.append(answerBar);
  let answerTurn = null;   // the request whose answer the banner shows

  function placeAnswer() {
    const show = !!answerTurn && !flowEl.hidden && opts.answer !== false;
    answerBar.hidden = !show;
    flowEl.style.top = show ? answerBar.offsetHeight + 'px' : '';
  }

  function showAnswer(T) {
    answerTurn = T && T.answer ? T : null;
    if (answerTurn) {
      answerText.textContent = clean(answerTurn.answer);   // plain text: no markdown marks
      answerWhich.textContent = answerTurn.title ? 'to: ' + answerTurn.title : '';
    }
    placeAnswer();
  }
  answerBar.addEventListener('click', () => { answerBar.classList.toggle('open'); placeAnswer(); });
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
    showAnswer(null);
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
    // the card's own caption: with two cards open, or two sessions, the chart alone does not say whose it is
    const cap = document.createElement('div'); cap.className = 'turnCap';
    const capQ = document.createElement('span'); capQ.className = 'capQ'; capQ.textContent = prompt || 'Session in progress';
    const capMeta = document.createElement('span'); capMeta.className = 'capMeta';
    cap.append(capQ, capMeta);
    cap.title = prompt || '';
    el.append(cap, body);
    flowGrid.append(el);
    promptsEl.prepend(head);
    requestsEl.hidden = false;
    const T = { el, head, meta, capMeta, session: sessionId, svg, grid, body, answer: '', title: prompt || '', lanes: [], seq: 0, actions: 0, agents: 0, dirty: true, t0: 0, t1: 0 };
    head.addEventListener('click', () => {
      const folded = el.classList.toggle('folded');
      if (T.answer) showAnswer(T);   // the banner follows the request you clicked
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
    const quiet = !T.actions && !T.agents;   // Claude only answered; nothing to draw
    T.el.classList.toggle('quiet', quiet); T.head.classList.toggle('quiet', quiet);
    T.meta.textContent = '';
    const parts = [quiet ? 'reply only' : T.actions + (T.actions === 1 ? ' action' : ' actions'),
      T.agents ? T.agents + (T.agents === 1 ? ' sub-agent' : ' sub-agents') : '', took];
    for (const p of parts) { if (!p) continue; const c = document.createElement('span'); c.textContent = p; T.meta.append(c); }
    T.capMeta.textContent = [sessionTag(T.session)].concat(parts).filter(Boolean).join(' · ');
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
    if (L && L.turn === T) return L;
    // first box for this agent in this turn: a new column with a header. The column it had in an
    // earlier turn stays as it was, so that turn can still be laid out again.
    if (L) { setCurrent(L, null); clearWait(L); }
    L = { cur: null, waitBox: null }; lanes.set(actor.id, L);
    const started = actor.spawnKey ? actions.get(actor.spawnKey) : null;
    L.turn = T;
    L.actor = actor;
    L.t0 = 0; L.t1 = 0; L.status = null;
    L.from = started && started.b.turn === T ? started.b : null;
    L.boxes = [];
    T.lanes.push(L);
    const head = flowBox(L, 'head link ' + actor.kind + (actor.model ? ' m-' + modelFamily(actor.model) : ''), actor.kind === 'main' ? 'Claude' : actor.label, actor.info || (actor.kind === 'main' ? 'main agent' + (sessionTag(sessionId) ? ' · ' + sessionTag(sessionId) : '') : 'sub-agent'));
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
    const b = { el, k, kind, n, dur, t, sub, list, row: 0, seq: ++T.seq, turn: T, lane: L, items: [], expanded: false, gk: null, wait: false };
    L.boxes.push(b);
    T.dirty = true;
    queueLines();
    return b;
  }

  // Compact: each column packs its own boxes. Aligned: every box takes the row of its position in
  // time, so boxes side by side really did happen in that order.
  // The chart reads from top to bottom in time. Claude's own steps are wide boxes across the whole
  // chart. When Claude starts agents, each gets a column under a small "Start agent" box, the agents
  // run side by side, and their columns join again in Claude's next wide box.
  function layout(T) {
    T.dirty = false;
    const COL = 260, GAP = 56;
    const setRow = (b, row) => { if (b.row !== row) { b.row = row; b.el.style.gridRow = String(row); } };
    const main = T.lanes.find((L) => L.actor.kind === 'main');
    const agents = T.lanes.filter((L) => L !== main);
    for (const L of agents) { L.join = null; L.wave = null; }
    const waves = [];
    let row = 0, wave = null, columns = 1;

    // put a wave's agents side by side under its Start agent boxes; returns the last row used
    const closeWave = (W) => {
      const lanes = [];
      for (const fb of W.forks) { const L = agents.find((x) => x.from === fb); fb.slot = lanes.length; lanes.push(L || null); }
      for (const L of agents) if (L.wave === W && !lanes.includes(L)) lanes.push(L);   // agents with no Start box of their own
      W.lanes = lanes.filter(Boolean);
      columns = Math.max(columns, lanes.length);
      let end = W.row;
      lanes.forEach((L, slot) => { if (L) L.slot = slot; });
      if (ui.align) {
        // rows follow the order things happened across all the wave's agents
        const all = [];
        for (const L of W.lanes) for (const b of L.boxes) all.push(b);
        all.sort((a, b) => a.seq - b.seq).forEach((b, i) => { setRow(b, W.row + 1 + i); end = W.row + 1 + i; });
      } else {
        for (const L of W.lanes) { let r = W.row; for (const b of L.boxes) setRow(b, ++r); end = Math.max(end, r); }
      }
      return end;
    };

    const mainBoxes = main ? main.boxes : [];
    // an agent whose Start box is not in Claude's column belongs to the wave running when it began
    const waveOf = new Map();
    {
      let W = null, inWave = false;
      for (const b of mainBoxes) {
        if (b.spawn) { if (!inWave) { W = { forks: [], row: 0, lanes: [] }; waves.push(W); inWave = true; } W.forks.push(b); waveOf.set(b, W); }
        else inWave = false;
      }
      for (const L of agents) {
        if (L.from && waveOf.has(L.from)) { L.wave = waveOf.get(L.from); continue; }
        const first = L.boxes[0] ? L.boxes[0].seq : 0;
        let best = null;
        for (const X of waves) if (X.forks.length && X.forks[0].seq <= first) best = X;   // the "loose" wave has no Start box
        if (!best) { if (!waves.length || waves[0].forks.length) waves.unshift({ forks: [], row: 0, lanes: [] }); best = waves[0]; }
        L.wave = best;
      }
    }

    const wide = [];
    const loose = waves.length && !waves[0].forks.length ? waves[0] : null;   // agents seen before any Start box
    for (const b of mainBoxes) {
      if (b.spawn) {
        const W = waveOf.get(b);
        if (wave !== W) { if (wave) row = closeWave(wave); wave = W; W.row = ++row; }
        b.fork = true; setRow(b, W.row);
      } else {
        if (wave) {
          row = closeWave(wave);
          for (const L of wave.lanes) L.join = b;
          wave = null;
        }
        b.fork = false; setRow(b, ++row); wide.push(b);
        if (loose && b === mainBoxes[0]) { loose.row = row; row = closeWave(loose); }
      }
    }
    if (wave) closeWave(wave);
    if (!main && loose) { loose.row = 0; closeWave(loose); }

    // with three or more columns Claude's own boxes span them all, so every column's arrow meets a box
    T.grid.classList.toggle('many', columns > 2);
    T.grid.style.gridTemplateColumns = 'repeat(' + columns + ', ' + COL + 'px)';
    T.natural = columns * COL + (columns - 1) * GAP;
    T.grid.style.width = Math.max(flowEl.clientWidth - 68, T.natural) + 'px';
    T.grid.style.justifyContent = 'center';
    T.fitPending = true;
    for (const b of wide) { b.el.style.gridColumn = '1 / -1'; b.el.classList.remove('fork'); }
    for (const W of waves) {
      // a wave with fewer agents than the chart has columns sits in the middle
      const n = Math.max(W.forks.length, W.lanes.reduce((m, L) => Math.max(m, L.slot + 1), 0));
      const off = Math.floor((columns - n) / 2);
      for (const fb of W.forks) { fb.el.style.gridColumn = String(off + fb.slot + 1); fb.el.classList.add('fork'); }
      for (const L of W.lanes) for (const b of L.boxes) b.el.style.gridColumn = String(off + L.slot + 1);
    }
  }

  // Fit to width: a request's chart is shrunk until its full width fits the space its card leaves for it,
  // never enlarged. Height is left alone, so a long chart scrolls down at a readable size. The chart and its
  // arrows are scaled together, so the arrows keep their proportions.
  function fitTurn(T) {
    T.fitPending = false;
    const g = T.grid.style, v = T.svg.style;
    g.width = T.natural + 'px';
    const H = T.grid.scrollHeight || 1;
    // The room the panel leaves for the chart. It is measured from the scrolling view, not from the
    // card: the card grows with its chart, so measuring the card never let the chart shrink.
    const px = (el) => { const c = getComputedStyle(el); return parseFloat(c.paddingLeft) + parseFloat(c.paddingRight) + parseFloat(c.borderLeftWidth) + parseFloat(c.borderRightWidth); };
    const availW = Math.max(120, flowEl.clientWidth - px(flowGrid.parentElement) - px(T.el) - px(T.body));
    // Below this scale the text is too small to read: the chart then keeps this size, starts at the
    // left edge and scrolls sideways.
    const k = Math.max(0.6, Math.min(1, availW / T.natural));
    const dx = Math.max(0, (availW - T.natural * k) / 2);
    const tf = 'translateX(' + dx.toFixed(1) + 'px) scale(' + k.toFixed(4) + ')';
    g.transformOrigin = '0 0'; g.transform = tf;
    // a scaled box still takes its full size in the page, so give the spare room back
    g.marginBottom = (-(H * (1 - k))).toFixed(1) + 'px';
    g.marginRight = (-(T.natural * (1 - k)) + dx).toFixed(1) + 'px';
    v.transformOrigin = '0 0'; v.transform = tf;
  }

  // Claude's own column ends in one status box. While nothing else happens in the column it is
  // retitled in place (waiting for agents, an agent reported back, finished) instead of adding a box each time.
  function agentsRunning(sessionId) {
    let n = pending.filter((p) => p.session === sessionId).length;
    for (const x of nodes.values()) if (x.kind === 'agent' && x.status === 'running' && x.id.startsWith('a:' + sessionId + ':')) n++;
    return n;
  }

  function statusBox(L, kind, text, cls) {
    let b = L.status && L.boxes[L.boxes.length - 1] === L.status ? L.status : null;
    if (!b) { b = flowBox(L, 'term', kind, text); L.status = b; }
    b.kind = kind; b.k.textContent = kind; b.t.textContent = text || '';
    for (const c of ['note', 'gather']) b.el.classList.toggle(c, c === cls);
    b.el.title = kind + (text ? '\n' + text : '');
    b.turn.dirty = true; queueLines();
    return b;
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
      b = flowBox(L, 'act k-' + e.action, KIND[e.action] || NICE[e.tool] || e.tool || 'Tool', '');
      b.gk = gk;
      b.spawn = e.action === 'spawn';
      const box = b;
      b.el.addEventListener('click', (ev) => {
        if (box.items.length > 1) { box.expanded = !box.expanded; lastUserScroll = Date.now(); hideTip(); render(box); }
        else openItem(box.items[0], ev);
      });
      b.el.addEventListener('keydown', (ev) => {
        if (ev.target !== box.el || (ev.key !== 'Enter' && ev.key !== ' ')) return;
        ev.preventDefault(); box.el.click();
      });
      b.el.addEventListener('mouseenter', () => { if (box.items.length === 1) showDiff(box.el, box.items[0]); });
      b.el.addEventListener('mouseleave', hideTip);
    }
    const item = {
      text: e.action === 'spawn' ? (e.subagentType ? e.subagentType + (e.model ? ' · ' + e.model : '') + ': ' : '') + (e.detail || '')
        : e.action === 'other' && e.detail === e.tool && NICE[e.tool] ? '' : (e.file ? tidyFile(e.file) : e.action === 'run' ? tidyCmd(e.detail) : e.detail || ''),
      more: e.cmd || '',
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
    b.t.textContent = last.text; b.t.hidden = open || !last.text;
    const sub = b.wait ? 'Waiting for your approval'
      : n === 1 ? last.sub : open ? '' : 'and ' + (n - 1) + ' more' + (fails ? ', ' + fails + ' failed' : '');
    b.sub.textContent = sub; b.sub.hidden = !sub;
    b.el.classList.toggle('fail', fails > 0);
    b.el.classList.toggle('group', n > 1);
    b.el.classList.toggle('open', open);
    const acts = n > 1 || !!last.file || last.planLink;
    b.el.classList.toggle('link', acts);
    if (acts) { b.el.tabIndex = 0; b.el.setAttribute('role', 'button'); if (n > 1) b.el.setAttribute('aria-expanded', String(open)); else b.el.removeAttribute('aria-expanded'); }
    else { b.el.removeAttribute('tabindex'); b.el.removeAttribute('role'); }
    b.el.title = n > 1 ? (open ? 'Click to collapse' : 'Click to show all ' + n + ':\n' + b.items.map((i) => i.text).join('\n'))
      : last.diff ? '' : b.kind + ' ' + last.text + (last.more ? '\n' + last.more : '') + (last.sub ? '\n' + last.sub : '') + (last.file ? '\nClick to open, Shift+click to show in the graph' : last.planLink ? '\nClick to see the plan as a flowchart' : '');
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
        if (!item.diff) li.title = item.text + (item.more ? '\n' + item.more : '') + (item.sub ? '\n' + item.sub : '');
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
    const s0 = stage.getBoundingClientRect(), r = anchor.getBoundingClientRect();
    // never bigger than the panel: in a narrow side bar the 520px tip used to hang off the edge
    tip.style.maxWidth = Math.max(140, s0.width - 16) + 'px';
    tip.style.maxHeight = Math.max(80, s0.height - 16) + 'px';
    tip.hidden = false;
    let x = r.right - s0.left + 12;
    if (x + tip.offsetWidth > s0.width - 8) x = Math.max(8, r.left - s0.left - tip.offsetWidth - 12);
    const y = Math.max(8, Math.min(r.top - s0.top, s0.height - tip.offsetHeight - 8));
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }

  function hideTip() { tip.hidden = true; tip.className = ''; tip.style.maxWidth = ''; tip.style.maxHeight = ''; }

  function flowApply(e, actor, session, live) {
    let made = null;
    if (replayClock) replayClock = e.t;
    if (isAuto(e) && turnBySession.get(e.session)) {
      const L = flowLane(session, e.session);
      const n = agentsRunning(e.session);
      const reported = /^\s*<agent-message/.test(e.detail || '');
      made = statusBox(L, reported && !n ? 'Agents reported back' : autoLabel(e), n ? n + (n === 1 ? ' agent' : ' agents') + ' still working' : '', 'note');
      setCurrent(L, made);
    } else if (e.ev === 'UserPromptSubmit') {
      const T = newTurn(e.session, isAuto(e) ? autoLabel(e) : promptText(e.detail));
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
      const mainStop = e.ev === 'Stop';
      if (mainStop) {
        const n = agentsRunning(e.session);
        made = n ? statusBox(L, 'Waiting for ' + n + (n === 1 ? ' agent' : ' agents'), '', 'gather') : statusBox(L, 'Finished the turn', '', '');
      } else made = flowBox(L, 'term' + (e.detail ? ' said' : ''), 'Finished', e.detail || '');
      if (mainStop && e.detail) { L.turn.answer = e.detail; showAnswer(L.turn); }
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
    const AL = lanes.get(actor.id);
    if (AL && AL.turn) {
      if (!AL.t0) AL.t0 = e.t;
      if (e.ev === 'SubagentStop') { AL.t1 = e.t; AL.turn.dirty = true; queueLines(); }
    }
    if (made && live && opts.follow !== false && Date.now() - lastUserScroll > 4000 && !flowEl.hidden) {
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
      if (T.fitPending) fitTurn(T);
      T.svg.setAttribute('width', T.grid.scrollWidth);
      T.svg.setAttribute('height', T.grid.scrollHeight);
      T.svg.textContent = '';
      const seqLine = (L, fromEl, c) => {
        const ce = c.el;
        const x = ce.offsetLeft + ce.offsetWidth / 2, y1 = fromEl.offsetTop + fromEl.offsetHeight, y2 = ce.offsetTop;
        if (y2 - y1 < 4) return;
        const on = L.cur === c;
        const colour = on ? getComputedStyle(ce).getPropertyValue('--accent') : '';
        svgPath(T, 'M' + x + ' ' + y1 + ' V' + (y2 - 6), 'seq' + (on ? ' on' : ''), colour);
        svgPath(T, 'M' + x + ' ' + y2 + ' l-4.5 -7 h9 z', 'seqHead' + (on ? ' on' : ''), colour);
      };
      for (const L of T.lanes) {
        const isMain = L.actor.kind === 'main';
        let anchor = L.boxes[0];   // the last wide box in Claude's column
        for (let i = 1; i < L.boxes.length; i++) {
          const p = L.boxes[i - 1], c = L.boxes[i];
          if (isMain && c.fork) { seqLine(L, anchor.el, c); continue; }
          if (isMain) anchor = c;
          if (isMain && p.fork && T.lanes.some((X) => X.join === c)) continue;   // joined from the agents' columns below
          seqLine(L, p.el, c);
        }
        if (L.from && L.boxes.length) {
          const a = L.from.el, b = L.boxes[0].el;
          if (Math.abs(a.offsetLeft - b.offsetLeft) < 6) {
            // same column: straight down from the Start agent box
            const x = b.offsetLeft + b.offsetWidth / 2, y1 = a.offsetTop + a.offsetHeight, y2 = b.offsetTop;
            if (y2 - y1 >= 4) {
              svgPath(T, 'M' + x + ' ' + y1 + ' V' + (y2 - 7), 'spawn');
              svgPath(T, 'M' + x + ' ' + y2 + ' l-4.5 -8 h9 z', 'spawnHead');
            }
          } else {
            const right = b.offsetLeft > a.offsetLeft;
            const dir = right ? 1 : -1;
            const x1 = right ? a.offsetLeft + a.offsetWidth : a.offsetLeft;
            const y1 = a.offsetTop + a.offsetHeight / 2;
            const x2 = right ? b.offsetLeft - 7 : b.offsetLeft + b.offsetWidth + 7;
            const y2 = b.offsetTop + b.offsetHeight / 2;
            svgPath(T, 'M' + x1 + ' ' + y1 + ' h' + (dir * 14) + ' V' + y2 + ' H' + x2, 'spawn');
            svgPath(T, 'M' + x2 + ' ' + y2 + ' l' + (dir * -7) + ' -4.5 v9 z', 'spawnHead');
          }
        }
        if (!isMain && L.join && L.boxes.length) {
          // this agent's column runs into Claude's next wide box
          const last = L.boxes[L.boxes.length - 1].el, j = L.join.el;
          const x = last.offsetLeft + last.offsetWidth / 2, y1 = last.offsetTop + last.offsetHeight, y2 = j.offsetTop;
          if (y2 - y1 >= 4) {
            svgPath(T, 'M' + x + ' ' + y1 + ' V' + (y2 - 6), 'seq');
            svgPath(T, 'M' + x + ' ' + y2 + ' l-4.5 -7 h9 z', 'seqHead');
          }
        }
      }
    }
  }
  flowEl.addEventListener('wheel', () => { lastUserScroll = Date.now(); }, { passive: true });
  flowEl.addEventListener('pointerdown', () => { lastUserScroll = Date.now(); });
  // scrolling with the keyboard also means "I am reading here, do not jump to the newest box"
  flowEl.addEventListener('keydown', () => { lastUserScroll = Date.now(); });

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

  // what the person opened or closed in the Plan view; kept while the board is drawn again
  const planUi = { open: new Set(), phases: new Map(), now: '' };
  let plansQueued = false;
  function queuePlans() {
    if (plansQueued) return;
    plansQueued = true;
    requestAnimationFrame(() => { plansQueued = false; renderPlans(); });
  }

  function planReset() { plans = new Map(); renderPlans(); }

  // a short word on the Refresh button about what the refresh found
  let planNoteTimer = null;
  function planNote(text) {
    clearTimeout(planNoteTimer);
    planUi.note = text;
    renderPlans();
    planNoteTimer = setTimeout(() => { planUi.note = ''; const b = document.getElementById('planRefresh'); if (b) b.textContent = 'Refresh'; }, 2500);
  }

  function clean(text) {
    return text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\x60/g, '').replace(/\*\*|__/g, '').replace(/(^|[\s(])[*_](?=\S)/g, '$1').replace(/([^\s*_])[*_](?=[\s),:;]|\.(?:\s|$)|$)/g, '$1').replace(/^\[[ xX]\]\s*/, '').trim();
  }

  // Turns any plan's markdown into steps grouped by phase. The rules, in order:
  //  1. The first "# heading" is the title. Fenced code, tables and rules are skipped.
  //  2. Every other heading starts a section. Sections named like Context, Summary, Assumptions or
  //     Notes are background: their first paragraph introduces the board, and they hold no steps.
  //  3. If the plan has numbered items, those are the steps; each section holding some is a phase.
  //  4. Otherwise, if it has "Step 1: ..." style headings, each such heading is a step and the
  //     heading above them is the phase.
  //  5. Otherwise the top-level bullets of each section are the steps.
  //  6. Otherwise each heading is a step, and failing that each paragraph.
  //  Nested items become a step's details. Bullets under Verification or Testing are check steps.
  //  A step's status comes from a mark at its start: "[x]" done, "[~]" in progress, "[ ]" or none to do.
  const INFO_HEAD = /^(context|summary|background|goals?|why|overview|motivation|problem|assumptions?|notes?|risks?|out of scope|non-goals?|open questions?|questions?|critical files|files|references?)\b/i;
  const CHECK_HEAD = /\b(verification|verify|testing|tests?|test plan|validation|acceptance|done when|how to test|qa)\b/i;
  const STEP_HEAD = /^(?:(?:step|phase|task|part|stage)\s*)?(\d+)\s*[.:)\-–]\s*(.+)$/i;

  function parsePlan(md) {
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    let title = '';
    let sec = { text: '', items: [], paras: [] };
    const secs = [sec];
    let fence = false, last = null;
    for (const raw of lines) {
      if (/^\s*(\x60{3,}|~{3,})/.test(raw)) { fence = !fence; continue; }
      if (fence) continue;
      const h = raw.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
      if (h) {
        const text = clean(h[2].replace(/\s+#+\s*$/, ''));
        if (h[1].length === 1 && !title) { title = text; continue; }
        sec = { text, items: [], paras: [] }; secs.push(sec); last = null;
        continue;
      }
      if (/^\s*\|/.test(raw) || /^\s*([-*_]\s*){3,}$/.test(raw)) continue;   // tables and horizontal rules
      const li = raw.match(/^(\s*)(\d+[.)]|[-*+])\s+(.*)$/);
      if (li) {
        const box = li[3].match(/^\[([ xX~>\-\/])\]\s*/);
        const body = li[3].replace(/^\[[ xX~>\-\/]\]\s*/, '');
        const mark = box ? box[1] : '';
        last = { indent: li[1].replace(/\t/g, '    ').length, numbered: /\d/.test(li[2]), text: clean(body), raw: body, status: /[xX]/.test(mark) ? 'completed' : mark && mark !== ' ' ? 'in_progress' : 'pending', marked: !!box, details: [] };
        sec.items.push(last);
      } else if (raw.trim()) {
        if (last && /^\s{2,}\S/.test(raw)) { last.text += ' ' + clean(raw); last.raw += ' ' + raw.trim(); }   // a wrapped list line
        else { sec.paras.push(clean(raw)); last = null; }
      }
    }

    const mk = (it, phase, check) => ({ text: it.text, raw: it.raw, phase, details: it.details, status: it.status, marked: it.marked, check: !!check });
    // a section's steps: its shallowest items; anything nested under one becomes that step's details
    const topItems = (S, onlyNumbered) => {
      const cand = onlyNumbered ? S.items.filter((i) => i.numbered) : S.items;
      if (!cand.length) return [];
      const top = Math.min(...cand.map((i) => i.indent));
      const out = [];
      for (const i of S.items) {
        if (i.indent <= top && (!onlyNumbered || i.numbered)) { i.details = []; out.push(i); }
        else if (out.length) out[out.length - 1].details.push(i.text);
      }
      return out;
    };
    const isCheck = (S) => CHECK_HEAD.test(S.text) && !INFO_HEAD.test(S.text);

    let steps = [];
    const numbered = secs.reduce((n, S) => n + S.items.filter((i) => i.numbered).length, 0);
    const stepHeads = secs.filter((S) => STEP_HEAD.test(S.text));
    if (numbered >= 2) {
      for (const S of secs) {
        if (S.items.some((i) => i.numbered)) for (const i of topItems(S, true)) steps.push(mk(i, S.text, isCheck(S)));
        else if (isCheck(S)) for (const i of topItems(S, false)) steps.push(mk(i, S.text, true));
      }
    } else if (stepHeads.length >= 2) {
      let phase = '';
      for (const S of secs) {
        const m = S.text.match(STEP_HEAD);
        if (m) {
          const details = S.items.map((i) => i.text).concat(S.paras).slice(0, 8);
          const hb = m[2].match(/^\[([ xX~>\-\/])\]\s*/);
          const name = hb ? m[2].slice(hb[0].length) : m[2];
          const hs = !hb || hb[1] === ' ' ? 'pending' : /[xX]/.test(hb[1]) ? 'completed' : 'in_progress';
          steps.push({ text: name, title: name, raw: '', phase, details, status: hs, marked: !!hb, kindText: name + ' ' + details.join(' ') });
        } else if (S.text && !INFO_HEAD.test(S.text)) {
          phase = S.text;
          if (isCheck(S)) for (const i of topItems(S, false)) steps.push(mk(i, S.text, true));
        }
      }
    } else {
      const withItems = secs.filter((S) => S.items.length);
      const work = withItems.filter((S) => !INFO_HEAD.test(S.text));
      const use = work.length ? work : withItems;
      if (use.reduce((n, S) => n + S.items.length, 0) >= 2) {
        for (const S of use) for (const i of topItems(S, false)) steps.push(mk(i, S.text, isCheck(S)));
      } else {
        const heads = secs.filter((S) => S.text && !INFO_HEAD.test(S.text));
        if (heads.length >= 2) {
          steps = heads.map((S) => {
            const details = S.paras.concat(S.items.map((i) => i.text)).slice(0, 4);
            return { text: S.text, title: S.text, raw: '', phase: '', details, status: 'pending', kindText: S.text + ' ' + details.join(' '), check: isCheck(S) };
          });
        } else {
          const paras = secs.reduce((a, S) => a.concat(S.paras), []);
          steps = paras.slice(0, 12).map((text) => ({ text, raw: '', phase: '', details: [], status: 'pending' }));
        }
      }
    }
    // the opening paragraph: from a background section, else whatever comes before the first heading
    const lead = secs.find((S) => INFO_HEAD.test(S.text) && S.paras.length) || (secs[0].paras.length && steps.length && steps[0].text !== secs[0].paras[0] ? secs[0] : null);
    return { title: title || 'Proposed plan', steps: steps.slice(0, 60), intro: lead ? lead.paras[0] : '' };
  }

  function planFor(sessionId) {
    let S = plans.get(sessionId);
    if (!S) { S = { plan: null, tasks: [], work: [], n: 0, id: sessionId }; plans.set(sessionId, S); }
    return S;
  }

  function planApply(e, live) {
    if (e.ev === 'UserPromptSubmit' || e.ev === 'Stop') {
      const S = plans.get(e.session);
      if (!S || !S.plan) return;
      if (S.plan.state === 'waiting') { S.plan.state = 'changes'; queuePlans(); }
      // the turn carrying out an approved plan has ended: the step being worked on is finished too
      else if (S.plan.state === 'approved') { S.plan.ended = e.ev === 'Stop' && S.work.length > 0; queuePlans(); }
      return;
    }
    if (e.planUpdate) {
      const S0 = planFor(e.session);
      const old = S0.plan;
      // Claude Code writes the plan file while still in plan mode: that is a draft, not an approval
      S0.plan = parsePlan(e.planUpdate); S0.plan.state = old ? old.state : 'draft'; S0.plan.ended = old ? old.ended : false;
      queuePlans();
      return;
    }
    // Work done after approval, for steps nobody reports on: which files were read and edited, in order.
    if (e.ev === 'PreToolUse' && e.file && (e.action === 'read' || e.action === 'edit' || e.action === 'write')) {
      const S2 = plans.get(e.session);
      if (S2 && S2.plan && S2.plan.state === 'approved') {
        S2.work.push({ f: String(e.file).replace(/\\/g, '/').toLowerCase(), edit: e.action !== 'read', n: ++S2.n });
        if (S2.work.length > 600) S2.work.shift();
        S2.plan.ended = false;
        queuePlans();
      }
    }
    if (e.action !== 'plan' && e.action !== 'tasks') return;
    const S = planFor(e.session);
    if (e.action === 'plan') {
      if (e.ev === 'PreToolUse' || e.ev === 'PermissionRequest') {
        if (e.plan) {
          S.plan = parsePlan(e.plan); S.plan.state = 'waiting';
          // tasks from before this plan belong to earlier work: they must not tick off its steps
          for (const t of S.tasks) t.old = true;
          S.work = [];
        }
        else if (!S.plan) S.plan = { title: 'Proposed plan', steps: [], state: 'waiting' };
        else S.plan.state = 'waiting';
        if (live && opts.autoPlan && e.ev === 'PreToolUse') { ui.view = 'plan'; applyUi(); }
      } else if (e.ev === 'PostToolUse' && S.plan) { S.plan.state = 'approved'; S.plan.ended = false; S.work = []; }
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
    queuePlans();
  }

  // What kind of action a step is, from its wording. The colour of its card follows.
  const PLAN_KINDS = {
    read: ['Read', 'Look at code or data'],
    edit: ['Change', 'Add or change code'],
    run: ['Run / test', 'Run something and check the result'],
    setup: ['Set up', 'Copy, install, back up or build'],
    decide: ['Decide', 'A choice, or a step that depends on a result'],
  };
  const PLAN_WORDS = {
    run: /\b(run|re-run|rerun|test|tests|unit tests?|verify|check|back-test|backtest|replay|measure|confirm that|validate|ensure|lint|benchmark|profile|reproduce|smoke|execute|try)\b/gi,
    edit: /\b(add|change|edit|implement|fix|update|write|create|record|remove|refactor|rename|append|keep|extend|replace|treat|fit|introduce|wire|move|extract|delete|drop|expose|handle|support|modify|convert|split|make|wrap|store|emit|render|parse|document|define|adapt|rewrite|simplify)\b/gi,
    read: /\b(read|review|inspect|explore|look|compare|analy[sz]e|report|find|list|understand|investigate|audit|trace|identify|locate|map|survey|study|research|gather|collect)\b/gi,
    setup: /\b(install|copy|back ?up|deploy|build|package|configure|set up|setup|migrate|push|commit|merge|scaffold|init|initiali[sz]e|bootstrap|upgrade|bump|release|publish|tag|enable|register|provision|clone|download|restore|roll ?back|open a pr)\b/gi,
    decide: /\b(if|decide|choose|adjust|ask|otherwise|depending|agree|pick|whether|evaluate|consider|discuss)\b/gi,
  };
  function stepKind(text) {
    const t = text.replace(/^[^:]{0,60}:\s*/, (m) => (/\(/.test(m) || m.length < 40 ? '' : m));   // skip a "Title (file):" lead
    const first = (t.match(/^[A-Za-z-]+/) || [''])[0];
    for (const k of Object.keys(PLAN_WORDS)) { PLAN_WORDS[k].lastIndex = 0; const m = PLAN_WORDS[k].exec(first); if (m && m[0].length === first.length) return k; }
    let best = 'edit', top = 0;
    for (const k of ['edit', 'run', 'setup', 'read', 'decide']) {
      const n = (text.match(PLAN_WORDS[k]) || []).length;
      if (n > top) { top = n; best = k; }
    }
    return best;
  }
  // "**Title** (file.js in backticks): what to do" -> title, body and the files it names
  function stepParts(st) {
    const raw = st.raw || st.text;
    const files = [];
    if (st.title) return { title: st.title, body: '', files };
    raw.replace(/\x60([^\x60]{2,60})\x60/g, (m, c) => { if (/[./\\]/.test(c) && !/\s/.test(c) && !files.includes(c)) files.push(c); return m; });
    const m = raw.match(/^\s*\*\*(.+?)\*\*\s*(?:\(([^)]*)\))?\s*[:.]?\s*(.*)$/);
    if (m) return { title: clean(m[1]), body: clean(m[3]), files };
    return { title: '', body: st.text, files };
  }

  // Where a step's status comes from, the same way for every plan:
  //   1. a mark in the plan itself ([x], [~], [ ]) always wins;
  //   2. otherwise the session's task list: a task is matched to a step by its number ("3.", "Step 3")
  //      or, failing that, by sharing most of its words with the step. Several tasks on one step
  //      make it done only when all of them are.
  // Returns one status per step and whether it came from the task list.
  const STOP_WORDS = new Set('the and for with from that this into then when each all any are was will not its their our out over under per via use using new old one two add'.split(' '));
  function stepWords(text) {
    return new Set(String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !STOP_WORDS.has(w)));
  }
  function linkTasks(steps, tasks) {
    const got = steps.map(() => []);
    const words = steps.map((s) => stepWords((s.title || '') + ' ' + s.text));
    for (const t of tasks || []) {
      let at = -1;
      const num = String(t.text).match(/^\s*(?:step\s*)?(\d+)\s*(?:[.:)\-–]|\s)/i);
      if (num && Number(num[1]) >= 1 && Number(num[1]) <= steps.length) at = Number(num[1]) - 1;
      else {
        const tw = stepWords(t.text);
        let best = 0;
        words.forEach((sw, i) => {
          let shared = 0;
          for (const w of tw) if (sw.has(w)) shared++;
          const score = tw.size ? shared / tw.size : 0;
          if (shared >= 2 && score >= 0.6 && score > best) { best = score; at = i; }
        });
      }
      if (at >= 0) got[at].push(t.status);
    }
    return steps.map((s, i) => {
      if (s.marked || !got[i].length) return { status: s.status, fromTasks: false };
      const all = got[i];
      const status = all.every((x) => x === 'completed') ? 'completed' : all.some((x) => x === 'in_progress' || x === 'completed') ? 'in_progress' : 'pending';
      return { status, fromTasks: true };
    });
  }

  // Steps that neither the plan's own marks nor the task list report on are estimated from the work
  // itself: a step that names files is "started" once one of them is worked on after approval, and
  // "likely done" once work has moved on to another step's files or the turn has ended.
  function stepFiles(st) {
    const out = new Set();
    const text = (st.raw || '') + ' ' + (st.text || '') + ' ' + (st.details || []).join(' ');
    for (const m of text.matchAll(/[\w@.\-\/\\]*[\w\-]\.[A-Za-z][A-Za-z0-9]{0,4}\b/g)) {
      const f = m[0].replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
      if (/^(e\.g|i\.e|etc\.[a-z]+)$/.test(f) || /^[\d.]+$/.test(f)) continue;
      out.add(f);
    }
    return [...out];
  }
  function inferSteps(steps, S) {
    if (!S.work.length) return steps.map(() => null);
    const last = steps.map((st) => {
      const files = stepFiles(st);
      if (!files.length) return 0;
      const readStep = stepKind(st.kindText || st.text) === 'read';
      let n = 0;
      for (const w of S.work) {
        if (w.edit === readStep) continue;   // a reading step is followed by reads, any other step by edits
        if (files.some((f) => w.f === f || w.f.endsWith('/' + f))) n = Math.max(n, w.n);
      }
      return n;
    });
    const newest = Math.max(...last);
    return last.map((n) => (!n ? null : { status: n === newest && !S.plan.ended ? 'in_progress' : 'completed', guess: true }));
  }

  // The plan as a board: one column per phase, read left to right; steps are cards, top to bottom,
  // coloured by the kind of action.
  function planChart(title, stateText, stateCls, steps, word, intro, key) {
    const sec = document.createElement('section'); sec.className = 'pchart';
    const head = document.createElement('div'); head.className = 'phead';
    const h = document.createElement('h3'); h.textContent = title;
    const st = document.createElement('span'); st.className = 'pstate ' + stateCls; st.textContent = stateText;
    const count = document.createElement('span'); count.className = 'pcount';
    const done = steps.filter((x) => x.status === 'completed').length;
    const doingN = steps.filter((x) => x.status === 'in_progress').length;
    const unit = word === 'Task' ? ['task', 'tasks'] : ['step', 'steps'];
    count.textContent = [steps.length + ' ' + unit[steps.length === 1 ? 0 : 1], done ? done + ' done' : '', doingN ? doingN + ' in progress' : '',
      steps.length - done - doingN && (done || doingN) ? (steps.length - done - doingN) + ' to do' : ''].filter(Boolean).join(' · ');
    head.append(h, st, count);
    sec.append(head);

    // progress at a glance: done in green, in progress in blue, and what Claude is on now
    if (steps.length) {
      const bar = document.createElement('div'); bar.className = 'pbar'; bar.title = done + ' of ' + steps.length + ' done' + (doingN ? ', ' + doingN + ' in progress' : '');
      bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(steps.length)); bar.setAttribute('aria-valuenow', String(done));
      const a = document.createElement('i'); a.className = 'd'; a.style.width = (done / steps.length * 100).toFixed(1) + '%';
      const b = document.createElement('i'); b.className = 'p'; b.style.width = (doingN / steps.length * 100).toFixed(1) + '%';
      bar.append(a, b);
      sec.append(bar);
    }
    if (intro) { const p = document.createElement('p'); p.className = 'pintro'; p.textContent = intro; p.title = intro; sec.append(p); }

    const kinds = steps.map((x) => {
      const k = stepKind(x.kindText || x.text);
      return x.check && k === 'edit' ? 'run' : k;   // a check is a test unless its wording says otherwise
    });
    const legend = document.createElement('div'); legend.className = 'plegend';
    for (const k of Object.keys(PLAN_KINDS)) {
      if (!kinds.includes(k)) continue;
      const item = document.createElement('span'); item.className = 'k-' + k; item.title = PLAN_KINDS[k][1];
      const dot = document.createElement('i'); item.append(dot, PLAN_KINDS[k][0]);
      legend.append(item);
    }
    sec.append(legend);

    const board = document.createElement('div'); board.className = 'pboard';
    const cols = [];
    const cards = [];
    steps.forEach((s2, i) => {
      const name = s2.phase || (word === 'Task' ? 'Tasks' : 'Steps');
      let col = cols[cols.length - 1];
      if (!col || col.name !== name) {
        const el = document.createElement('div'); el.className = 'pcol';
        const hd = document.createElement('h4');
        const nm = document.createElement('span'); nm.className = 'pname'; nm.textContent = name;
        const cnt = document.createElement('span'); cnt.className = 'pcnt';
        hd.append(nm, cnt);
        el.append(hd);
        board.append(el);
        col = { name, el, hd, cnt, n: 0, done: 0, doing: 0 }; cols.push(col);
      }
      const isDone = s2.status === 'completed', doing = s2.status === 'in_progress';
      col.n++; if (isDone) col.done++; if (doing) col.doing++;
      const parts = stepParts(s2);
      const card = document.createElement('div');
      card.className = 'pcard k-' + kinds[i] + (isDone ? ' done' : doing ? ' doing' : '') + (s2.guess ? ' guess' : '');
      const top = document.createElement('div'); top.className = 'ptop';
      const num = document.createElement('span'); num.className = 'pnum'; num.textContent = String(i + 1);
      const kind = document.createElement('span'); kind.className = 'pkind'; kind.textContent = PLAN_KINDS[kinds[i]][0];
      const stat = document.createElement('span'); stat.className = 'pstat ' + (isDone ? 'done' : doing ? 'doing' : 'todo') + (s2.guess ? ' guess' : '');
      stat.textContent = s2.guess ? (isDone ? 'Likely done' : 'Started') : isDone ? 'Done' : doing ? 'In progress' : 'To do';
      stat.title = s2.guess ? 'Estimated from the files Claude worked on: neither the task list nor a mark in the plan reports on this step'
        : s2.fromTasks ? 'Status taken from the task list' : s2.marked ? 'Status marked in the plan' : 'No status recorded for this step yet';
      top.append(num, kind, stat);
      card.append(top);
      if (parts.title) { const t = document.createElement('div'); t.className = 'ptitle'; t.textContent = parts.title; card.append(t); }
      const body = document.createElement('div'); body.className = 'pbody';
      body.textContent = [parts.body].concat(s2.details || []).filter(Boolean).join('\n');
      if (body.textContent) card.append(body);
      if (parts.files.length) {
        const fl = document.createElement('div'); fl.className = 'pfiles';
        for (const name2 of parts.files.slice(0, 6)) { const c = document.createElement('code'); c.textContent = name2; fl.append(c); }
        card.append(fl);
      }
      const ck = key + ':' + i;
      if (planUi.open.has(ck)) card.classList.add('open');
      card.title = 'Click to show the whole step';
      card.tabIndex = 0; card.setAttribute('role', 'button');
      const toggle = () => { if (card.classList.toggle('open')) planUi.open.add(ck); else planUi.open.delete(ck); };
      card.addEventListener('click', toggle);
      card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
      col.el.append(card);
      cards.push({ card, col, s2, i });
    });
    cols.forEach((c, i) => {
      const allDone = c.n > 0 && c.done === c.n;
      const pk = key + ':p' + i;
      const want = planUi.phases.get(pk);
      // a finished phase folds away by itself; a click on any phase header folds or opens it
      const closed = want ? want === 'closed' : allDone && opts.foldPhases !== false;
      c.cnt.textContent = (cols.length > 1 ? 'phase ' + (i + 1) + ' of ' + cols.length + ' · ' : '') + (allDone ? c.n + (c.n === 1 ? ' ' + unit[0] : ' ' + unit[1]) : c.done ? c.done + '/' + c.n + ' done' : c.n + ' ' + unit[c.n === 1 ? 0 : 1]);
      if (allDone) {
        c.el.classList.add('alldone');
        const badge = document.createElement('span'); badge.className = 'pstat done pdone'; badge.textContent = 'Done';
        c.hd.insertBefore(badge, c.cnt);
      } else if (c.doing) c.el.classList.add('active');
      c.el.classList.toggle('collapsed', closed);
      c.hd.tabIndex = 0; c.hd.setAttribute('role', 'button'); c.hd.setAttribute('aria-expanded', String(!closed));
      c.hd.title = closed ? 'Click to show the ' + unit[1] + ' of this phase' : 'Click to fold this phase away';
      const flip = () => {
        const now = !c.el.classList.contains('collapsed');
        c.el.classList.toggle('collapsed', now);
        planUi.phases.set(pk, now ? 'closed' : 'open');
        c.hd.setAttribute('aria-expanded', String(!now));
        c.hd.title = now ? 'Click to show the ' + unit[1] + ' of this phase' : 'Click to fold this phase away';
      };
      c.hd.addEventListener('click', flip);
      c.hd.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); flip(); } });
    });

    // "Now" / "Next": one line that says where the work is, and takes you to that card
    const cur = cards.find((x) => x.s2.status === 'in_progress') || (done && done < steps.length || stateCls === 'approved' && done < steps.length ? cards.find((x) => x.s2.status !== 'completed') : null);
    if (cur) {
      const live = cur.s2.status === 'in_progress';
      const nowEl = document.createElement('button'); nowEl.type = 'button'; nowEl.className = 'pnow' + (live ? ' live' : '');
      const lab = document.createElement('b'); lab.textContent = live ? 'Now' : 'Next';
      const tx = document.createElement('span'); tx.textContent = (cur.i + 1) + '. ' + (stepParts(cur.s2).title || cur.s2.text);
      nowEl.append(lab, tx);
      nowEl.title = 'Click to go to this ' + unit[0];
      const go = (smooth) => {
        if (cur.col.el.classList.contains('collapsed')) { cur.col.el.classList.remove('collapsed'); cur.col.hd.setAttribute('aria-expanded', 'true'); }
        cur.card.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
        cur.card.classList.remove('flash'); void cur.card.offsetWidth; cur.card.classList.add('flash');
      };
      nowEl.addEventListener('click', () => go(true));
      sec.insertBefore(nowEl, legend);
      sec.now = live ? { id: key + ':' + cur.i, go } : null;
    }
    sec.append(board);
    return sec;
  }

  function renderPlans() {
    const keepScroll = planEl.scrollTop;
    planEl.textContent = '';
    // starting a plan from here: a new Claude Code conversation in plan mode
    const tools = document.createElement('div'); tools.className = 'ptools';
    const nb = document.createElement('button'); nb.type = 'button'; nb.className = 'primary'; nb.id = 'newPlan'; nb.textContent = 'New plan';
    nb.title = 'Open a new Claude Code conversation in plan mode: Claude researches without changing anything, then proposes a plan';
    nb.addEventListener('click', () => vscode.postMessage({ type: 'newPlan' }));
    const hint = document.createElement('span'); hint.className = 'phint';
    hint.textContent = 'Opens a new Claude Code conversation in plan mode. In a running conversation, switch with Shift+Tab or the mode picker.';
    // Refresh: work the plan and the task list out again from everything Claude Code has reported
    const rb = document.createElement('button'); rb.type = 'button'; rb.className = 'seg'; rb.id = 'planRefresh'; rb.textContent = 'Refresh';
    rb.title = 'Load the latest plan file from disk, and work the plan and the task list out again from what Claude Code has reported';
    if (planUi.note) rb.textContent = planUi.note;
    rb.addEventListener('click', () => {
      plans = new Map();
      for (const e of history) if (shown(e)) planApply(e, false);
      planUi.touched = 0; planUi.now = '';
      planNote('Refreshing…');
      vscode.postMessage({ type: 'planRefresh' });   // the extension reads the plan file again and answers
      const again = document.getElementById('planRefresh');
      if (again) again.focus();
    });
    tools.append(nb, rb, hint);
    planEl.append(tools);
    let any = false, now = null;
    for (const S of plans.values()) {
      const tag = sessionTag(S.id);
      if (S.plan) {
        any = true;
        const text = { draft: 'Draft, not proposed yet', waiting: 'Waiting for your approval', approved: 'Approved', changes: 'Not approved yet' }[S.plan.state] || '';
        const linked = linkTasks(S.plan.steps, S.tasks.filter((t) => !t.old));
        const guess = S.plan.state === 'approved' && opts.estimate !== false ? inferSteps(S.plan.steps, S) : [];
        const steps = S.plan.steps.map((st, i) => Object.assign({}, st, st.marked || linked[i].fromTasks || !guess[i] ? linked[i] : guess[i]));
        const el = planChart(S.plan.title + (tag ? ' · ' + tag : ''), text, S.plan.state, steps, 'Step', S.plan.intro, 'p:' + S.id);
        planEl.append(el);
        if (el.now) now = el.now;
      }
      if (S.tasks.length) {
        any = true;
        const done = S.tasks.filter((t) => t.status === 'completed').length;
        const el = planChart('Task list' + (tag ? ' · ' + tag : ''), done + ' of ' + S.tasks.length + ' done', done === S.tasks.length ? 'approved' : '', S.tasks, 'Task', '', 't:' + S.id);
        planEl.append(el);
        if (el.now && !now) now = el.now;
      }
    }
    $('viewPlan').classList.toggle('has', any);
    tools.classList.toggle('lone', !any);
    if (!any) {
      const p = document.createElement('p'); p.className = 'pempty';
      p.textContent = 'No plan yet. When Claude Code proposes a plan (plan mode) or makes a task list, it appears here as a board, and steps are marked off as they get done.';
      planEl.append(p);
    }
    planEl.scrollTop = keepScroll;
    // follow the work: when Claude moves to another step, bring its card into view
    const id = now ? now.id : '';
    if (id && id !== planUi.now && !planEl.hidden && opts.follow !== false && Date.now() - planUi.touched > 4000) now.go(false);
    planUi.now = id;
  }
  planUi.touched = 0;
  planEl.addEventListener('wheel', () => { planUi.touched = Date.now(); }, { passive: true });
  planEl.addEventListener('pointerdown', () => { planUi.touched = Date.now(); });
  planEl.addEventListener('keydown', () => { planUi.touched = Date.now(); });

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
    const name = document.createElement('span'); name.className = 'name'; name.textContent = actor.kind === 'main' ? 'Claude' + (sessionTag(actor.session) ? ' · ' + sessionTag(actor.session) : '') : actor.label;
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

  function addFeed(e, actor, who, what, target, open, cls, cat, more) {
    const li = row(e, who, what, target, open, cls, true);
    if (more) li.title += '\n' + more;
    feed.prepend(li);
    while (feed.children.length > 250) feed.lastChild.remove();

    const g = group(actor);
    const li2 = row(e, who, what, target, open, cls, who === 'You');
    if (more) li2.title += '\n' + more;
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
    if (!nodes.size || width < 2 || height < 2) return;   // hidden or collapsed: a zero scale would break the maths
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes.values()) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y);
    }
    const k = Math.max(0.2, Math.min(1.5, Math.min(width / (x1 - x0 + 170), height / (y1 - y0 + 150))));
    const tx = width / 2 - ((x0 + x1) / 2) * k, ty = height / 2 - ((y0 + y1) / 2) * k;
    const s = immediate ? 1 : 0.12;
    view.k += (k - view.k) * s; view.x += (tx - view.x) * s; view.y += (ty - view.y) * s;
  }

  // ---------- drawing ----------
  function color(n) {
    if (n.kind === 'main') return theme.main;
    if (n.kind === 'agent') return (n.model && theme['m-' + modelFamily(n.model)]) || theme.agent;
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
    // nothing to draw while another view is showing; applyUi() starts the loop again
    if (canvas.hidden) { running = false; return; }
    if ((window.devicePixelRatio || 1) !== lastDpr) resize();   // moved to a display with another scale
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

  let lastDpr = 0;
  function resize() {
    const dpr = lastDpr = window.devicePixelRatio || 1;
    width = stage.clientWidth; height = stage.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    if (autoFit) fit(true);
    kick();
  }

  // ---------- header and empty state ----------
  function refreshChrome() {
    let agents = 0, mains = 0, files = 0, edited = 0;
    for (const n of nodes.values()) {
      if (n.kind === 'agent' && n.status === 'running') agents++;
      if (n.kind === 'main' && n.status === 'running') mains++;
      if (n.kind === 'file') { files++; if (n.edited) edited++; }
    }
    const st = $('status');
    let waitingNow = false;
    for (const L of lanes.values()) if (L.waitBox) waitingNow = true;
    st.className = 'status' + (waitingNow ? ' wait' : state.connected ? ' on' : '');
    st.textContent = waitingNow ? 'Waiting for your approval' : state.connected ? 'Connected' : 'Not connected';
    st.title = state.port ? 'Listening on 127.0.0.1:' + state.port : '';
    $('counts').textContent = nodes.size
      ? (waitingNow ? 'Answer in Claude Code to let it continue' : mains || agents ? 'Claude is working' + (agents ? ' with ' + agents + (agents === 1 ? ' sub-agent' : ' sub-agents') : '') : 'Claude is idle') +
        ' · ' + files + (files === 1 ? ' file' : ' files') + ' touched, ' + edited + ' edited'
      : '';
    for (const g of groups.values()) {
      const st = g.actor.status === 'running' ? 'working' : g.actor.status === 'done' ? 'finished' : 'idle';
      g.state.textContent = st;
      g.el.classList.toggle('working', st === 'working');
      g.el.classList.toggle('finished', st === 'finished');
    }
    $('connect').hidden = state.connected || !nodes.size;   // on an empty chart the button is in the middle of it
    $('emptyConnect').hidden = state.connected || !state.hasFolder;
    $('menuNote').textContent = state.extVersion ? 'Version ' + state.extVersion + (state.port ? ' · listening on port ' + state.port : '') : '';
    if (state.extVersion) {
      $('update').title = 'Installed: v' + state.extVersion + ' on VS Code ' + state.vscodeVersion +
        '. Installs a newer .vsix of this extension that you pick.';
    }
    $('empty').hidden = nodes.size > 0 || ui.view === 'plan';
    $('replay').disabled = !history.length;
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
      tip.className = ''; tip.textContent = tipText(n);
      tip.style.maxWidth = Math.max(140, width - 8) + 'px'; tip.style.maxHeight = '';
      tip.hidden = false;
      // keep the whole tip inside the panel: beside the pointer, or above it near the bottom edge
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      const top = p.sy + 16 + th > height - 4 ? Math.max(4, p.sy - th - 10) : p.sy + 16;
      tip.style.left = Math.max(4, Math.min(p.sx + 14, width - tw - 4)) + 'px'; tip.style.top = top + 'px';
    } else hideTip();
  });
  // a drag that the system interrupts (focus lost, pointer taken away) must end too
  const dropDrag = () => { drag = null; canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointercancel', dropDrag);
  canvas.addEventListener('lostpointercapture', dropDrag);
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

  // a panel opened for the first time starts the way the settings say; after that it keeps what you chose in it
  let uiFresh = !(vscode.getState && vscode.getState());
  const ui = Object.assign({ mode: 'agent', view: 'flow', align: false }, (vscode.getState && vscode.getState()) || {});
  function applyUi() {
    hideTip();   // a tip left over from the view being switched away from
    const byAgent = ui.mode !== 'time';
    groupsEl.hidden = !byAgent; feed.hidden = byAgent;
    $('modeAgent').classList.toggle('on', byAgent); $('modeTime').classList.toggle('on', !byAgent);
    const flowView = ui.view === 'flow', planView = ui.view === 'plan', graphView = !flowView && !planView;
    flowEl.hidden = !flowView; planEl.hidden = !planView; canvas.hidden = !graphView; $('legend').hidden = !graphView;
    $('viewFlow').classList.toggle('on', flowView); $('viewGraph').classList.toggle('on', graphView); $('viewPlan').classList.toggle('on', planView);
    for (const [id, on] of [['viewFlow', flowView], ['viewGraph', graphView], ['viewPlan', planView], ['modeAgent', byAgent], ['modeTime', !byAgent], ['toggleAside', ui.aside !== false]]) $(id).setAttribute('aria-pressed', String(on));
    $('fit').hidden = planView;
    document.body.classList.toggle('noAside', ui.aside === false);
    if ($('toggleAside')) $('toggleAside').classList.toggle('on', ui.aside !== false);
    document.body.dataset.view = flowView ? 'flow' : planView ? 'plan' : 'graph';   // lets the styles differ per view
    placeAnswer();
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
  if ($('toggleAside')) $('toggleAside').addEventListener('click', () => { ui.aside = ui.aside === false; applyUi(); });
  $('align').addEventListener('click', () => { ui.align = !ui.align; applyUi(); });

  // ---------- sessions, rebuild and replay ----------
  let history = [];
  let replayTimer = null;
  let replayList = [];
  let replayPos = 0;
  const sessionPick = $('sessionPick');

  function shown(e) { return !onlySession || e.session === onlySession; }

  function noteSession(e) {
    if (bare(e) && !sessions.has(e.session)) return;
    let label = sessions.get(e.session);
    const fresh = label === undefined;
    if (fresh) label = '';
    if (!label && e.ev === 'UserPromptSubmit' && e.detail && !isAuto(e)) label = e.detail.length > 42 ? e.detail.slice(0, 41) + '…' : e.detail;
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
    tagged = !onlySession && sessions.size > 1;
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
  // Rare actions live in a small menu, so the toolbar keeps to what is used while watching.
  const menu = $('menu'), more = $('more');
  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true; more.classList.remove('on'); more.setAttribute('aria-expanded', 'false');
    if (refocus) more.focus();
  }
  function openMenu() {
    menu.hidden = false; more.classList.add('on'); more.setAttribute('aria-expanded', 'true');
    // under the button, kept inside the panel
    const r = more.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 4) + 'px';
    menu.style.right = Math.max(6, Math.round(document.documentElement.clientWidth - r.right)) + 'px';
    const first = menu.querySelector('button'); if (first) first.focus();
  }
  more.addEventListener('click', (ev) => { ev.stopPropagation(); if (menu.hidden) openMenu(); else closeMenu(true); });
  document.addEventListener('click', (ev) => { if (!menu.contains(ev.target)) closeMenu(false); });
  window.addEventListener('blur', () => closeMenu(false));
  document.addEventListener('keydown', (ev) => {
    if (menu.hidden) return;
    if (ev.key === 'Escape') { closeMenu(true); return; }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const items = [...menu.querySelectorAll('button')];
    const at = items.indexOf(document.activeElement);
    items[(at + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  });
  const send = (id, type) => $(id).addEventListener('click', () => { closeMenu(false); vscode.postMessage({ type }); });
  send('clear', 'clear'); send('update', 'update'); send('settings', 'settings');
  send('connect', 'connect'); send('connect2', 'connect');
  send('demo', 'demo'); send('parallelDemo', 'parallelDemo'); send('usageGuardDemo', 'usageGuardDemo');
  send('demo2', 'demo'); send('parallelDemo2', 'parallelDemo'); send('usageGuardDemo2', 'usageGuardDemo');

  // ---------- Claude usage, from the usage bar ----------
  function tokShort(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n || 0)); }
  function clockAt(ts) { return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : ''; }
  // a limit that resets on another day needs the day: "21:28" alone reads as tonight
  function resetAt(ts) {
    if (!ts) return '';
    const d = new Date(ts), n = new Date();
    if (d.toDateString() === n.toDateString() || ts - n.getTime() < 12 * 3600e3) return clockAt(ts);
    return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + clockAt(ts);
  }
  // "5-hour session" -> "5h", "Weekly (all models)" -> "Week", "Weekly (Fable)" -> "Week · Fable"
  function shortLimit(label) {
    const l = String(label).replace(/^Current /i, '').replace(/ limit$/i, '');
    if (/^(5-hour session|session)$/i.test(l)) return '5h';
    const w = l.match(/^week(?:ly)?\s*\((.+)\)$/i);
    if (w) return /^all models$/i.test(w[1]) ? 'Week' : 'Week · ' + w[1].replace(/ only$/i, '');
    return l;
  }
  function usageChip(parent, text, cls, title) {
    const c = document.createElement('span'); c.className = 'uchip ' + (cls || ''); c.textContent = text; c.title = title || '';
    parent.append(c); return c;
  }
  // a real progress bar: the track is the whole limit, the fill is how much of it is used
  function usageMeter(parent, label, percent, cls, note, title) {
    const p = Math.max(0, Math.min(100, percent));
    const c = document.createElement('span'); c.className = 'uchip umeter ' + (cls || ''); c.title = title || '';
    const name = document.createElement('span'); name.className = 'uname'; name.textContent = label;
    const track = document.createElement('span'); track.className = 'utrack';
    const fill = document.createElement('i'); fill.style.width = p.toFixed(1) + '%';
    track.append(fill);
    const val = document.createElement('span'); val.textContent = Math.round(p) + '%';
    c.append(name, track, val);
    // the reset time is its own element so a narrow panel can leave it to the tooltip
    if (note) { const n = document.createElement('span'); n.className = 'unote'; n.textContent = '· ' + note; c.append(n); }
    parent.append(c); return c;
  }
  let lastUsage = null;
  function renderUsage(u) {
    const el = $('usage');
    lastUsage = u;
    el.textContent = '';
    if (!u || opts.usage === false) { el.hidden = true; return; }
    el.hidden = false;
    const tip = [];
    const level = (p) => (p >= u.errorAt ? ' err' : p >= u.warnAt ? ' warn' : '');
    if (u.live && u.buckets.length) {
      for (const b of u.buckets) {
        const p = Math.max(0, Math.min(100, b.percent));
        usageMeter(el, shortLimit(b.label), p, level(p).trim(), b.resetsAt ? 'resets ' + resetAt(b.resetsAt) : '', b.label + ': ' + Math.round(p) + '% used' + (b.resetsAt ? ', resets ' + resetAt(b.resetsAt) : ''));
        tip.push(b.label + ': ' + Math.round(p) + '%' + (b.resetsAt ? ', resets ' + resetAt(b.resetsAt) : ''));
      }
    } else if (u.block) {
      const bl = u.block;
      if (u.budget > 0) {
        const p = (bl.work / u.budget) * 100;
        usageMeter(el, '5h', p, level(p).trim(), 'ends ' + clockAt(bl.end) + ' (estimate)', '5-hour block, against your token budget');
      } else {
        usageChip(el, '5h ' + tokShort(bl.work) + ' tokens · ends ' + clockAt(bl.end) + ' (estimate)', '', '5-hour block');
      }
      tip.push('5-hour block: ' + tokShort(bl.work) + ' tokens in ' + bl.messages + ' replies');
    }
    // with real limits on show, the local token count is detail: it stays in the tooltip
    if (!(u.live && u.buckets.length)) usageChip(el, '7d ' + tokShort(u.week.work) + ' tokens', '', 'Last 7 days, this computer');
    if (u.stale) usageChip(el, 'not updating', 'warn', u.error || 'The last request for the plan limits failed; these are the last good numbers');
    tip.push('Last 7 days: ' + tokShort(u.week.work) + ' tokens in ' + u.week.messages + ' replies');
    if (u.error) tip.push('Plan limits: ' + u.error);
    el.title = tip.join('\n') + '\nClick to refresh';
  }
  $('usage').addEventListener('click', () => vscode.postMessage({ type: 'usageRefresh' }));
  $('usage').setAttribute('role', 'button'); $('usage').tabIndex = 0; $('usage').setAttribute('aria-label', 'Claude usage. Activate to refresh.');
  $('usage').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); vscode.postMessage({ type: 'usageRefresh' }); } });

  // ---------- messages from the extension ----------
  window.addEventListener('message', (m) => {
    const msg = m.data;
    if (!msg) return;
    if (msg.type === 'usage') { renderUsage(msg.usage); return; }
    if (msg.type === 'planRefreshed') {
      planNote(msg.sent ? 'Plan file reloaded' : msg.missing && msg.missing === msg.plans ? 'No plan file found' : 'Up to date');
      return;
    }
    if (msg.type === 'init') {
      const evs = msg.events || [];
      const n = history.length;
      // The extension sends the whole history again each time the panel is shown. When it is what
      // is already drawn (plus, at most, newer events), keep the chart as it is: rebuilding lost
      // the session filter, the scroll position, opened boxes and the graph's layout.
      if (n && evs.length >= n && evs[0].id === history[0].id && evs[n - 1].id === history[n - 1].id) {
        for (const e of evs.slice(n)) {
          history.push(e);
          noteSession(e);
          if (shown(e)) { if (replayTimer) replayList.push(e); else apply(e, true); }
        }
        if (!replayTimer && tagged !== (!onlySession && sessions.size > 1)) rebuild();
      } else {
        const keep = onlySession;
        history = evs.slice();
        sessions = new Map(); onlySession = '';
        for (const e of history) noteSession(e);
        if (keep && sessions.has(keep)) onlySession = keep;   // the session being looked at is still there
        fillPicker();
        rebuild();
      }
    } else if (msg.type === 'event') {
      history.push(msg.event);
      noteSession(msg.event);
      if (!replayTimer && tagged !== (!onlySession && sessions.size > 1)) rebuild();   // labels gain or lose their session tag
      else if (shown(msg.event)) {
        if (replayTimer) replayList.push(msg.event); // played when its turn comes
        else apply(msg.event, true);
      }
    } else if (msg.type === 'state') {
      const o = Object.assign({}, OPT_DEFAULTS, msg.opts || {});
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
      if (usageChanged) renderUsage(lastUsage);
    }
    refreshChrome();
    kick();
  });

  new MutationObserver(() => { readTheme(); kick(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new ResizeObserver(placeAnswer).observe(answerBar);
  new ResizeObserver(() => { resize(); for (const T of turns) T.dirty = true; queueLines(); }).observe(stage);
  readTheme();
  applyUi();
  resize();
  refreshChrome();
  vscode.postMessage({ type: 'ready' });
})();
