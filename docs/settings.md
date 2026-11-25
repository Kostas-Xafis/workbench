# Settings

Settings is at the foot of the nav (`#settings`, and `#settings/<tab>` for one tab). It has five tabs: **Projects, Agents, Notifications, Data** and **About**. Old addresses (`#settings/start`, `health`, `you`, `look`, `updates`) open About, and `#settings/privacy` opens Data.

Each setting is kept in one of two places:

- **This board:** in the database, the same in every browser and for `wb` and agents. These change only from the board on this computer, at localhost.
- **This browser:** in this browser only, so your phone and your computer can differ.

A changed setting shows **Default**, which puts it back. Under `wb serve --lan` a phone opens Notifications and About (the theme only). Less-used sections are folded.

## Projects

Every project, in the order they sit down the nav.

- **Add project:** a folder, a name and a slug. Git repositories next to your projects (and in `~/Projects`) that aren't on the board yet are offered with one click. The folder must exist.
- **Edit** (the pencil): name, folder (when a repo moves) and logo (a file in the repo; empty looks for one). The slug can't change, because items, reports and links point at it.
- **Order:** the arrows on each row.
- **Archive:** a finished project leaves the nav and "All" (its items, reports, links and repository), and its trackers stop reading by themselves. Search still finds its items and reports, and its secrets stay in the vault. It waits under "Archived", where Unarchive brings it back. So does any new open item for it, so new work never goes somewhere nobody looks. From a terminal: `wb project <slug> --archive` / `--unarchive`.
- **Remove:** only for a project nothing points at (no items, reports, links, secrets, trackers or data sources). Its folder isn't touched.
- **Agent rules:** each project's rules as up to date, out of date, by hand or missing, with a button that copies the prompt ([agents.md](agents.md#setting-a-project-up-for-agents)).

Project changes are accepted only from the board's own page on this computer: a project's folder decides where git and tracker commands run.

## Agents

On this computer only. First what agents may ask of you, then the board starting agents.

