'use strict';
// Stands in for VS Code: theme class, acquireVsCodeApi, the messages the extension would send,
// then optional clicks, then a layout report written into <pre id="__report">.
//   ?s=demo|parallel|guard|stress|multi|empty  &theme=dark|light  &usage=live|block|none
//   &connected=0  &click=viewGraph,align,...  (ids clicked in order)  &hover=<css selector>
(function () {
  const P = new URLSearchParams(location.search);
  const theme = P.get('theme') || 'dark';
  document.documentElement.classList.add(theme);
  document.body.classList.add('vscode-' + theme);
  let saved;
  const send = (d) => window.dispatchEvent(new MessageEvent('message', { data: d }));
  const now = Date.now();
  const usage = {
    live: { live: true, warnAt: 80, errorAt: 95, week: { work: 48200000, messages: 2130 }, buckets: [
      { label: '5-hour session', percent: 66, resetsAt: now + 2.5 * 3600e3 },
      { label: 'Weekly (all models)', percent: 81, resetsAt: now + 3 * 86400e3 },
      { label: 'Weekly (Fable)', percent: 96, resetsAt: now + 3 * 86400e3 }] },
    block: { live: false, warnAt: 75, errorAt: 90, budget: 0, buckets: [], block: { work: 7300000, messages: 412, end: now + 2 * 3600e3 }, week: { work: 48200000, messages: 2130 } },
  }[P.get('usage') || 'live'];

  window.acquireVsCodeApi = () => ({
    postMessage(m) {
      if (m && m.type === 'ready') setTimeout(boot, 0);
      // the extension's answer to Refresh in the Plan view: the plan file now has one more step
      if (m && m.type === 'planRefresh') setTimeout(() => {
        const evs = window.DATA[P.get('s') || 'demo'] || [];
        const old = evs.find((e) => e.plan);
        if (old) send({ type: 'event', event: { id: 999999, t: Date.now(), ev: 'PlanFile', session: old.session, planUpdate: old.plan + '\n8. A step added to the plan file by hand\n' } });
        send({ type: 'planRefreshed', plans: old ? 1 : 0, sent: old ? 1 : 0, missing: 0 });
      }, 50);
    },
    getState: () => saved,
    setState(s) { saved = s; },
  });

  function boot() {
    send({ type: 'init', events: window.DATA[P.get('s') || 'demo'] || [] });
    send({ type: 'state', port: 51234, connected: P.get('connected') !== '0', hasFolder: true, extVersion: '0.10.9', vscodeVersion: '1.99.0', opts: JSON.parse(P.get('opts') || '{}') });   // &opts={"density":"compact"} stands for the user's settings
    if (usage) send({ type: 'usage', usage });
    const clicks = (P.get('click') || '').split(',').filter(Boolean);
    let at = 300;
    for (const id of clicks) { setTimeout(() => { const el = document.getElementById(id) || document.querySelector(id); if (el) el.click(); }, at); at += 300; }
    const hover = P.get('hover');
    if (hover) setTimeout(() => { const el = document.querySelector(hover); if (el) { const r = el.getBoundingClientRect(); for (const t of ['mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); } }, at);
    // &pick=1 chooses the second entry of the session picker; &reinit=1 then sends the same history
    // again, as the extension does each time the panel is shown
    if (P.get('pick')) setTimeout(() => { const sp = document.getElementById('sessionPick'); sp.selectedIndex = Number(P.get('pick')); sp.dispatchEvent(new Event('change')); }, at += 300);
    if (P.get('reinit')) setTimeout(() => { const f = document.getElementById('flow'); f.scrollTop = 120; window.__before = f.scrollTop; send({ type: 'init', events: window.DATA[P.get('s') || 'demo'] || [] }); }, at += 600);
    setTimeout(report, at + 1200);
  }

  const vis = (el) => { const s = getComputedStyle(el); return !el.hidden && s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','); };
  function scroller(el) { // nearest ancestor that scrolls or clips
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) return p;
    }
    return null;
  }

  function report() {
    const W = innerWidth, H = innerHeight, out = [];
    const de = document.documentElement;
    out.push(`viewport ${W}x${H} doc ${de.scrollWidth}x${de.scrollHeight}` + (de.scrollWidth > W + 1 ? ' PAGE-SCROLLS-X' : '') + (de.scrollHeight > H + 1 ? ' PAGE-SCROLLS-Y' : ''));
    for (const sel of ['header', 'main', '#stage', 'aside', 'footer', '#flow', '#graph', '#plan', '#empty', '#legend', '#tip']) {
      const el = document.querySelector(sel);
      if (el) out.push(`${sel} ${vis(el) ? box(el) : 'hidden'}`);
    }
    const head = document.querySelector('header');
    if (head) {
      const kids = [...head.children].filter(vis);
      const mids = kids.map((k) => { const r = k.getBoundingClientRect(); return r.top + r.height / 2; }).sort((a, b) => a - b);
      let rows = mids.length ? 1 : 0;
      for (let i = 1; i < mids.length; i++) if (mids[i] - mids[i - 1] > 12) rows++;
      out.push('header rows ' + rows + ', items ' + kids.length + ', height ' + Math.round(head.getBoundingClientRect().height));
    }
    // 1. visible elements poking out of the viewport without a scroll container to reach them
    const seen = new Set();
    for (const el of document.querySelectorAll('header *, aside *, footer *, #legend, #legend *, #empty *, #tip, #plan *, main > *')) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const sc = scroller(el);
      const lim = sc ? sc.getBoundingClientRect() : { left: 0, top: 0, right: W, bottom: H };
      // reachable by scrolling (any scrolling ancestor), or cut with an ellipsis on purpose: fine
      let ok = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll)/.test(s.overflowX + s.overflowY) || s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none') { ok = true; break; }
      }
      if (ok || getComputedStyle(el).textOverflow === 'ellipsis') continue;
      if (r.right > Math.min(lim.right, W) + 1.5 || r.left < Math.max(lim.left, 0) - 1.5 || r.bottom > Math.min(lim.bottom, H) + 1.5) {
        const key = name(el);
        if (!seen.has(key)) { seen.add(key); out.push(`CUT ${key} [${box(el)}] in ${sc ? name(sc) + ' [' + box(sc) + ']' : 'viewport'}`); }
      }
    }
    // 2. text that does not fit its own box and is cut without an ellipsis
    const cut = new Map();
    for (const el of document.querySelectorAll('body *')) {
      if (!vis(el) || !el.childNodes.length || el.children.length) continue;
      const s = getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth + 1 && /(hidden|clip)/.test(s.overflowX) && s.textOverflow !== 'ellipsis') {
        const key = name(el); cut.set(key, (cut.get(key) || 0) + 1);
      }
    }
    for (const [k, n] of cut) out.push(`CLIPPED-TEXT ${k} x${n}`);
    // 3. siblings in the header / aside head / footer that overlap each other
    for (const sel of ['header', '.aside-head', 'footer', '#legend']) {
      const p = document.querySelector(sel);
      if (!p || !vis(p)) continue;
      const kids = [...p.children].filter(vis).map((k) => [k, k.getBoundingClientRect()]).filter(([, r]) => r.width > 0);
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i][1], b = kids[j][1];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) out.push(`OVERLAP ${name(kids[i][0])} / ${name(kids[j][0])}`);
      }
    }
    // 4. overlays covering each other
    const pairs = [['#legend', '#tip'], ['#legend', '#empty p'], ['#legend', 'aside'], ['footer', 'main']];
    for (const [x, y] of pairs) {
      const a = document.querySelector(x), b = document.querySelector(y);
      if (!a || !b || !vis(a) || !vis(b)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      if (Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 2 && Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 2) out.push(`COVERS ${x} [${box(a)}] / ${y} [${box(b)}]`);
    }
    // 5. sizes worth knowing
    const sp = document.getElementById('sessionPick');
    out.push(`picker index ${sp.selectedIndex} of ${sp.options.length}, turns shown ${document.querySelectorAll('#flowGrid .turn:not(.folded)').length}/${document.querySelectorAll('#flowGrid .turn').length}, flow scrollTop ${document.querySelector('#flow').scrollTop}` + (window.__before != null ? ` (before re-init ${window.__before})` : ''));
    const flow = document.querySelector('#flow');
    if (flow && vis(flow)) out.push(`flow scroll ${flow.scrollWidth}x${flow.scrollHeight} in ${flow.clientWidth}x${flow.clientHeight}`);
    const cv = document.querySelector('#graph');
    if (cv && vis(cv)) out.push(`canvas attr ${cv.width}x${cv.height} css ${cv.clientWidth}x${cv.clientHeight} dpr ${devicePixelRatio}`);
    const small = [...document.querySelectorAll('button, select')].filter((b) => vis(b) && (b.getBoundingClientRect().height < 18 || b.getBoundingClientRect().width < 18)).map(name);
    if (small.length) out.push('TINY-CONTROLS ' + [...new Set(small)].join(' '));
    const pre = document.createElement('pre');
    pre.id = '__report'; pre.hidden = true; pre.textContent = out.join('\n');
    document.body.append(pre);
    document.title = 'REPORT-READY';
    if (parent !== window) parent.postMessage({ __id: '__report', text: pre.textContent }, '*');
  }
  window.addEventListener('error', (e) => { const p = document.createElement('pre'); p.id = '__error'; p.hidden = true; p.textContent = 'JS-ERROR ' + e.message + ' @' + e.lineno; document.body.append(p); if (parent !== window) parent.postMessage({ __id: '__error', text: p.textContent }, '*'); });
})();
