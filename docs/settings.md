# Settings

Settings, at the bottom of the projects strip on the left (or `#settings`, and `#settings/<tab>` for one tab), opens the workbench's settings, in five tabs: **Projects, Agents, Notifications, Data** and **About**. Old addresses still land where the setting is now: `#settings/start`, `health`, `you`, `look` and `updates` open About, and `#settings/privacy` opens Data. Each setting says where it's kept:

- **This board:** in the workbench's database, the same in every browser and for `wb` and agents. These change only from the board on this computer, at localhost (`GET /api/settings` reads them, `PATCH /api/settings` changes them).
- **This browser:** in this browser only, so your phone and your computer can differ.

A changed setting shows **Default**, which puts it back. Under `wb serve --lan` the phone opens Notifications and About (the theme only), and gets a note for the tabs that change the board or look at this computer. Less-used sections are folded: they open with a click and the page remembers which.

**Projects:** every project in the order they sit down the left edge.

- **Add project:** a folder, a name and a slug. Git repositories next to the projects you have (and in `~/Projects`) that aren't on the board yet are offered with one click. The folder must exist.
- **Edit** (the pencil): name, folder (when a repo moves) and logo (a file in the repo; empty = look for one). The slug can't change, because items, reports and links point at it.
- **Order:** the arrows on each row move it up or down the left edge.
- **Archive:** a finished project leaves the left edge and "All" (its items, reports, links and repository), and its trackers stop reading by themselves. Search still finds its items and reports, and its secrets stay in the vault. It waits under "Archived", where Unarchive brings it back; so does any new open item for it (from `wb add`, an agent or the board), so new work never goes somewhere nobody looks. From a terminal: `wb project <slug> --archive` / `--unarchive`.
- **Remove:** only for a project nothing points at (no items, reports, links, secrets, trackers or data sources), e.g. one added by mistake. Its folder isn't touched.

Adding, editing, reordering and removing projects are accepted only from the board's own page on this computer, like data sources: a project's folder decides where git and tracker commands run.

**Agents** (on this computer only). First what agents may ask of you, then the board starting agents.

