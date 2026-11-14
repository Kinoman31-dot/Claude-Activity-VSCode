'use strict';
// node shot.js <ext|ext-orig> [filter]   -> out/<ext>/<name>.png + out/<ext>/report.txt
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ext = process.argv[2] || 'ext';
const filter = process.argv[3] || '';
const outDir = path.join(__dirname, 'out', ext);
fs.mkdirSync(outDir, { recursive: true });
const page = 'file:///' + path.join(__dirname, 'page-' + ext + '.html').replace(/\\/g, '/');
const profile = path.join(__dirname, 'edge-profile');

// name, width, height, query
const SIZES = { side: [300, 700], sideTall: [380, 1000], narrow: [520, 420], panel: [1280, 300], half: [760, 900], tab: [1100, 760], wide: [1920, 1040] };
const CASES = [];
const add = (name, size, q) => CASES.push({ name: name + '-' + size, size: SIZES[size], q });
for (const size of Object.keys(SIZES)) {
  add('demo-flow', size, 's=demo');
  add('stress-flow', size, 's=stress');
}
for (const size of ['side', 'narrow', 'panel', 'half', 'tab', 'wide']) {
  add('empty', size, 's=empty&connected=0');
  add('parallel-align', size, 's=parallel&click=align');
  add('demo-graph', size, 's=demo&click=viewGraph');
  add('demo-plan', size, 's=demo&click=viewPlan');
}
for (const size of ['side', 'half', 'tab']) {
  add('guard-flow', size, 's=guard');
  add('stress-graph', size, 's=stress&click=viewGraph');
  add('demo-timeline', size, 's=demo&click=modeTime');
  add('demo-noaside', size, 's=demo&click=toggleAside');
  add('multi-flow', size, 's=multi');
  add('demo-light', size, 's=demo&theme=light');
  add('demo-tip', size, 's=demo&hover=' + encodeURIComponent('#flowGrid .node, #flowGrid [class*=box], #flowGrid > * > *'));
}
for (const size of ['side', 'tab']) { add('menu-open', size, 's=demo&click=more'); add('stress-noaside', size, 's=stress&click=toggleAside'); }
add('guard-open', 'tab', 's=guard&click=' + encodeURIComponent('#prompts .turnHead:last-child'));
for (const size of ['side', 'tab']) { add('planrun', size, 's=planrun&click=viewPlan'); add('plantasks', size, 's=plantasks&click=viewPlan'); }
add('plan-refresh', 'tab', 's=plantasks&click=viewPlan,planRefresh');
add('plan-empty', 'tab', 's=empty&click=viewPlan');
// the chart with the settings changed: compact, no usage strip, no answer banner, no timings, timeline list
const custom = encodeURIComponent(JSON.stringify({ density: 'compact', usage: false, answer: false, timings: false, mode: 'time' }));
for (const size of ['side', 'tab']) add('custom-flow', size, 's=parallel&opts=' + custom);
add('custom-startplan', 'tab', 's=plantasks&opts=' + encodeURIComponent(JSON.stringify({ defaultView: 'plan', aside: false, foldPhases: false, density: 'compact' })));
add('custom-menu', 'tab', 's=demo&click=more');
add('reinit-multi', 'tab', 's=multi&pick=1&reinit=1');
add('stress-light', 'tab', 's=stress&theme=light');
add('guard-light', 'half', 's=guard&theme=light&usage=block');

const report = [];
for (const c of CASES) {
  if (filter && !c.name.includes(filter)) continue;
  // sizes are the panel's own size: it sits in an exact-size iframe inside a window big enough for it
  const [w, h] = c.size;
  const url = page.replace(/page-[^/]+$/, 'frame.html') + `?w=${w}&h=${h}&src=page-${ext}.html&` + c.q;
  const common = ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + profile, '--force-device-scale-factor=1', `--window-size=${Math.max(w, 500) + 24},${h + 92}`, '--virtual-time-budget=9000'];
  spawnSync(EDGE, [...common, '--screenshot=' + path.join(outDir, c.name + '.png'), url], { timeout: 60000 });
  const dom = spawnSync(EDGE, [...common, '--dump-dom', url], { timeout: 60000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
  const rep = /<pre id="__report"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  const err = /<pre id="__error"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  const text = (rep ? rep[1] : 'NO-REPORT') + (err ? '\n' + err[1] : '');
  report.push('== ' + c.name + ' (' + c.q + ')\n' + text.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
}
fs.writeFileSync(path.join(outDir, 'report' + (filter ? '-' + filter : '') + '.txt'), report.join('\n\n') + '\n');
console.log(report.length + ' cases -> ' + outDir);
