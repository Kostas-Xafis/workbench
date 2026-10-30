# Workbench

One board for every project: tasks agents are doing or will do, and the checks, reviews, decisions and setup steps that wait on Kostas. Bun + SQLite, no dependencies.

```bash
wb open        # start the board if needed and open http://localhost:4321
wb ls --mine   # what waits on me, in the project of the current folder
wb help        # everything else
```

- **Data:** `workbench.db` next to this file (gitignored). Back it up by copying it (`sqlite3 workbench.db ".backup backup.db"` while the server runs).
- **Projects:** `wb project <slug> <path> "Name"`. Items added from inside that path belong to it; the board shows each project's git state (uncommitted files, unpushed commits, unmerged branches, worktrees).
- **Agents** use the same `wb` command; the rules they follow are in each project's AGENTS.md ("Docs and tracking"). `wb start` records the desktop-app session, and the item's dialog links back to it.
- **From the phone:** `wb serve --lan` listens on the LAN. There is no login, so only do that on a network you trust.
- **Start on login** (optional): a user service.

```ini
# ~/.config/systemd/user/workbench.service
[Unit]
Description=Workbench board

[Service]
ExecStart=/home/kostas/.bun/bin/bun /home/kostas/Projects/workbench/server.ts
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now workbench`.
