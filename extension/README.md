# Activity Graph for Claude Code

A live graph, inside VS Code, of what Claude Code is doing in the open folder. Unofficial; not made by Anthropic.

## What it shows

Three views, switched with the **Flowchart**, **Graph** and **Plan** buttons:

- **Flowchart** (default): boxes in the order things happened, linked by arrows. Several actions of the same kind in a row share one box with a count ("Read ×6"); click it to list them all. Each request you make is its own section; its prompt appears in the Activity sidebar, where you can click it to fold or reopen the flowchart turn. Claude's main-agent column stays centered, even when no sub-agent has been called; sub-agent columns are arranged side by side around it, with dashed arrows from each "Start agent" box. When the local Claude Usage Guard is present, careful mode, limit stop, hand-off and resume transitions appear as colored Usage guard boxes. Boxes show the action type, its target and, for edits, the function and lines changed. The box an agent is on right now is brighter and has a light running round its edge; a failed action turns red.
- **Graph**: agents, files and code sections as a network, described below.
- **Plan**: when Claude Code proposes a plan (plan mode), the panel switches here and draws the plan's steps as a flowchart, grouped by the plan's headings, with "Waiting for your approval" until you accept it. Claude Code's task list is drawn next to it, and each task is marked in progress (with the running light) or done as work goes on. The steps of the proposed plan itself are not ticked off, because Claude Code only reports progress on the task list.

In the flowchart:

- **Waiting for you**: when Claude Code stops to ask permission, the box turns amber and says "Waiting for your approval". The status bar item and the panel header say so too.
- **Timings**: each box shows how long its action took, counting live while it runs. Each turn's header shows the total.
- **Align by time**: lines boxes up across agents in the order they happened, so you can see what ran at the same moment. It leaves gaps, so it is off by default.
- **Before and after**: hover an Edit box to see the lines removed and added.
- **Final answer**: the "Finished" box shows the last thing the agent said.
- **Replay**: plays the whole session again from the start.
- **Moving between views**: click an agent's header to see it in the graph, or Shift+click a file box. In the graph, click an agent to jump to its steps.

- **Claude** (the main agent) and every **sub-agent** it starts, linked to whoever started them
- **Files** each agent reads (outlined) or edits (filled)
- **Code sections**: the function, class or heading each edit landed in, or the line range when it has no name
- **What each agent is doing right now** (shell command, search, web lookup), shown as a caption under it; hover an agent for its tool counts
- An **activity panel** that groups every action under the agent that did it, with a count per action type (Read, Edit, Shell, Search, Web, Agents). A toggle switches to a plain timeline

Click a file, a code section or an activity line to open it at the right line. Lines Claude just edited are also highlighted for a few seconds in any open editor.

## Install

1. In VS Code: Extensions panel > `...` menu > **Install from VSIX...** and choose the `claude-activity-graph-x.y.z.vsix` file.
2. Open your project folder.
3. Click **Claude Graph** in the status bar (bottom right), or the graph icon at the top right of any editor. The chart opens as an editor tab beside your code, like a Claude Code session; drag the tab wherever you want it. A docked copy is also available in the bottom panel as **Claude Activity** (set `claudeGraph.openIn` to `panel` to make that the default).
4. Click **Connect this workspace**.
5. Start Claude Code in that folder and give it a task. If a session was already running and nothing appears, restart it.

**Play a demo** shows a sample run without Claude Code. **Parallel agents demo** is a separate example with three agents working at once; Claude integrates their work and runs `npm test` after all three finish. **Full usage guard demo** shows a complete task: normal work, careful mode, a failed test and fix, a limit stop, saved hand-off, usage-window reset, resume, and final checks. Demos are simulated, do not change project files or wait for a real usage reset, and remain visible until cleared, replaced by another demo, or VS Code restarts. They are not saved to disk. Start these from the empty chart, from the **⋯** menu at the right of the toolbar, or with the matching **Claude Graph: Play … Demo** commands in the Command Palette.

## The toolbar and the lists

- **Activity** shows or hides the activity list. In a wide tab the list is a column on the right, with the Requests list above it. In half an editor both sit side by side under the chart. In a side bar only the Requests list is shown. With Activity switched off, the Requests list stays under the chart, because it is the way back to an earlier request.
- **⋯** holds the rare actions: the demos, **Install an update from a file…** and **Clear the chart…**. Clearing asks first when real work would be deleted.
- Each open request card is captioned with its request. When several Claude Code sessions are shown together, cards, columns and the activity list also say which session they belong to.
- The strip at the bottom shows the plan limits (5 hours, the week, and the week for a single model when your plan has one). Click it to refresh.

## Several sessions and folders

When more than one Claude Code session reports to the window, a picker appears in the header: show one session or all of them. In a workspace with several folders, **Connect this workspace** adds the hooks to every folder.

## How it works

The extension listens on a local port (127.0.0.1 only). **Connect this workspace** adds HTTP hooks to `.claude/settings.local.json` in your folder, so Claude Code posts each event (tool call, sub-agent start and stop, prompt, end of turn) to that port. Nothing leaves your computer. Other hooks and settings in that file are kept.

**Claude Graph: Disconnect This Workspace** removes the hooks again.

