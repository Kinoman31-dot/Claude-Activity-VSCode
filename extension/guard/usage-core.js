'use strict';
// Decision logic for the usage guard. Pure (no I/O) so the hook, the guard and the tests share it.
//
// The percentage comes from Anthropic's own readings. Between two readings the guard counts steps
// (the hook runs once per tool call): `rise / steps` over the last few readings gives what one
// step costs right now, and the position is `last reading + steps since x cost per step`.
//
//   below 75 %   normal
//   75 %         careful mode: Claude is asked to work in small steps
//   85 %, 90 %   the hook asks for the hand-off file, then for one short update (see usage-hook.js)
//   near 93 %    stop: a step is let through only if, after it, the final reply still fits under 95 %
//
// History: until 13 Nov 2026 the position was estimated from token counts in the transcripts
// (usage-transcripts.js, per-model ratios, a calibration history). Real readings made that unnecessary.

const DEFAULTS = {
  line: 75, // careful mode from this %
  handoffAt: 85, // the hook asks for the hand-off file from this %
  weeklyWarnAt: 80, // a weekly limit at this % is warned about (never a stop); 0 switches the warning off
  updateAt: 90, // ...and for one short update of it from this %
  endAt: 95, // a session must end at or below this %
  tail: 1, // % the final reply costs after a stop, until real stops have been measured (see the hook)
  stepSafety: 2, // the next step is assumed to cost this many average steps (near the limit, 12-13 Nov 2026, the step count ran up to 4 points under the real figure)
  stepCost: 0.5, // % per step before any interval has been measured
  intervals: 3, // cost per step = sum of rises / sum of steps over this many readings
  priorSteps: 3, // ...blended with the starting figure, which counts as this many steps
  maxStepCost: 5, // an interval that implies more than this per step is usage from elsewhere, not ours
  ceiling: 100, // never stop later than this % (the usage bar's guardThreshold)
  staleMs: 24 * 3600e3, // a reading older than this is ignored
  fetchFloorMs: 20e3, // never ask for a reading more often than this (13 Nov 2026: no rate limiting at one request every 20 s)
  fetchIdleMs: 5 * 60e3, // ...and at least this often while steps are being taken
  fetchStepsBlind: 5, // ...and after this many steps while this window has no measurement yet
  fetchNearMs: 60e3, // ...and at least this often from the careful line on
};

const WINDOW_MS = 5 * 3600e3;

function toMs(v) {
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isNaN(n) || n <= 0 ? null : n;
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v; // seconds or ms
  return null;
}

// ~/.claude-usage.json -> { p, t, resetsAt } for the 5-hour bucket, or null when unusable.
function parseReading(json, key = 'five_hour') {
  if (!json || typeof json !== 'object') return null;
  const b = json[key];
  if (!b || typeof b.percent !== 'number' || !Number.isFinite(b.percent)) return null;
  const t = toMs(json.updatedAt);
  if (t == null) return null;
  const r = toMs(b.resetsAt);
  return { p: b.percent, t, resetsAt: r != null && r > t - WINDOW_MS ? r : null };
}

// The API's reset time jitters slightly between fetches.
const sameReset = (a, b) => a != null && b != null && Math.abs(a - b) < 10 * 60e3;

// When the reading's window has ended: the time usage restarted from 0, else null.
function endedAt(reading, now) {
  if (reading.resetsAt != null) return now >= reading.resetsAt ? reading.resetsAt : null;
  return reading.p === 0 || now >= reading.t + WINDOW_MS ? reading.t : null;
}

function sameWindow(stored, id, resetsAt) {
  if (!stored) return false;
  if (stored.id === id) return true;
  return String(stored.id).startsWith('w:') && String(id).startsWith('w:') && sameReset(stored.resetsAt, resetsAt);
}

// What one step costs, in %: from the last readings of this window, else what the previous
// window measured, else the default.
function stepCostOf(s, c) {
  const use = (s.obs || []).slice(-c.intervals);
  const rise = use.reduce((x, o) => x + o[0], 0);
  const steps = use.reduce((x, o) => x + o[1], 0);
  const start = s.cps > 0 ? s.cps : c.stepCost;
  if (!(steps > 0)) return start;
  // A few steps say little (readings are whole numbers, and one step can be unusually big), so
  // the measurement is blended with the starting figure as if that were priorSteps more steps.
  return Math.min(c.maxStepCost, (rise + start * c.priorSteps) / (steps + c.priorSteps));
}

// How long a reading stays good: about the time usage needs to rise one point (readings are
// whole numbers, so asking sooner tells nothing new), within the floor and the ceilings.
function fetchEveryOf(s, near, c) {
  const use = (s.obs || []).slice(-c.intervals);
  const rise = use.reduce((x, o) => x + o[0], 0);
  const ms = use.reduce((x, o) => x + (o[2] || 0), 0);
  const perPoint = rise > 0 && ms > 0 ? ms / rise : Infinity;
  return Math.max(c.fetchFloorMs, Math.min(perPoint, near ? c.fetchNearMs : c.fetchIdleMs));
}

