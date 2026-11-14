'use strict';
// Renders the extension outside VS Code and takes screenshots of every view at every panel size.
//   node shots.js            all cases (about 80, a little over a minute)
//   node shots.js plan       only the cases whose name contains "plan"
// Output: harness/out/ext/<case>.png, harness/out/ext/report[-filter].txt, and a summary of
// layout faults (cut-off elements, overlaps, script errors) printed here.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const filter = process.argv[2] || '';
const harness = path.join(__dirname, 'harness');
const ext = path.join(harness, 'ext');

// the harness works on its own copy, named "ext", beside its scripts
fs.rmSync(ext, { recursive: true, force: true });
fs.cpSync(path.join(__dirname, 'extension'), ext, { recursive: true });

const run = (script, args) => {
  const r = spawnSync(process.execPath, [path.join(harness, script), ...args], { cwd: harness, stdio: 'inherit' });
  if (r.status !== 0) { console.error(script + ' failed'); process.exit(r.status || 1); }
};
run('build.js', ['ext']);
run('shot.js', filter ? ['ext', filter] : ['ext']);
run('sum.js', filter ? ['ext', filter] : ['ext']);
console.log('Screenshots: ' + path.join(harness, 'out', 'ext'));
