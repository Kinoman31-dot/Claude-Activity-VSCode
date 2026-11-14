'use strict';
// Copies extension/ over the copy VS Code runs, after a backup of that copy.
//   node install.js           back up, install, and say what changed
//   node install.js --check   only list the files that differ; nothing is written
// The installed copy is in the user's VS Code folder, outside this project. A session without
// access to that folder (for example one started by the usage guard) can run --check at most;
// it then leaves the install to the user.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const checkOnly = process.argv.includes('--check');
const src = path.join(__dirname, 'extension');
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
const dest = path.join(os.homedir(), '.vscode', 'extensions', `${pkg.publisher}.${pkg.name}-${pkg.version}`);

function files(dir, base = dir, out = []) {
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, n.name);
    if (n.isDirectory()) files(f, base, out); else out.push(path.relative(base, f));
  }
  return out;
}
const same = (a, b) => fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));

if (!fs.existsSync(dest)) {
  console.error('Not installed: ' + dest + ' does not exist. Version ' + pkg.version + ' must first be installed in VS Code from a .vsix file.');
  process.exit(1);
}
const changed = files(src).filter((f) => !same(path.join(src, f), path.join(dest, f)));
if (!changed.length) { console.log('Nothing to install: the installed copy is the same as extension/.'); process.exit(0); }
console.log((checkOnly ? 'Differs from the installed copy' : 'Installing') + ':\n  ' + changed.join('\n  '));
if (checkOnly) process.exit(0);

// a broken file must not reach the copy VS Code runs
for (const f of changed.filter((x) => x.endsWith('.js'))) {
  const r = spawnSync(process.execPath, ['--check', path.join(src, f)], { encoding: 'utf8' });
  if (r.status !== 0) { console.error('Syntax error in ' + f + ', nothing installed:\n' + r.stderr); process.exit(1); }
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const backup = path.join(__dirname, 'backups', 'installed-' + stamp);
fs.cpSync(dest, backup, { recursive: true });
for (const f of changed) {
  fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
}
console.log('Installed ' + changed.length + ' file(s) to ' + dest);
console.log('The copy that was there before is in ' + backup);
console.log('In VS Code run "Developer: Reload Window" (reopening the tab only reloads the page, not the extension).');