// Advance the guard state.
//   prev:    persisted state (or undefined)
//   now:     ms
//   reading: parseReading(...) or null
//   total:   steps counted so far by the hook, ever (a number that only grows)
// Returns { state, stage, est, cps, stopAt, fetchEvery, resetsAt, since, measured }.
// stage is 'normal' | 'careful' | 'stopped'.
//   agents:  how many agents are taking steps right now (sessions and sub-agents), at least 1
function step(prev, { now, reading, total = 0, agents = 1 }, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const s = prev && prev.v === 2 ? JSON.parse(JSON.stringify(prev)) : { v: 2 };
  if (!Array.isArray(s.obs)) s.obs = [];
  if (reading && now - reading.t > c.staleMs) reading = null;

  if (!reading) {
    // The usage file is missing or unreadable (maybe mid-write). Keep a careful/stopped stage
    // until its reset so a glitch does not lift a stop; otherwise let Claude work.
    const w = s.win;
    if (w && w.stage !== 'normal' && w.resetsAt && now < w.resetsAt) {
      return { state: s, stage: w.stage, est: w.est == null ? null : w.est, cps: stepCostOf(s, c), stopAt: null, fetchEvery: c.fetchFloorMs, resetsAt: w.resetsAt, since: 0, measured: s.obs.length > 0, reason: 'no fresh usage data; keeping the last stage until the reset' };
    }
    return { state: s, stage: 'normal', est: null, cps: stepCostOf(s, c), stopAt: null, fetchEvery: c.fetchFloorMs, resetsAt: null, since: 0, measured: s.obs.length > 0, reason: 'no usage data' };
  }

  // Which window is this? After the reading's reset time usage counts from 0 again; the real
  // figure comes with the next reading, which the hook asks for at once (the reading is old).
  const ended = endedAt(reading, now);
  const id = ended == null ? 'w:' + (reading.resetsAt == null ? 'unknown' : reading.resetsAt) : 'after:' + ended;
  const resetsAt = ended == null ? reading.resetsAt : null;
  if (!sameWindow(s.win, id, resetsAt)) {
    if (s.obs.length) s.cps = stepCostOf(s, c); // what a step cost carries over as the starting figure
    s.obs = [];
    s.mark = null;
    s.win = { id, resetsAt, stage: 'normal', carefulSince: null, stoppedAt: null };
  }
  const win = s.win;
  if (resetsAt) win.resetsAt = resetsAt;

  const base = ended == null ? reading.p : 0;
  const baseT = ended == null ? reading.t : ended;
  // A new reading closes an interval: its rise and the steps taken in it are one measurement.
  if (!s.mark || baseT > s.mark.t) {
    if (s.mark && ended == null && base >= s.mark.p) {
      const steps = total - s.mark.total;
      if (steps > 0 && (base - s.mark.p) / steps <= c.maxStepCost) s.obs = s.obs.concat([[base - s.mark.p, steps, baseT - s.mark.t]]).slice(-6);
    }
    s.mark = { t: baseT, p: base, total };
  }
  const since = Math.max(0, total - s.mark.total);
  const cps = stepCostOf(s, c);
  const est = Math.min(100, base + since * cps);
  win.est = est;

  // A reading taken after the stop that puts us below the line means the stop was wrong.
  if (win.stage === 'stopped' && ended == null && reading.t > win.stoppedAt && est < c.line) {
    win.stage = 'careful';
    win.carefulSince = now;
    win.stoppedAt = null;
  }
  if (win.stage === 'normal' && est >= c.line) {
    win.stage = 'careful';
    win.carefulSince = now;
  }
  // Admit the next step only if, after it, the final reply still fits under endAt.
  // Never below the careful line (one huge step, such as resuming a long session, would otherwise
  // stop a session that has most of its window left), never above the ceiling.
  // Every other agent still working (another session, a sub-agent) finishes the step it is in
  // after the stop, so each one needs room for a step too.
  const stopAt = Math.min(c.ceiling, Math.max(c.line, c.endAt - c.tail - (c.stepSafety + Math.max(0, agents - 1)) * cps));
  if (win.stage === 'careful') {
    // holdTarget (set by the hook while a stop waits for a fresh reading): only the hard end stops.
    if (c.holdTarget ? est >= Math.min(c.ceiling, c.endAt - c.tail) : est >= stopAt) {
      win.stage = 'stopped';
      win.stoppedAt = now;
      win.stopReal = base; // the last real figure before the stop
      win.stopEst = est; // where the guard held usage to be at the stop: what the final reply costs is measured from here
    }
  }
  // When is the next reading due? By time (fetchEveryOf), and by steps: after the number of steps
  // that should move usage about 2 points (1 point from the careful line on), or after
  // fetchStepsBlind steps while nothing has been measured in this window. Without the step rule,
  // three agents at 9 % a minute ran from 50 % to the limit inside one 5-minute interval.
  const nearLine = est >= c.line;
  const fetchEvery = fetchEveryOf(s, nearLine, c);
  const fetchSteps = s.obs.length ? Math.max(1, Math.ceil((nearLine ? 1 : 2) / cps)) : c.fetchStepsBlind;
  const age = now - reading.t;
  const fetchDue = age > fetchEvery || (since >= fetchSteps && age >= c.fetchFloorMs);
  return { state: s, stage: win.stage, est, cps, stopAt, fetchEvery, fetchSteps, fetchDue, resetsAt: win.resetsAt, since, measured: s.obs.length > 0 };
}

module.exports = { DEFAULTS, WINDOW_MS, toMs, parseReading, sameReset, endedAt, step, stepCostOf, fetchEveryOf };