- **Open asks per project:** how many open decisions, reviews, checks and setup steps from agents a project takes (default 20; 0: no cap). See [Asks that don't block](board.md#asks-that-dont-block).
- **A default goes ahead after:** how many days an ask with a default waits when the agent gives no date (default 3; 0: only on a date the agent gives).
- **Agents may ask for secrets** (on by default): agents ask through the vault's password window; off, every request is refused.
- **Who gets new items** (folded): for each kind, whether a new item goes to you or to an agent when nobody says: on the New button, from agents (`add_item`) and from `wb add`/`wb import`. By default decisions, setup, checks, reviews and notices go to you, and bugs, tasks and ideas to agents. Items already on the board stay with whoever has them.
- **Starting agents:** whether the board may start Claude Code agents (off by default), from a paired phone too (off), what happens when an agent's work is unblocked (tell me, or send it), how many at once (1), per day (5) and a day's cost cap (none), the command with Test the command and what the agent is told, and the recent runs with Stop. See [Agents the board starts](agents.md#agents-the-board-starts).

**Notifications** (this browser; works from the phone too). The switch is the bell above the board. It shows whether the browser allows notifications and, when it doesn't, how to change that; over plain http, as from a phone on your network, browsers don't offer them at all (they need localhost or https).

- **What to tell you about:** a switch each for something new that needs you, an agent finished, an agent got stuck (waiting), an agent can carry on (what it waited on was answered or finished), reports added or updated, and status trackers that start to warn, turn bad or stop reading. "Everything" and "Only what needs me" (needs you and stuck agents) set them in one click.
- **Quiet hours:** from and until (22:00 to 08:00 by default; an end earlier than the start means the next morning), and optionally all weekend. Nothing pops up meanwhile; when quiet hours end, one notification sums up what happened ("While you were away: 3 things need you · 1 finished by an agent"), unless you're already looking at the board.
- **Send a test notification** shows one right away.

**Data** (on this computer only): the database and its copies, then who can get at the board and what is kept private (those sections are folded).

- **Backups:** every backup, newest first, with its date, age and size, the total and the folder, and how many to keep (1–90, default 14: the nightly backup, "Back up now" and `wb backup` all keep that many). **Download** saves one. The board can't swap its own database while it runs, so **Restore** shows the commands for this computer: stop the board (the user service, if that's how it runs), keep the current database next to it, copy the backup over it, remove the WAL files, start it again. Anything changed since that backup is lost from the board.
- **Export everything:** one JSON file (`workbench-export-YYYY-MM-DD.json`, the same as `wb export`): projects, items with notes and images, links, reports with every version, saved report inputs, trackers with history, board settings, and data sources by name, base URL and header names. Left out: the vault and its secrets, header values, and link icons.
- **Database:** its size on disk, the counts that explain it (items, notes, images, report versions, tracker readings, link icons), and **Compact**, which gives back the room removed things left behind (the board waits while it runs).
- **Keeping things tidy:** report versions kept per report (0 = all, the default; the latest always stays), readings kept per tracker (100–10000, default 2000), and done or dropped items removed with their notes N days after they close (0 = never, the default; else 30–3650). Each row says what it would remove right now. They're applied every night right after the backup, and as soon as you change one, after asking and making a backup first.

- **Vault:** whether it's set up, how many secrets it holds and when the password was last set. **Change password** unlocks the vault, then asks for the new password and encrypts every secret again. **Lock after** (1–60 idle minutes, default 5) and **Hide a shown value after** (5–120 seconds, default 20) take effect at the vault's next timer. For a forgotten password, `wb vault reset --yes` deletes the vault and every secret in it.
- **Sharing:** **Longest a link can run** (1, 2, 4, 8, 12 or 24 hours, counting extensions; default 8) and **New links start at** (what the share dialog picks first, never more than the longest; default 1). Lowering the longest doesn't cut a running link short; it just can't be extended past it. **Live links** lists every report shared right now: project, version, the link (Copy, Open), when it ends, **Extend by 1 hour** (off at the limit) and **Stop**, plus **Stop all**.
- **Phones:** **Pair a phone** shows the QR code, the code, until when it works, the board's address for typing it in, **New code** and **Cancel**; when a phone pairs, it says so and the phone joins the list. The paired phones, each with when it paired, when it was last seen and from which address, **Remove** and **Remove all**. With the board off the network, how to turn it on.
- **Who can reach what:** whether the board listens on your network (`--lan`, for paired phones only) or only this computer, and what answers only this computer (the vault, data sources, changing settings, starting shares), that reports run sandboxed, and that other websites can't change the board.
- **Data sources:** every project's sources (name, project, base URL, read-only or read and write, the header names but never their values) and whether the key file exists. Remove one with `wb unsource <name> --project <slug>`.

**About.**

- **You** (on this computer only):
  - **Your name** (default Kostas): what the board, `wb help` and `wb show`, the MCP server's instructions and tool texts, and day pages call you. Items for you are still `kostas` in commands and the API (`--owner kostas`, `owner: "kostas"`).
  - **A work day starts at** (default 05:00): when "today" turns over for day pages and `wb day`; work before that hour counts as the day before. It applies from the next day page on; pages already made keep their hours.
- **Look** (this browser; works from the phone too): the **theme**, Light, Dark or System; reports and day pages opened on the board follow it, share links and reports opened on their own follow the system. In the app, **Zoom**. **Keyboard shortcuts** (folded): the board's shortcuts (Ctrl K, or ⌘ K on a Mac, /, Esc and the rest), for reference.
- **Setup guide** (folded; this computer only): the guide's steps, each with what its check finds right now, a button into the guide at that step, and whether "Finish setting up" shows on the board.
  - **Checked, not assumed:** your name counts once it's saved; projects once there's one; agents once an MCP client has called the board (both `wb mcp` and the board's `/mcp` note the last call, per transport, at most once a minute), not merely when Claude Code has the server; each project's rules as Settings → Projects reads them; notifications and the app's start on login on the device you're on. "How the board works" counts once read.
  - **When it opens by itself:** once, on a board with no projects or fewer than 10 items. What it remembers (when it was first shown, skipped steps, the checklist hidden or finished) is the board setting `setup`.
- **Updates** (folded; this computer only):
  - **In the app:** the app's version and how it's installed (AppImage, .deb, built from source), when it last checked and what it found, **Check now**, **Check automatically** (at launch and every 6 hours; kept by the app), the skipped version with **Stop skipping**, and the board server's version, saying when it's older or newer than the app and how to update it.
  - **In a browser:** this board's version and how it runs (from source in a folder, the service, the standalone server), **Check now**, and **Check for new releases once a day** (This board, off by default: the board doesn't go online by itself unless you turn it on). A newer release shows in the board bar as in the app, with its notes, **Later**, **Skip this version**, and the commands that update this board: `git pull` in its folder and a restart, or the new standalone server from the release page. The newest release is read from the same `latest.json` the app uses; the last answer is kept in `update-check.json` next to the database.
- **Health** (folded; this computer only; its problem count shows beside About in the tab list): checked when Settings opens and with "Check again". Each line says what the board uses it for, whether it works, and the command that fixes it when it doesn't:

  - **git** (repository state, commits on items), **GitHub CLI** (pull requests on items; signed in, and the `user` scope when there's a GitHub Actions tracker), **cloudflared** (sharing a report; the install steps for this system when it's missing), **EAS CLI** (only when there's an EAS builds tracker or `eas` is installed).
  - **Backups** (the newest one's age), **status trackers** that can't read (with a button to open each), **project folders** that are gone or aren't git repositories, and the **data sources key** when there are data sources.
  - **Agents (MCP):** whether Claude Code has the workbench's MCP server (user scope, from `~/.claude.json`), and both `claude mcp add` commands to copy.
  - **Phone:** whether the board listens on the network; when it does, its addresses, how many phones are paired and **Pair a phone** (it opens Data with a code showing). When it doesn't, how to turn it on (for the user service: add `--lan` to its `ExecStart`).
  - **Start on login:** whether the user service is installed, enabled and running; the unit and the commands to install it when it isn't, and the restart command when it is.
  - **This board:** port, how long it's been running, Bun's version, where the database and backups are.

  Tools are looked up on your shell's PATH (like tracker commands), so the board finds what your terminal finds even when it runs as a service. Pull requests on items are read with that PATH too.

**Gone:** the Density setting, the order of the kind sections and "the board opens on" were removed with the board sorted by kind; a saved value is ignored.