- **Open asks per project:** how many open decisions, reviews, checks and setup steps from agents a project takes (default 20; 0: no cap). See [Asks that don't block](board.md#asks-that-dont-block).
- **A default goes ahead after:** how many days an ask with a default waits when the agent gives no date (default 3; 0: only on a date the agent gives).
- **Agents may ask for secrets** (on by default): through the vault's password window. Off, every request is refused.
- **Who gets new items** (folded): for each kind, whether a new item goes to you or to an agent when nobody says (on New, from `add_item`, from `wb add` and `wb import`). By default decisions, setup, checks, reviews and notices go to you; bugs, tasks and ideas to agents. Items already on the board stay with whoever has them.
- **Starting agents:** whether the board may start Claude Code agents (off by default), from a paired phone too (off), what happens when an agent's work is unblocked (tell me, or send it), how many at once (1), per day (5) and a day's cost cap (none), the command with Test the command and what the agent is told, and the recent runs with Stop. See [Agents the board starts](agents.md#agents-the-board-starts).
- **Agents start with:** the model (Claude Code's default, Fable, Opus, Sonnet, Haiku), the effort (Claude Code's default, low to max) and the mode (Auto, Accept edits, Plan only, Don't ask, Bypass permissions; each explained there). By default, what the command says. An item can have its own, in its agent box ([Model, effort and mode](agents.md#model-effort-and-mode)). Claude Desktop opens a moved session in its own default mode, which you set in Claude Desktop's settings.

## Notifications

This browser; works from the phone too. The bell at the foot of the nav is the switch. The tab shows whether the browser allows notifications and how to change that. Over plain http, as from a phone on your network, browsers don't offer them.

- **What to tell you about:** a switch each for something new that needs you, an agent finished, an agent got stuck, an agent can carry on, reports added or updated, and trackers that start to warn, turn bad or stop reading. "Everything" and "Only what needs me" (needs you and stuck agents) set them in one click.
- **Quiet hours:** from and until (22:00 to 08:00 by default; an end earlier than the start means the next morning), and optionally all weekend. Nothing pops up meanwhile. When quiet hours end, one notification sums up what happened ("While you were away: 3 things need you · 1 finished by an agent"), unless you're already looking at the board.
- **Send a test notification** shows one right away.

## Data

On this computer only: the database and its copies, then who can get at the board and what is kept private (those sections are folded).

- **Backups:** every backup, newest first, with its date, age and size, the total and the folder, and how many to keep (1–90, default 14: the nightly backup, "Back up now" and `wb backup` all keep that many). **Download** saves one. The board can't swap its own database while it runs, so **Restore** shows the commands for this computer: stop the board, keep the current database next to it, copy the backup over it, remove the WAL files, start it again. Anything changed since that backup is lost.
- **Export everything:** one file, the same as `wb export`, a row per line: everything on the board, the vault still encrypted ([board.md](board.md#your-data) has what's in it and how to import it).
- **Database:** its size, the counts behind it, and **Compact**, which gives back the room removed things left behind.
- **Keeping things tidy:** report versions kept per report (0 = all, the default; the latest always stays), readings kept per tracker (100–10000, default 2000), and done or dropped items removed with their notes N days after they close (0 = never, the default; else 30–3650). Each row says what it would remove right now. They're applied every night after the backup, and as soon as you change one, after asking and making a backup first.
- **Vault:** whether it's set up, how many secrets it holds, when the password was last set. **Change password** unlocks the vault, then asks for the new password and encrypts every secret again. **Lock after** (1–60 idle minutes, default 5) and **Hide a shown value after** (5–120 seconds, default 20) apply at the vault's next timer. For a forgotten password, `wb vault reset --yes` deletes the vault and every secret in it.
- **Sharing:** **Longest a link can run** (1, 2, 4, 8, 12 or 24 hours, counting extensions; default 8) and **New links start at** (default 1, never more than the longest). Lowering the longest doesn't cut a running link short; it just can't be extended past it. **Live links** lists every report shared right now with its link (Copy, Open), when it ends, **Extend by 1 hour** and **Stop**, plus **Stop all**.
- **Phones:** **Pair a phone** shows the QR code, the code, until when it works, the board's address for typing it in, **New code** and **Cancel**. Paired phones are listed with when they paired, when last seen and from which address, with **Remove** and **Remove all** ([From the phone](board.md#from-the-phone)).
- **Data sources:** every project's sources (name, project, base URL, read-only or read and write, header names but never values) and whether the key file exists. Remove one with `wb unsource <name> --project <slug>`.

## About

- **You** (this computer only): **Your name** (default Kostas) is what the board, `wb`, the MCP server's texts and day pages call you. Items for you are still `kostas` in commands and the API. **A work day starts at** (default 05:00) is when "today" turns over for day pages and `wb day`; work before that counts as the day before. It applies from the next day page on.
- **Look** (this browser): the **theme** (Light, Dark or System; reports and day pages opened on the board follow it, share links follow the system), **Show key hints** (off by default: the keys beside buttons and in hint lines, like Done M in an item; the shortcuts work either way, and a phone never shows them), **Zoom** in the app, and **Keyboard shortcuts** (folded), for reference.
- **Setup guide** (folded; this computer only): the guide's steps, each with what its check finds right now, a button into the guide at that step, and whether "Finish setting up" shows on the Inbox.
  - Each step is checked, not assumed: agents count once an MCP client has called the board, not merely when Claude Code has the server. It opens by itself once, on a board with no projects or fewer than 10 items.
- **Updates** (folded; this computer only):
  - **In the app:** its version and how it's installed, **Check now**, **Check automatically** (at launch and every 6 hours), the skipped version with **Stop skipping**, and the board server's version, with how to update it when it differs from the app's.
  - **In a browser:** this board's version, **Check now**, and **Check for new releases once a day** (off by default: the board doesn't go online by itself). A newer release shows next to New with its notes, **Later**, **Skip this version**, and the update commands: `git pull` and a restart, or the new standalone server.
- **Health** (folded; this computer only; its problem count shows beside About): checked when Settings opens and with "Check again". Each line says what the board uses it for, whether it works, and the command that fixes it when it doesn't.
  - **Tools:** **git** (repository state, commits on items), **GitHub CLI** (pull requests on items; signed in, with the `user` scope for a GitHub Actions tracker), **cloudflared** (sharing a report), **EAS CLI** (only with an EAS builds tracker). They're looked up on your shell's PATH, so the board finds what your terminal finds even as a service.
  - **Backups** (the newest one's age), **trackers** that can't read, **project folders** that are gone or aren't git repositories, and the **data sources key**.
  - **Agents (MCP):** whether Claude Code has the workbench's MCP server, and both `claude mcp add` commands to copy.
  - **Phone:** whether the board listens on the network, its addresses, how many phones are paired. When it doesn't, how to turn it on (for the user service: add `--lan` to its `ExecStart`).
  - **Start on login:** whether the user service is installed, enabled and running, with the unit and commands to install it, or to restart it.
  - **This board:** port, how long it's been running, Bun's version, where the database and backups are.
