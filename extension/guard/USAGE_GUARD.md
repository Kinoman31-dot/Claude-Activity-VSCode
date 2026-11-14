# Usage guard for Claude Code

Stops Claude Code cleanly before you hit the 5-hour usage limit, then continues the work in a new session after the limit resets.

## How it works

| 5-hour usage | What happens |
|---|---|
| Below 75% | Claude works normally. |
| 75% | **Careful mode.** Claude is told to work in small steps. Nothing is blocked. |
| 85% | **Hand-off.** Claude is told to write `HANDOFF-<session>.md` in the project folder (session id, task, done, left, next steps) and to keep working. |
| 90% | Claude is told to update the hand-off once, briefly. |
| Near 93% | **Stop.** Every tool is blocked and Claude is told to end its turn. Nothing more is written. A prompt typed now is refused before it reaches Claude, so it costs nothing. |
| After the reset | The guard saves a snapshot of the folder and starts a **new** session that reads the hand-off and continues. |

The aim is that a session ends between 90 and 95% of the limit.

**Where the percentage comes from.** From Anthropic: the same figure the Account & Usage dialog shows, fetched from `https://api.anthropic.com/api/oauth/usage` with the sign-in token in `~/.claude/.credentials.json` (sent nowhere else, never changed) and kept in `~/.claude-usage.json`. Nothing is estimated from tokens.

**Between two readings.** Readings are whole percentages and arrive at most every 20 seconds, so in between the guard counts steps: the hook runs once per tool call, in every session and sub-agent. When a new reading arrives, the rise since the last one divided by the steps taken gives what one step costs right now (over the last 3 readings, blended with the previous figure so that one odd interval does not decide). The position is `last reading + steps since × cost per step`. Nothing is added while Claude waits for you.

**When a new reading is fetched.** When it can tell something new:
- by time: about once per point of usage at the current pace, at most every 20 seconds, at least every 5 minutes while steps are taken (every minute from 75% on);
- by steps: after the number of steps that should move usage about 2 points (1 point from 75% on), or after 5 steps while nothing has been measured in this window. This is what catches several agents burning fast.

**The stop.** A step is let through only if, after it, the final reply still fits under 95%:

`stop when position ≥ 95 − room for the final reply − (2 + other working agents) × cost per step`

- With cheap steps (0.5%) that is 93%. With dear steps (a large context, 2% a step) it is about 90%.
- The stop is only decided on a reading at most 20 seconds old. If a newer one is needed but the last request was under 20 seconds ago, the stop waits, unless the position is 2 points past the target.
- Never below 75%, and never above the `guardThreshold` the Claude Usage Bar writes to `~/.claude-usage.json`.

**The guard corrects itself.** For every stop it logs the real percentage at the stop and the last real reading before the reset (`~/.claude-usage-guard/stops.jsonl`). The average difference over the last 5 stops becomes the "room for the final reply". If stops end high, the next ones come earlier by that much.

**Sub-agents.** At the stop a sub-agent's tools are blocked, except the one that hands its report back to the main agent. Only the main agent writes the hand-off.

**If usage jumps past 85% before a hand-off exists** (one very large step), the stop allows one hand-off write, as the earlier guard did.

**The new session.** After the reset the guard runs `claude -p "Read HANDOFF-<session>.md and continue…"` in the same folder. It knows only what the hand-off says. Resuming the stopped session itself sends its whole context again, which on 13 Nov 2026 cost about a quarter of the new window in one step; `RESUME_MODE=same` does it anyway, and it is also what happens when there is no hand-off file.

**Lifting a stop.** A reading after a stop that shows usage below 75% lifts the stop back to careful mode.

**Checking it.** `node scripts/usage-hook.js status` shows the stage, the position, what a step costs, the stop target, and what the last stops really cost. Every reading is logged to `~/.claude-usage-guard/readings.jsonl` next to the position held just before it.

## What the guard cannot see

- Usage from another computer or from claude.ai shows only at the next reading.
- One step is the smallest unit it can act on. A single very large step near the limit can overshoot; careful mode asks for small steps for that reason.
- If Anthropic's figure ran a full minute behind real usage, fast sessions would overshoot (see below). The real stops of 12–13 Nov 2026 showed no such delay.
- Only the 5-hour limit is guarded, not the weekly ones.

## Simulation results

Simulated sessions through this exact decision code, 1,500 per usage pattern (light, normal, heavy, and a large context where every step stays dear).

