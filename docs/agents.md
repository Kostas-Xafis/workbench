# Agents

Agents work the board with the `wb` command or the workbench's MCP server. The rules they follow are a standard block in each project's AGENTS.md or CLAUDE.md. How to write an item is in the MCP server's instructions and `wb guide`.

## Setting a project up for agents

Settings → About has a short prompt to paste into a session in any project. The agent runs `wb integrate` (or the MCP tool `integration_guide`), which says what's set up and what's left: the project on the board, the board's rules in its AGENTS.md or CLAUDE.md, and Claude Code's MCP server and permissions. It asks you before adding the project, changing settings or moving to-do lists into items.

- **Rules sit between markers** that carry a version (`<!-- workbench rules v4 … -->` … `<!-- /workbench rules -->`), so running it again replaces them. A project's own notes go outside the markers.
- **Settings → Projects** shows each project's rules as up to date, out of date, written by hand or missing, with a button that copies the prompt for that folder. When the rules change (`RULES_VERSION` in integrate.ts), every project shows as out of date until it's run there.
- `wb start` records the desktop-app session, and the item links back to it.

## MCP server

The workbench is an MCP server, so agents work the board with tools instead of shelling out to `wb`. It runs two ways, with the same tools:

```bash
claude mcp add -s user wb -- wb mcp                               # stdio: Claude Code starts `wb mcp` itself
claude mcp add -s user --transport http wb http://localhost:4321/mcp   # or through the running board
```

