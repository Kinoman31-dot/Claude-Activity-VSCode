'use strict';
// Asks Anthropic how full your plan limits are (the numbers behind Claude Code's /usage).
// Pure Node, no VS Code imports. It only READS the sign-in token; it never refreshes or
// rewrites it, so it cannot log Claude Code out.
const fs = require('fs');
const https = require('https');
const path = require('path');
const { configDir } = require('./usage-local');

const LABELS = {
  five_hour: '5-hour session',
  seven_day: 'Weekly (all models)',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  extra_usage: 'Extra usage',
};

class PlanError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

function readCredentials() {
  const file = path.join(configDir(), '.credentials.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new PlanError(
      'no-file',
      'No sign-in file found at ' + file + ' (on macOS the token lives in the Keychain, which this extension cannot read).'
    );
  }
  let o;
  try {
    o = JSON.parse(raw).claudeAiOauth;
  } catch {
    o = null;
  }
  if (!o || !o.accessToken) {
    throw new PlanError('no-token', 'The sign-in file has no Claude account token. Sign in to Claude Code with your Claude account.');
  }
  return { token: o.accessToken, expiresAt: o.expiresAt, plan: o.subscriptionType || null };
}

function request(token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      'https://api.anthropic.com/api/oauth/usage',
      {
        headers: {
          Authorization: 'Bearer ' + token,
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
          'User-Agent': 'claude-usage-bar',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timed out talking to api.anthropic.com')));
    req.on('error', reject);
  });
}

// Turns the answer into a flat list of { key, label, percent, resetsAt }.
function parseUsage(json) {
  const buckets = [];
  const byKey = {};
  for (const [key, v] of Object.entries(json || {})) {
    if (!v || typeof v !== 'object' || typeof v.utilization !== 'number') continue;
    if (v.is_enabled === false) continue; // extra usage that is switched off is not a limit worth a bar
    const b = {
      key,
      label: LABELS[key] || key.replace(/_/g, ' '),
      percent: Math.min(100, Math.max(0, v.utilization)),
      resetsAt: v.resets_at ? Date.parse(v.resets_at) : null,
    };
    buckets.push(b);
    byKey[key] = b;
  }
  // The weekly limit of a single model (for example Fable) has no key of its own: only the newer
  // `limits` list names it. It is listed right after the weekly limit for all models.
  let at = byKey.seven_day ? buckets.indexOf(byKey.seven_day) + 1 : buckets.length;
  for (const l of Array.isArray(json && json.limits) ? json.limits : []) {
    if (!l || l.kind !== 'weekly_scoped' || typeof l.percent !== 'number' || !Number.isFinite(l.percent)) continue;
    const name = l.scope && l.scope.model && l.scope.model.display_name;
    if (typeof name !== 'string' || !name) continue;
    const key = 'weekly_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (byKey[key]) continue;
    const r = l.resets_at ? Date.parse(l.resets_at) : null;
    const b = {
      key,
      label: 'Weekly (' + name + ')',
      short: '7d ' + name,
      model: name,
      percent: Math.min(100, Math.max(0, l.percent)),
      resetsAt: Number.isNaN(r) ? null : r,
    };
    buckets.splice(at++, 0, b);
    byKey[key] = b;
  }
  return { buckets, byKey };
}

async function fetchPlanUsage(timeoutMs = 10000) {
  const cred = readCredentials();
  if (typeof cred.expiresAt === 'number' && cred.expiresAt < Date.now() + 30e3) {
    throw new PlanError('expired', 'The sign-in token has expired. Send any message in Claude Code and it will renew itself.');
  }
  const res = await request(cred.token, timeoutMs);
  if (res.status === 401 || res.status === 403) {
    throw new PlanError('expired', 'Anthropic did not accept the sign-in token. Send any message in Claude Code to renew it.');
  }
  if (res.status === 429) {
    const wait = parseInt(res.headers['retry-after'], 10);
    throw new PlanError('rate', 'Anthropic asked us to slow down.', { retryAfterMs: (Number.isFinite(wait) ? wait : 300) * 1000 });
  }
  if (res.status !== 200) {
    throw new PlanError('http', 'Anthropic answered with HTTP ' + res.status + '.');
  }
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new PlanError('format', 'Anthropic sent an answer that is not JSON.');
  }
  const parsed = parseUsage(json);
  if (!parsed.buckets.length) {
    throw new PlanError('format', 'The usage answer had no limits in it (the endpoint may have changed).', { raw: res.body });
  }
  return { ...parsed, plan: cred.plan, raw: res.body };
}

module.exports = { fetchPlanUsage, parseUsage, PlanError };
