'use strict';
// node sum.js <ext> [report file suffix]  -> flags grouped across cases
const fs = require('fs');
const path = require('path');
const ext = process.argv[2] || 'ext';
const text = fs.readFileSync(path.join(__dirname, 'out', ext, 'report' + (process.argv[3] ? '-' + process.argv[3] : '') + '.txt'), 'utf8');
const groups = new Map();
let cases = 0;
for (const block of text.split(/\n\n(?=== )/)) {
  const lines = block.split('\n');
  const name = (/^== (\S+)/.exec(lines[0]) || [])[1];
  if (!name) continue;
  cases++;
  for (const l of lines.slice(1)) {
    if (!/^(CUT|CLIPPED-TEXT|OVERLAP|COVERS|TINY|JS-ERROR|NO-REPORT)|PAGE-SCROLLS|header rows ([3-9]|\d\d)/.test(l)) continue;
    const key = l.replace(/\[[^\]]*\]/g, '[]').replace(/viewport \d+x\d+ doc \d+x\d+/, 'viewport').replace(/ x\d+$/, '').replace(/, items \d+/, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  }
}
console.log(cases + ' cases');
for (const [k, names] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(String(names.length).padStart(3) + 'x ' + k + '   e.g. ' + names.slice(0, 5).join(','));
}