- **stdio** (`wb mcp`) works without the board running. Its default project is the one whose folder the client starts it in (`WB_PROJECT=slug` pins one). While this computer syncs with the [cloud board](cloud.md), `wb mcp` relays every call to it.
- **HTTP** (`POST /mcp`) is for this computer only: it refuses other addresses (so not the phone under `--lan`), a Host other than localhost, and any web page's Origin. `?project=slug` sets the default project.
- **Tools:** `list_projects`, `project_overview` (open items, rulings, trackers, git state, reports, links and data sources of a project), `search`, `list_items`, `get_item`, `add_item`, `update_item`, `attach_image`, `start_item`, `wait_item` (with `on`: the items it waits on), `finish_item`, `drop_item`, `add_note`, `answer_decision` (only with an answer you gave in the conversation), `list_rulings`, `add_ruling`, `update_ruling` (also moves a ruling, or retires it), `add_link`, `vault_list`, `vault_get` ([the vault](vault.md)), and four that take an `action`: `goal` (list, add, update), `report` (list, read, publish, icon), `tracker` (list, get, record, refresh, define, remove, presets) and `image` (get, remove). A run the board started also has `permission`, which Claude Code calls for its permission prompts ([While it runs](#while-it-runs)). Every tool's definition is loaded into every agent session, so they are kept few and short: about 19.6 KB with the instructions, and a test fails if that grows 10%. Read-only tools are marked as such, so a client can let them run without asking.
- **Resources:** `wb://projects`, `wb://project/{slug}`, `wb://item/{wb-xxxx}`, `wb://report/{id}`, `wb://rulings/{slug}`, `wb://trackers`, `wb://trackers/{slug}`. `@` in Claude Code can attach an open item or a report.
- **Prompts** (slash commands in Claude Code): `/mcp__wb__work-on wb-k3f9` (the item's brief and how to track it), `/mcp__wb__next` (pick the next agent task), `/mcp__wb__status` (a short status of the project) and `/mcp__wb__today` (what waits on you, what finished and what's stuck, since a time you give or the last 24 hours).
- **Not on MCP:** reading the vault without you, data sources' secrets, deleting items, reports or links, and starting agents (agents don't start agents). `image` with `remove` is there so an agent can replace a picture it got wrong; the item's history keeps a line.
- **Protocol:** MCP 2026-07-28 (stateless) and the earlier revisions down to 2024-11-05, on both transports.

### Renamed tools

Up to 0.5.0 these were tools of their own. The old names still work, unlisted and with the same arguments, for one release (0.6.0); use the new ones.

| Old | Now |
| --- | --- |
| `list_goals`, `add_goal`, `update_goal` | `goal` with `action` list, add, update |
| `list_reports`, `read_report`, `publish_report`, `set_report_icon` | `report` with `action` list, read, publish, icon |
| `list_trackers`, `get_tracker`, `record_tracker`, `refresh_trackers`, `define_tracker`, `remove_tracker` | `tracker` with `action` list, get, record, refresh, define, remove (`presets` lists the preset kinds) |
| `get_image`, `remove_image` | `image` with `action` get, remove |
| `retire_ruling` | `update_ruling` with `retire: true` |

## Is it running?

The board tells a live agent from an item someone left in doing. An agent counts as **alive** on an item while:

- **a run the board started** is going on it, or
- **it acted on it in the last 5 minutes:** an MCP call that changes the item (`start_item`, `add_note`, `update_item`, `finish_item`, `wait_item`, `attach_image`, the `image` tool, `answer_decision`, `drop_item`), any MCP call from the session that started the item (`start_item` records the desktop-app session the server runs in) while it's doing, or the same from an agent's `wb` (`wb start`, `wb note`, `wb done`, `wb wait`, `wb edit`, `wb drop`, `wb answer`, `wb image add`/`rm`). Reading doesn't count (`get_item`, `list_items`, `search`, `wb show`), nor do your own `wb` commands and the board's page.

**Running now** on the Agents place lists the runs the board started that are going, and the agents' items that are alive and in doing.

The cloud board works the same way.

**Stalled** is "no sign of life for a day while doing": no note, no call, and no run going. A waiting item is stale after 7 days.

## Agents the board starts

Answering a decision hands it back to the agent, but nothing runs until someone opens a session and types "Do wb-xxxx". The board knows the project's folder and the item, so it can start the agent itself. **It's off until you turn it on** in Settings → Agents, and every agent it starts is a Claude Code session on your account: **it uses your plan's limits (or API credits) as any session does.** The cost the board shows for a run ("$0.42 at API prices") is what its tokens come to at Claude API list prices, as the Usage page counts. On a subscription you don't pay it: it measures how much the run took.

### Starting one

- **Run**, on an agent's to-do (on its card and in the item): the board starts `claude -p` headless in the project's folder, told to read the item with `get_item`, `start_item` it, do it by the project's own rules, and `finish_item` it or file what it needs from you and wait. Nobody watches it, so it puts questions on the board.
- **Answer & send:** in an item that asks you something, tick **resume the agent** next to the answer (or the objection). Your answer, by a choice, ticks or your own words, then also starts the agent. When the agent can't start (off, a limit, no folder) nothing is answered, and you get the reason.
- **Merge it** is below.
- **When an agent's work is unblocked** (Settings → Agents): **Tell me** (the default) is the notification "An agent can carry on" and Run on its card. **Send it** starts the agent by itself, whoever answered, within the limits. What a limit holds back goes when the limit allows, the same day.
- **Limits:** at most 1 at once and 5 a day unless changed, and optionally a day's usage: no new agent once today's runs come to that much at API prices, counted from their sessions as the Usage page does. A run already going isn't stopped. A day starts at the hour set in Settings → About.
- **Autopilot**, per project: below.
- **Only this computer starts agents.** A paired phone can answer, but starting needs "From a paired phone too" in Settings → Agents. Agents never start agents: there's no MCP tool for it, and `wb run` and `wb continue` refuse inside one.

### Autopilot

A switch in each project's header, off until you turn it on. While it's on, whenever a slot is free, the board starts an agent on the first item of the project's **Next up** that an agent can run: an agent's to-do (not an idea), waiting on nothing, with no run on it. It starts with the item's own model, effort and mode, and its history says "Agent started by autopilot (run #n)". One at a time per project: any run on the project (yours too) is its one. With one slot and several projects on, the project it started least lately goes first.

- **Within the limits:** at once, per day and a day's usage, as every run. And its own, in Settings → Agents → Limits: **Autopilot starts agents** any time (the default) or only in hours you pick (at night, 22:00–08:00, so the queue moves while you sleep), at your device's clock; and **Autopilot pauses when a tracker is** bad (the default), warn or bad, or never. The trackers that count are the project's own and the board-wide ones, such as your plan's usage; one that couldn't read doesn't.
- **It says why it waits**, in one line under the switch: "Paused: Storage · System at 90%", "Waits for its hours: 22:00–08:00", "Paused: 1 agent started today, the most per day", "Nothing in Next up an agent can run". The Agents place has one line, "Autopilot: Isokratis, Workbench", for the projects it's on for.
- **A run that breaks doesn't loop:** an item whose last autopilot run failed or was stopped isn't picked again. It shows under Stuck; once you run it yourself, it's back in the queue. The next item goes meanwhile.
- **Where it runs:** the board looks every 2 s, where it sends unblocked work; the cloud board when its computer helper ticks (every minute while autopilot is on), and at once when you turn it on. Turning it on is allowed where starting agents is (this computer, a paired phone when Settings allows); `PUT /api/projects/<slug>/autopilot {"on": true}`.

### The agent session in the reader

While a run goes, its card says "agent running · 4 min", and the item's agent session (at the top of the reader while it runs, below the brief after) shows what it does as it comes:

- what it says, and each tool call in a line (with a small sign for edit, run, read, search and the board's tools); errors in red with what was refused; the result at the end. The last 12 show, with Show all. It follows the bottom unless you scrolled up.
- the header: running, finished, failed or stopped, how long, what it cost at API prices, and where it ran (its worktree). With several runs on the item, #7 · #6 · #5 look at an earlier one ("continues #6").
- the item's history gets a line when it starts and when it ends.

Above its buttons, one quiet line says what the item's runs start with ("Opus · high · Auto", or "Board defaults: Auto"): see [Model, effort and mode](#model-effort-and-mode).

Its buttons:

- **Stop:** the agent and everything it started.
- **Move to Claude Desktop** (while it runs, once its session is known): the agent stops here and carries on in Claude Desktop. See below.
- **Open in Claude Desktop:** see below.
- **Copy resume command:** `cd <folder> && claude --resume <session>`.
- **Continue:** carry on in the same session with your message. See below.
- **Restart:** a fresh session.

**Continue** is in the reader's one reply box: on an item whose last run ended with a session, a **send to the agent** tick (Tell the agent… ticks it and puts you there). What you write goes to the agent, and it's in the history as yours. A new run resumes that run's Claude Code session with your message as the prompt, in the folder the session ran in (its worktree), so the agent carries on with what it knows.

- Allowed on any item, a done one too (a follow-up), within the limits; refused while that session, or any run on the item, still runs. The new run's first event is what you sent. From a terminal: `wb continue <run> "message"`.
- **The command** for it is made from the start command below, word by word as the shell splits it and never inside quotes: `--session-id <id>` becomes `--resume "$WB_RESUME"` (before `-p`), and `-w` / `--worktree` with its name (and `--tmux`) go, since the session has its worktree. A command with more than one plain command in it (a pipe, `&&`, `;`, a redirection, `$(…)`) gets none made. Then the setting `agents.continue-command` has to be set, and when set it's used anyway.
- On the cloud board, a computer whose app is older than 0.5.0 can't continue a session: it says "Update the Workbench app on <computer> to continue sessions from the board."
- While the run still goes, the same box sends the message to it at once ([While it runs](#while-it-runs)).

### While it runs

Two things reach a run before it ends. Each is a flag the board puts at the end of the run's command, word by word as for the [model, effort and mode](#model-effort-and-mode), only when the command can take it; the run's line in the API says which (`live`: `ask`, `tell`).

**Permissions on the board** (Settings → Agents → "Ask me on the board when an agent needs a permission", on by default). A tool call its mode would refuse (Auto's checks blocking it, Accept edits on a command, Don't ask on anything not allowed) asks you instead:

- In its agent box, at the top of the Inbox ("wb-k3f9 wants to run Bash" with the command in full) and as a notification, with **Allow**, **Allow Bash for this run** (that tool, for the rest of the run) and **Deny**. A paired phone can answer: that's the point of it. It never allows a new command on a computer.
- **Nobody answering within 10 minutes is a no**, which is what the mode would have said anyway, and the run's later asks are a no at once: a run nobody watches waits once at most. Nothing is filed as an item. Your answer is a line in the item's history ("Allowed Bash: npm publish (run #12)").
- **How:** `--permission-prompt-tool mcp__wb__permission`. Claude Code calls the board's MCP tool `permission` with the tool's name and input, which waits for the answer and says allow (with the input as it came) or deny (with why). The tool is listed only to a run the board started (its `wb mcp` has `$WB_RUN`), so other sessions' tool lists stay the same size. Through `wb mcp`'s relay, it's asked on the cloud board and waited for in short polls.
- **The command takes it** in print mode (`-p`), with the board's server named `wb` in it (`--allowedTools mcp__wb`, as the default has), and no prompt tool or Bypass permissions of its own.

**Messages to a running agent.** "Tell the agent…" (the reply box's send to the agent tick) on a run that's going writes your message to its stdin: it's in the run's events as yours as soon as Claude Code reads it (after the tool call it's in), and in the history. Once the run has ended, the same box continues its session as above, so you needn't know which.

- **How:** `--input-format stream-json --replay-user-messages`. The run's stdin is a named pipe next to its log, read by a small feeder in the run's own shell, so it outlives the board (a restarted board opens it again) and nobody writing never holds the run up. Its prompt is the first line. When the agent's turn ends, the board closes it, and Claude Code finishes as before; a message after that is a Continue. Only Claude Code's own user message goes in, made from your words.
- **The command takes it** in print mode with `--output-format stream-json` and no `--input-format` of its own. Not on Windows (no named pipes there): a message waits for the run to end, as before. `agents.tell` false turns it off.
- On the cloud board it goes to the computer that runs it (the helper job `tell`). A computer with an older app runs its agents as before, and says "Update the Workbench app on <computer> …" when asked for more.

**Restart:** Run works again on an item whose last run failed or was stopped (doing, or waiting on nothing), or that has sat doing with no sign of life for a day. A fresh session, and the history says "Agent restarted (run #n): run #m had failed". Never while a run is on it.

**Open in Claude Desktop:** a run is a headless Claude Code session, which Claude Desktop doesn't list by itself. Once a run has ended, its `claude://resume?session=<id>` link, opened on any computer with Claude Desktop (the cloud board's too), imports the session under the item's title and opens it, to read or carry on. An item whose `session` is a Claude Code session (a UUID) or a Desktop one (`local_<uuid>`, which `start_item` records) has the link too.

**Move to Claude Desktop:** on a run that's going. It stops the run the way Stop does (Claude Code ends the turn, and its transcript has everything so far), then the page opens the link above on the device it's on. The run shows "moved to Desktop": not failed, nothing to restart, and the item stays as the agent left it, since the work goes on in Desktop. The history says "Agent run #n moved to Claude Desktop after …". Desktop opens a moved session in its own default mode, which you set in Claude Desktop's settings: the board can't choose it there.

### Model, effort and mode

What a run starts with: Claude Code's `--model` (Fable, Opus, Sonnet, Haiku), `--effort` (low, medium, high, extra high, max) and `--permission-mode` (Auto, Accept edits, Plan only, Don't ask, Bypass permissions; no Manual, since nobody is there to answer).

- **Where it comes from**, first that says: `wb run <ref> --model opus --effort high --mode plan` (that run only), the item's own choice, Settings → Agents → **Agents start with**, else the command as it is. An untouched board runs its command unchanged.
- **The item's choice:** the line in its agent box opens three small selects; a change is saved at once and holds for every run on it from then on (Run, Answer & send, a restart, Continue, Merge it, and work sent when it's unblocked). "Board default" puts one back; "Claude Code's default" leaves the model or effort out. Bypass permissions is chosen only on the board on this computer.
- **How it gets in the command:** word by word as the shell splits it, never inside quotes: the flag's value is replaced where the command has it, or the flag goes in right after the program. A command with more than one plain command in it (a pipe, `&&`, `;`, …) can't take them: the run is refused, saying to set them in the command itself.
- **What a run used** shows on its line ("#12 · 5 min ago from this computer · Opus · high · Auto"), in Settings → Agents → Recent runs, `wb runs`, and the history's "Agent started" line when it differs from the command.
- **On the cloud board** the computer runs a command with a model, an effort or a mode other than Bypass permissions put in the command it allowed, without a new OK. Bypass permissions is a command of its own there, which waits for a yes on the computer.

**Tools it was refused:** a run counts the tool calls its permissions refused ("Edit ×4, Bash ×6"). The item, Settings → Agents → Recent runs and the run's end line in the history say so, and its card shows "agent refused tools" for two days.

**Nothing left parked:** an item a run leaves doing, or waiting on nothing, goes back to to-do with a line saying so. One waiting on an item (a check, a decision for you) stays waiting and comes back when that's dealt with.

### The start command

A setting: `claude -p "$WB_PROMPT" --output-format stream-json --verbose --permission-mode auto --allowedTools mcp__wb -w --session-id "$WB_SESSION" --name "$WB_TITLE"`, run with bash and your shell's PATH.

- `auto` lets the agent edit files and run commands, with Claude Code's own checks refusing what looks risky (nothing is asked: nobody watches). The board's tools are always allowed. A model, effort or other mode from Settings or the item goes into it as above.
- `-w` puts it in a git worktree of its own on a new branch (`.claude/worktrees/` in the project), so your checkout isn't touched. The prompt tells it to commit there, name the branch when it finishes, and merge only if the project's rules say so.
- For less, `--permission-mode dontAsk` allows only what your Claude Code settings already allow (`permissions.allow` in `~/.claude/settings.json` and the project's `.claude/settings.json`). `--max-budget-usd 5` caps one run.
- The cloud board's computer helper asks for an OK on the computer before it runs a new command ([cloud.md](cloud.md)).
- **Test the command** asks the program for its version and its flags only: no agent starts. Settings → Agents shows what the agent is told.

**It outlives the board:** a run is its own process, writing to a log the board reads every 2 s. A restarted board picks the run up again. A run whose process is gone (the computer restarted, it was killed) is closed as failed.

**From a terminal:** `wb run <ref>` (`--model`, `--effort`, `--mode` for that run; `default` for Claude Code's own model or effort), `wb land <ref>` (Merge it), `wb runs` (also closes runs that ended while the board was off), `wb continue <run> "message"`, `wb stop <run>`. `wb show` and `get_item` show the item's latest run.

## The landing desk

Finished agent work whose branch isn't merged settles by itself. A pass on the computer (on the cloud board, the computer helper's `landing` job) looks at each item under Ready to land, per project, with the project's own git, only reading:

- **Landed:** its branch is merged into the main branch (or the integration branch the project's folder is on), or the branch is gone and a commit there names the item in its subject ("… (wb-xxxx)"), or the branch is still there with nothing on it that isn't in main already. It leaves Ready to land; one found by a commit naming it gets "Landed: found in main as <sha> <subject>" in its history, once.
- **Lost:** the branch is gone (here and on origin as fetched) and nothing in main names the item. It's shown apart, with **Ask the agent** and **Drop**.
- **Ready:** the branch is there and not merged. It gets what it changes (commits ahead, files, lines, the last commit) and whether it merges into main without conflicts (a trial `git merge-tree`, whose objects go to a temporary folder, never the repo). **Land N clean** starts Merge it for those.

It costs one `git log --grep` per project for every item at once, and a few git calls per branch that still exists. It runs when the Agents place loads (kept 2 minutes) and once a day by itself: on a computer from the board's hourly look, on the cloud board from the helper's tick. The reader of an item that's ready lists every file its branch changes (`GET /api/items/:id/diff`, the helper's `diffstat` job). An app from before this can't do either job: the Agents place says to update it there.

## Merge it

**Merge it**, on an item under Ready to land (`wb land <ref>`), starts a board run whose job is to land that item's branch. It's a run like Run's, with the same limits, command and computer helper, recorded on the item as a run of kind `land`, and the history says "Agent merging <branch> into <main> (run #n, from …)".

- Allowed on a done agent item with a branch the board doesn't know to be merged already (an unknown git state goes ahead: the agent finds out), with no run on it.
- The agent is told to read the item, merge the branch into the main branch the way the project's own rules say (its CLAUDE.md or AGENTS.md: some projects merge locally, some open a pull request), run the project's checks, never force-push, add a note saying what landed where, and, when it can't, file what it needs from you as its own item.
- The item stays done. A merge run that fails or is stopped puts it under Stuck, with Merge it again.
- **What counts as merged:** a merged pull request naming the item, a branch that's no longer among the unmerged ones, or what the landing desk found landed. A branch git doesn't have here, which the landing desk hasn't looked at, is "not known", never merged.
- **Git state** is read per project (unmerged branches, worktrees, commits and pull requests that name items), at most every 30 s (90 s for the ones that ask `gh`). On the cloud board it's what the computer helper last sent, and the Agents place says when that's old or missing.