The Usage Guard integration reads `state.json`, session records and resume records from `~/.claude-usage-guard` (or `USAGE_GUARD_DIR` when set). It only records guard state transitions for sessions whose project folder matches the open workspace. On startup it silently takes the current guard state as a baseline, so opening the Activity view does not add a box for an already-active state; only later transitions are shown. It does not read Claude credentials or the usage bar's token.

## Updating

The extension is installed from a file, so it updates from a file too. It watches your Downloads folder for a newer `claude-activity-graph-x.y.z.vsix`. When one appears, it offers to install it and then to reload the window. Choose **Always install** on that message (or set `claudeGraph.autoUpdate` to `install`) and it installs without asking.

- It only looks at files named exactly like that, and only installs a higher version than the one running.
- With `install`, any file with that name in the folder is installed without a prompt, so keep `ask` if other people can put files in that folder.
- `claudeGraph.updateFolder` changes the folder. **Claude Graph: Check for an Update Now** looks immediately.
- **Install an update from a file…** in the **⋯** menu still installs any `.vsix` you pick by hand.
- If VS Code is connected to a remote machine (WSL, SSH, a container), the folder is the Downloads folder on that machine.

The extension works with VS Code 1.85 and every later version, so updating VS Code itself needs no action.

## The Plan view

- **New plan** opens a new Claude Code conversation in plan mode: Claude researches without changing anything and proposes a plan. A running conversation cannot be switched from outside; there, use Shift+Tab or the mode picker.
- **Refresh** reads the plan file from disk again and works the plan and the task list out again.
- Steps are marked to do, in progress and done. When you approve a plan, Claude Code is asked (in a note it sees next to the approval) to keep one numbered task per step; the view follows those tasks. Steps nobody reports on are estimated from the files Claude works on and marked "Started" or "Likely done".
- A finished phase folds away with a Done badge; click any phase header to fold or open it.

## The usage guard

The usage guard stops Claude Code shortly before your 5-hour limit: it asks for a hand-off file first, blocks further work near the limit, and continues in a new session after the reset. It warns about weekly limits and never stops for them.

- **Turn it on or off:** the setting **Claude Usage Guard: Enabled**, the commands **Claude Usage Guard: Turn On / Turn Off**, or the menu of the usage bar in the status bar. Nothing has to be picked or installed by hand; it needs Node.js. The change applies to Claude Code sessions started afterwards.
- **What that does:** it adds or removes the guard's hooks in Claude Code's user settings (`~/.claude/settings.json`), keeping every other hook. The scripts are put in `~/.claude-usage-guard/scripts`. A guard you already installed from somewhere else is left where it is.
- **Thresholds:** `claudeUsageGuard.carefulAt` (75), `handoffAt` (85), `updateAt` (90), `endAt` (95) and `weeklyWarnAt` (80). Leave one empty to keep the guard's own value. They must rise in that order.
- **Claude Usage Guard: Show Status** prints where the guard stands: the stage, the estimated usage, the stop point and the weekly limits.

## Settings

**Open them** with **Settings…** in the chart's **⋯** menu, or **Claude Graph: Open Settings**.

How the chart looks and behaves:

- `claudeGraph.defaultView`: `flow` (default), `graph` or `plan`, for a newly opened chart
- `claudeGraph.density`: `comfortable` (default) or `compact`
- `claudeGraph.showActivityList` and `claudeGraph.activityListMode` (`byAgent` or `timeline`): the activity list in a newly opened chart
- `claudeGraph.showUsageStrip`, `claudeGraph.showAnswerBanner`, `claudeGraph.showTimings`: show or hide those parts (all on by default)
- `claudeGraph.followNewActions`: scroll to the newest action and the step being worked on (default on)
- `claudeGraph.foldFinishedPhases`, `claudeGraph.estimatePlanSteps`, `claudeGraph.trackPlanSteps`: the Plan view (all on by default)
- `claudeGraph.maxEvents`: how many events are kept (default 3000)

Other:

- `claudeGraph.highlightEdits`: highlight edited lines in open editors (default on)
- `claudeGraph.highlightSeconds`: how long the highlight lasts (default 12)
- `claudeGraph.autoUpdate`: `ask` (default), `install` or `off`
- `claudeGraph.updateFolder`: folder to watch, Downloads when empty
- `claudeGraph.openIn`: `tab` (default) or `panel`
- `claudeGraph.openOnActivity`: open the view when Claude Code starts working (default off)
- `claudeGraph.autoShowPlan`: switch to the Plan view when a plan is proposed (default on)
- `claudeGraph.groupRepeats`: stack repeated actions into one box; off gives one box per action (default on)
- `claudeGraph.foldEarlierTurns`: fold the previous request when a new one starts (default on)

## Limits

- Events arrive only while VS Code is open with this folder. Claude Code keeps working normally when it is closed.
- If your organisation restricts HTTP hooks (`allowedHttpHookUrls`), `http://127.0.0.1:*` must be allowed.
- Events are saved in VS Code's storage for this workspace (the last 3000), so the chart survives a reload. They include file paths, shell commands and your prompts, and stay on your computer. **Clear** deletes them.
