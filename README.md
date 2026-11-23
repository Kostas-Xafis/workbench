# Workbench

One board for every project: tasks agents are doing or will do, and the checks, reviews, decisions and setup steps that wait on Kostas. The board is a Bun server with SQLite and no runtime dependencies; the desktop app is optional.

```bash
wb open        # start the board if needed and open http://localhost:4321
wb ls --mine   # what waits on me, in the project of the current folder
wb help        # everything else
```

## Install

**The desktop app:** download the `.deb` or the AppImage from [Releases](https://github.com/Kostas-Xafis/workbench/releases) (`sudo apt install ./Workbench_<version>_amd64.deb`). It runs the board itself and updates itself ([desktop-app.md](docs/desktop-app.md)).

**From source**, with [Bun](https://bun.sh):

```bash
git clone https://github.com/Kostas-Xafis/workbench ~/Projects/workbench
cd ~/Projects/workbench && bun install
```

Put `wb` on your PATH with a small launcher, then give Claude Code the board's MCP server:

```bash
mkdir -p ~/.local/bin && printf '#!/bin/sh\nexec bun %s/src/wb.ts "$@"\n' "$PWD" > ~/.local/bin/wb && chmod +x ~/.local/bin/wb
```

```bash
claude mcp add -s user wb -- wb mcp
```

A new board opens the setup guide by itself: your name, your first projects, the agents' rules for each project, notifications and start on login.

## Documentation

| Page | What's in it |
| --- | --- |
| [Using the board](docs/board.md) | Items, layout, asks that don't block, goals, rulings, checks on the phone, Today, one at a time, phones, your data, start on login |
| [Settings](docs/settings.md) | Every Settings tab and where each setting is kept |
| [Agents](docs/agents.md) | Setting a project up for agents, the MCP server, agents the board starts |
| [Reports](docs/reports.md) | Report pages, the `wb` object they get, sharing a link, data sources |
| [Status trackers](docs/trackers.md) | Live readings in the sidebar: by hand, from a command, built in |
| [Secrets vault](docs/vault.md) | The vault, and how agents ask for secrets |
| [Desktop app](docs/desktop-app.md) | The app's window, tray, updates and where it keeps things |
| [The cloud board](docs/cloud.md) | The board on Cloudflare instead of this computer (`wb sync on`), optional |
| [Development](docs/development.md) | The folders, the board's page, tests, nightly builds, releases |

## Folders

```
src/         the server, the wb command and the MCP server (TypeScript, run by Bun)
ui/          the board's page: index.html plus one .css and .js per part, no build step
test/        bun test
scripts/     nightly builds and releases
src-tauri/   the desktop app (Rust)
worker/      the cloud board: a Cloudflare Worker running the same board (optional)
examples/    report pages to start from
docs/        the pages above
```

The board's data is `workbench.db` at the top of this folder, with daily copies in `backups/`. Both are kept out of git.
