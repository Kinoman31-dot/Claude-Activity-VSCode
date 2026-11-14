'use strict';
// Reads Claude Code's own history files (~/.claude/projects/**/*.jsonl) and adds up
// the tokens per message. Pure Node, no VS Code imports, so it can be tested alone.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOUR = 3600e3;
const BLOCK = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;
const CHUNK = 8 * 1024 * 1024;

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

async function walk(dir, out, minMtime) {
  let list;
  try {
    list = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      await walk(p, out, minMtime);
    } else if (d.name.endsWith('.jsonl')) {
      try {
        const st = await fs.promises.stat(p);
        if (st.mtimeMs >= minMtime) out.push({ path: p, size: st.size });
      } catch {
        /* file vanished while scanning */
      }
    }
  }
}

function emptySum() {
  return { work: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, messages: 0, byModel: {} };
}

function add(sum, e) {
  const work = e.input + e.output + e.cacheCreate;
  sum.work += work;
  sum.input += e.input;
  sum.output += e.output;
  sum.cacheCreate += e.cacheCreate;
  sum.cacheRead += e.cacheRead;
  sum.messages += 1;
  sum.byModel[e.model] = (sum.byModel[e.model] || 0) + work;
}

class LocalUsage {
  constructor(root) {
    this.root = root || path.join(configDir(), 'projects');
    this.files = new Map(); // path -> { offset }
    this.entries = new Map(); // message key -> { ts, model, input, output, cacheCreate, cacheRead }
    this.busy = null;
  }

  scan(now = Date.now()) {
    if (!this.busy) {
      this.busy = this._scan(now).finally(() => {
        this.busy = null;
      });
    }
    return this.busy;
  }

  async _scan(now) {
    const found = [];
    await walk(this.root, found, now - WEEK);
    const seen = new Set();
    for (const f of found) {
      seen.add(f.path);
      let st = this.files.get(f.path);
      if (!st || f.size < st.offset) {
        st = { offset: 0 };
        this.files.set(f.path, st);
      }
      if (f.size > st.offset) await this._readNew(f.path, st, f.size);
    }
    for (const p of [...this.files.keys()]) if (!seen.has(p)) this.files.delete(p);
    for (const [k, e] of this.entries) if (e.ts < now - WEEK) this.entries.delete(k);
  }

  async _readNew(file, st, size) {
    let fh;
    try {
      fh = await fs.promises.open(file, 'r');
    } catch {
      return;
    }
    try {
      let pos = st.offset;
      while (pos < size) {
        const len = Math.min(size - pos, CHUNK);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        if (!bytesRead) break;
        const nl = buf.lastIndexOf(0x0a, bytesRead - 1);
        if (nl < 0) {
          // No full line yet: either one is still being written, or a line is bigger than a chunk.
          if (pos + bytesRead >= size) break;
          pos += bytesRead;
          continue;
        }
        this._ingest(buf.toString('utf8', 0, nl + 1));
        pos += nl + 1;
      }
      st.offset = pos;
    } finally {
      await fh.close();
    }
  }

  _ingest(text) {
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const m = j && j.message;
      if (!j || j.type !== 'assistant' || !m || !m.usage) continue;
      const ts = Date.parse(j.timestamp);
      if (!Number.isFinite(ts)) continue;
      const model = m.model || 'unknown';
      if (model === '<synthetic>') continue;
      const u = m.usage;
      // One reply is written to the file once per content block; keep a single copy of each.
      const key = (m.id || j.uuid) + ':' + (j.requestId || '');
      this.entries.set(key, {
        ts,
        model,
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheCreate: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      });
    }
  }

  // The current 5-hour block: starts at the hour of the first message after a 5-hour gap.
  // This is the same rule ccusage uses; Anthropic's own window may differ a little.
  summary(now = Date.now()) {
    const list = [...this.entries.values()].sort((a, b) => a.ts - b.ts);
    let start = null;
    let last = null;
    let block = null;
    for (const e of list) {
      if (e.ts > now + 60e3) continue;
      if (start === null || e.ts >= start + BLOCK || e.ts - last >= BLOCK) {
        start = Math.floor(e.ts / HOUR) * HOUR;
        block = emptySum();
      }
      add(block, e);
      last = e.ts;
    }
    const active = block && now < start + BLOCK ? { ...block, start, end: start + BLOCK } : null;
    const week = emptySum();
    for (const e of list) if (e.ts > now - WEEK && e.ts <= now + 60e3) add(week, e);
    return { block: active, week };
  }
}

module.exports = { LocalUsage, configDir };