| Situation | Cut off by the limit | Sessions ending at 90–95% | Stopped sessions end at (average) |
|---|---|---|---|
| One session | 0–0.3% | 92–99% | 93.6–93.8% |
| Three agents in parallel | 0–0.5% | 79–97% | 92.9–93.7% |
| Readings a full minute behind (assumed, not observed) | 0–2.3% | 50–96% | 93.9–95.2% |
| Three agents and readings a minute behind (assumed, not observed) | 0–41% | 19–80% | 94.0–97.6% |

The 41% is three agents with a large context, about 7% of the window a minute, with every reading a minute old.

## Setup (Windows, macOS or Linux)

You need Node.js and to be signed in to Claude Code. The Claude Usage Bar extension is optional: when it writes `~/.claude-usage.json` every minute, the guard asks Anthropic less often.

1. **Install the hooks** into your user settings, so they work in every project:
   ```
   node scripts/usage-hook.js install
   ```
   This adds a `PreToolUse`, a `Stop` and a `UserPromptSubmit` hook to `~/.claude/settings.json`, and keeps a backup at `settings.json.bak-usage-guard`.
2. **Keep the guard running** in a terminal, so stopped work is continued after the reset (the hook also starts it when a stop happens):
   ```
   node scripts/usage-guard.js
   ```
   `--once` makes a single pass instead.
3. **Check it** at any time:
   ```
   node scripts/usage-hook.js status
   ```

To remove the hooks: `node scripts/usage-hook.js uninstall`. To turn the guard off for one session: start Claude Code with `USAGE_GUARD=off`. To stop it asking Anthropic: `USAGE_GUARD_FETCH=off` (it then relies on the usage bar's readings).

## Settings

Put any of these in `~/.claude-usage-guard/config.json`, for example `{"handoffAt": 80}`:

| Key | Default | Meaning |
|---|---|---|
| `line` | 75 | Careful mode from this % |
| `handoffAt` | 85 | Claude is asked for the hand-off from this % |
| `updateAt` | 90 | Claude is asked for one short update from this % |
| `endAt` | 95 | A session must end at or below this % |
| `tail` | measured | Room kept for the final reply, in %. 1 until a stop has been measured; setting it here switches the measuring off |
| `stepSafety` | 2 | The next step is assumed to cost this many average steps |
| `stepCost` | 0.5 | % per step before anything has been measured |
| `intervals`, `priorSteps` | 3, 3 | Cost per step: over this many readings, blended with the previous figure counted as this many steps |
| `maxStepCost` | 5 | An interval implying more than this per step is usage from elsewhere and is not counted |
| `fetchFloorMs` | 20000 | Shortest time between two requests to Anthropic |
| `fetchIdleMs`, `fetchNearMs` | 300000, 60000 | Longest time a reading is used while steps are taken, below and from 75% |
| `weeklyWarnAt` | 80 | A weekly limit at this % is warned about, and again every 5 points; `0` switches the warning off |
| `fetchStepsBlind` | 5 | Steps after which a reading is fetched while this window has no measurement yet |

Guard options are environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `INTERVAL` | 15 | Seconds between checks |
| `RESUME_MODE` | new session | `same` resumes the stopped session instead of starting a new one |
| `RESUME_ARGS` | `--permission-mode acceptEdits` | Extra arguments for the session the guard starts |
| `CHECKPOINT`, `PUSH` | on | `0` switches the snapshot, or its push, off |
| `DRY_RUN` | off | `1` only logs what would be run |

## Weekly limits

The guard does not stop for the weekly limits. It reports them (`node scripts/usage-hook.js status`) and warns: when a weekly limit (all models, or the one for a single model such as Fable) reaches `weeklyWarnAt`, Claude is told once, and again for every further 5 points, and passes it on in its next reply. Nothing is blocked. The figures come from the same reading as the 5-hour figure.

## History

Until 13 Nov 2026 the guard estimated usage from token counts in Claude Code's transcripts, with ratios learned per model. That code (`usage-transcripts.js`) was removed after the new guard's first real stop: asked for the hand-off at 85%, stopped at a real 90%, and the window ended at 94%. A copy is in `~/.claude-usage-guard/backup-2026-11-13g-before-transcripts-removal`.

That first stop also showed one fault, fixed the same day: the stop was reached on the reply that ended the turn, with no tool blocked before it, and such a stop was not recorded, so no new session was started after the reset. The `Stop` hook now records it when the session has a hand-off from that window.
