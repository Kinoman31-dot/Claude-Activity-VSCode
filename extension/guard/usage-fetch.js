#!/usr/bin/env node
'use strict';
// Asks Anthropic for the current plan usage (the numbers behind Claude Code's /usage) and writes
// it to the usage file in the format the Claude Usage Bar extension uses. The hook runs this as a
// child process near the limit, when the extension's reading is not fresh.
//
//   node scripts/usage-fetch.js <usage file> [throttle file]
//
// Same endpoint and sign-in file as the extension's usage-plan.js. It only READS the token; it
// never refreshes or rewrites it. Exit code 0 = a reading was written; anything else = it was not.
const fs = require('fs');
const https = require('https');
const path = require('path');
const { configDir, readJSONQuiet, writeJSON } = require('./usage-fs');

const URL = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 4000;

const credentialsFile = () => path.join(configDir(), '.credentials.json');

// The sign-in token, or null when there is none or it has expired.
function readToken(now = Date.now()) {
  let o = null;
  try {
    o = JSON.parse(fs.readFileSync(credentialsFile(), 'utf8')).claudeAiOauth;
  } catch (_) { /* missing or unreadable */ }
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null;
  if (typeof o.expiresAt === 'number' && o.expiresAt < now + 30e3) return null;
  return o.accessToken;
}

// GET the usage answer: resolves { status, headers, body }. The whole call ends within timeoutMs.
function request(token, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      URL,
      { headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', 'User-Agent': 'claude-usage-guard' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      }
    );
    const timer = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// The API answer -> { five_hour, seven_day } as { percent, resetsAt } (or null), like the extension,
// plus weekly: [{ label, percent, resetsAt }].
function parseAnswer(json) {
  const pick = (key) => {
    const v = json && json[key];
    if (!v || typeof v !== 'object' || typeof v.utilization !== 'number' || !Number.isFinite(v.utilization)) return null;
    const r = v.resets_at ? Date.parse(v.resets_at) : null;
    return { percent: Math.min(100, Math.max(0, v.utilization)), resetsAt: Number.isNaN(r) ? null : r };
  };
  // The weekly limits: all models, and one per model where the plan has it. Only the `limits`
  // list names the per-model ones; an answer without that list still gives the all-models figure.
  const weekly = [];
  for (const l of Array.isArray(json && json.limits) ? json.limits : []) {
    if (!l || l.group !== 'weekly' || typeof l.percent !== 'number' || !Number.isFinite(l.percent)) continue;
    const name = l.scope && l.scope.model && l.scope.model.display_name;
    const r = l.resets_at ? Date.parse(l.resets_at) : null;
    weekly.push({ label: typeof name === 'string' && name ? name : 'all models', percent: Math.min(100, Math.max(0, l.percent)), resetsAt: Number.isNaN(r) ? null : r });
  }
  const seven = pick('seven_day');
  if (!weekly.length && seven) weekly.push({ label: 'all models', ...seven });
  return { five_hour: pick('five_hour'), seven_day: seven, weekly };
}

// Fetch a reading. Resolves { ok: true, five_hour, seven_day } or { ok: false, why, retryAfterMs? }.
// `deps` lets the tests replace the token and the network call.
async function fetchReading(deps = {}) {
  const token = (deps.readToken || readToken)();
  if (!token) return { ok: false, why: 'no token' };
  let res;
  try {
    res = await (deps.request || request)(token);
  } catch (e) {
    return { ok: false, why: 'network: ' + e.message };
  }
  if (res.status === 429) {
    const wait = parseInt(res.headers && res.headers['retry-after'], 10);
    return { ok: false, why: 'rate limited', retryAfterMs: (Number.isFinite(wait) ? wait : 120) * 1000 };
  }
  if (res.status !== 200) return { ok: false, why: 'HTTP ' + res.status };
  let parsed;
  try {
    parsed = parseAnswer(JSON.parse(res.body));
  } catch (_) {
    return { ok: false, why: 'not JSON' };
  }
  if (!parsed.five_hour) return { ok: false, why: 'no 5-hour limit in the answer' };
  return { ok: true, ...parsed };
}

// Fetch and write the usage file (keeping the extension's guardThreshold). On a rate limit, note
// in the throttle file when the next try is allowed.
async function fetchToFile(usageFile, throttleFile, deps = {}) {
  const r = await fetchReading(deps);
  if (!r.ok) {
    if (r.retryAfterMs && throttleFile) {
      try {
        writeJSON(throttleFile, { at: Date.now(), until: Date.now() + Math.min(r.retryAfterMs, 3600e3) });
      } catch (_) { /* the plain 45 s throttle still applies */ }
    }
    return r;
  }
  const old = readJSONQuiet(usageFile, null);
  const out = { updatedAt: Date.now() };
  if (old && typeof old.guardThreshold === 'number') out.guardThreshold = old.guardThreshold;
  out.five_hour = r.five_hour;
  out.seven_day = r.seven_day;
  out.weekly = r.weekly;
  writeJSON(usageFile, out, false);
  return r;
}

if (require.main === module) {
  const [usageFile, throttleFile] = process.argv.slice(2);
  if (!usageFile) {
    console.error('usage: usage-fetch.js <usage file> [throttle file]');
    process.exit(2);
  }
  fetchToFile(usageFile, throttleFile).then(
    (r) => {
      if (!r.ok) console.error(r.why);
      process.exit(r.ok ? 0 : 1);
    },
    (e) => {
      console.error(e && e.message);
      process.exit(1);
    }
  );
}

module.exports = { credentialsFile, readToken, request, parseAnswer, fetchReading, fetchToFile };
