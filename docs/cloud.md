# The cloud board (sync)

The board can live on Cloudflare instead of this computer. It's off by default. Once it's on, the page, the API, the MCP server, phones and the desktop app all use the cloud board, and nothing reads or writes this computer's database (it stays as it was).

It's the same board: the Worker in `worker/` runs the board's own code (`src/`, `ui/`), with the database in a [SQLite Durable Object](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Turning it on

Once, from `worker/` (it runs on your Cloudflare account, on the Workers Paid plan):

```bash
cd ~/Projects/workbench/worker && bun install
bunx wrangler login                  # if wrangler isn't signed in to your account yet
bun run deploy                       # prints the address: https://workbench.<you>.workers.dev
bunx wrangler secret put WB_OWNER_KEY   # type a long random key: what gives a computer its first device
```

Then, on the computer whose board goes up:

```bash
wb sync on https://workbench.<you>.workers.dev --key <the owner key>
```

- **An empty cloud board gets this computer's board:** every table but the paired phones, row by row with its ids, so refs, links, history, reports, pictures and the vault (still encrypted) stay what they were. Every table's count is checked at the end.
- **A cloud board that already has items is used as it is.** A second computer that runs `wb sync on` gets a device and uses the cloud board; its own board stays untouched. `--replace` sends this computer's board up anyway, over the cloud board's.
- **A second computer without the owner key:** `wb sync on <url> --code XXXX-XXXX`, with a code from `wb sync pair` or Settings → Data on a device that's already on the cloud board.
- **Afterwards:** restart the desktop app (and the board's service, if it runs). `wb sync status` says where the board is.

## Using it

- **Phones and browsers** pair once, from anywhere: `wb sync pair` prints a code and the link that takes it, or Settings → Data → Pair a phone. The phone keeps a cookie for 400 days, renewed whenever it opens the board.
- **Installing on an Android phone:** open the cloud board in Chrome once paired, then ⋮ → **Install app**. It gets its own icon and window. The cloud board is on https, which Chrome needs for this and for notifications.
- **Push notifications on a phone:** Settings → Notifications → turn Notifications on and allow them in Chrome. The cloud board then sends them itself, with the board closed, as chosen there, with that phone's quiet hours in its own time zone. None comes for a change made on that phone, or while the board is on its screen. Tapping one opens what it's about. Each device turns them on for itself; removing a device in Settings → Data stops its notifications. The keys are the board's own (Web Push with VAPID, made on first use): no Firebase or other account. The desktop app keeps its own notifications.
- **The desktop app** opens the cloud board in its window and signs in by itself. Behind the window it runs the computer helper (below).
- **Agents** keep `claude mcp add -s user wb -- wb mcp`. While this computer syncs, `wb mcp` relays every call to the cloud board with this computer's token, the project of the folder it starts in, and the desktop-app session it runs in. A picture given as a file path is read here and sent along.
- **The `wb` commands** run on the cloud board, by the same code as on a computer, so they print what they print there. `wb` sends the args, the folder it runs in and the contents of the files a command names (a report's page, an `.svg` icon, a picture, a JSON import: up to 16 MB in all). A file a command writes (`wb image save`) is written here. `wb run`, `wb land`, `wb runs` and `wb stop` work too; the agent starts on a computer whose helper is online.
- **What stays on the computer:** `wb backup`, `wb backups`, `wb day` (git) and `wb integrate` (the project's folder) need this computer's own board. While it syncs they say so and what to use instead.
- **Data sources** (`wb.fetch`) work on the cloud board with no computer online. It can't read a computer's key file, so it seals the headers with its own key, from a Worker secret: `WB_SOURCES_KEY` if you set one (`bunx wrangler secret put WB_SOURCES_KEY`), else the owner key. `wb sync on` seals this computer's sources again with it; `wb sync sources` does it later. `wb source add` works while syncing. `wb sync off` seals them again with this computer's key file on the way down. Changing the owner key (or `WB_SOURCES_KEY`) leaves the sources unopenable: add them again.
- **The local server** (`wb serve`, the service) doesn't serve a board while this computer syncs: every page says "The board is in the cloud" with the link. It only runs the computer helper.

## The computer helper

The cloud board has no computer. What needs one is done by a **helper on a computer that syncs**. The local server's process runs it, so `wb serve`, the service and the desktop app all carry it, with nothing to set up. One per computer (the process that has port 4321).

- **How it gets through:** an outbound, [hibernatable](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) WebSocket to the cloud board, signed in with this computer's device token. Where a WebSocket won't stay open, it polls over https.
- **Jobs:** the cloud board keeps a queue. Each job goes to one helper that's online and has the project's folder, so several computers can sync. With none online, the board says: *No computer is online to do it. Open the Workbench app, or run wb serve, on a computer that syncs with this board.*
- **The split:** the helper runs the board's own code for each job (dispatch, trackers, git, logos, usage, health). The cloud board runs the rest: Run's checks and limits, answering the ask, the run's row and its notes, tracker history.
- **New commands wait for an OK on the computer.** On the cloud board any paired device may change a tracker's command or the command that starts agents, which on a computer only its own board may. So a computer runs a command only once it's allowed there: the ones it had when its helper first started, and each new one after **Allow** in a window on that computer (or `wb helper allow`). Until then the board shows "… waits for an OK on <computer>". `wb helper` lists the computers online and the commands waiting for an OK here.

| What | On the cloud board |
| --- | --- |
| Agents the board starts (Run, Answer & send, Send it, `wb run`) | Start on a computer that has the project's folder. Output and events stream back, and Stop stops them there. Continue goes to the computer the session ran on, or one with the project's folder. |
| Trackers that run a command (and the presets) | Read on a computer when due, and with Refresh |
| Git state, commits and pull requests | From the project folders on a computer (and its `gh`), kept on the board for when none is online. The Agents place says how old it is or what's missing |
| Whether an agent is alive | As on a computer: the relay and `wb` send the session to the cloud board |
| The vault's password window for agents | `wb mcp` answers itself: the window opens on the computer where the agent runs, and the `.env` file is written there. The cloud board hands over the sealed secrets and keeps the log |
| Usage, what agents cost today, logos, project folders, Add project's suggestions, Test the command | From a computer |
| Health, the setup guide | Not shown: they check the computer the board runs on |
| Sharing a report through a tunnel | Not available |
| Backup files, Compact | Cloudflare keeps 30 days of every change ([point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)). Export still downloads everything as JSON |

A paired device may do what the board's page on the computer may (Settings, projects, the vault), since there is no "this computer" in the cloud. Old report versions, readings and closed items are tidied once a day, as Settings → Data says. Asks past their deadline go ahead on the next request.

## Turning it off

```bash
wb sync off
```

The cloud board's rows come back down into a new database, which takes the place of this computer's. The one from before sync was turned on is kept next to it as `workbench-before-sync-off-<time>.db`. This computer's device is removed from the cloud board, which otherwise stays as it is. `--keep-local` skips the download and goes back to this computer's board exactly as it was. Restart the desktop app and the service afterwards.

## Security

- **Getting in takes a device token.** The first comes from the owner key (the `WB_OWNER_KEY` secret; 10 wrong keys in 10 minutes and it waits). Later ones come from a one-time pairing code (10 minutes, one device) or a one-time login ticket (one minute) that a device makes with its own token. The board keeps only a hash of each token. Settings → Data lists the devices and removes any of them at once.
- **Browsers** carry the token in an `HttpOnly; Secure; SameSite=Strict` cookie; `wb`, the MCP relay and the app send `Authorization: Bearer`. Writes are JSON only, and `/mcp` and the sync calls refuse any `Origin`. Everything goes over https. This computer's token is in `workbench.db.sync.json` next to the database (mode 0600, outside git).
- **The vault's secrets** go up encrypted, as they're kept: only your password opens them.

## How it works

The Worker's one Durable Object, `Board` (`worker/src/board.ts`), runs the board's own schema and route table (`src/routes.ts`, shared with `server.ts`) on its SQLite, and adds the gate, the owner key, login tickets and `/api/sync/*`. `worker/src/helper.ts` is the cloud side of the computer helper; `src/helper.ts` is the helper on a computer. `src/sync.ts` is the sync format and `wb sync`. `src/cli.ts` holds the board-data commands as a function of args, database, folder and an output sink, so `wb.ts` runs them on a computer's database and `POST /api/sync/cli` on the cloud board's. The page gets `<html data-cloud="1">`, which `ui/core.js` reads as `CLOUD`. Push notifications are decided after every write (`worker/src/push.ts`) and sent with Web Push (`webpush.ts`; `ui/sw.js` shows them). A report page over a million characters keeps the rest in `report_parts`.

## Development

```bash
cd worker && bun install
bun run dev                          # the cloud board on http://localhost:8787, its data in worker/.wrangler/
bun test                             # the cloud board's tests, on a local Worker they start and stop
cd .. && WB_TEST_SQL=durable-object bun test   # the board's own tests, on the cloud board's SQLite
```

- **A key for `bun run dev`:** put `WB_OWNER_KEY=<anything>` in `worker/.dev.vars` (outside git), then `WB_DB=<a copy> wb sync on http://localhost:8787 --key <it>` tries a whole board on it. Make the copy with `sqlite3 workbench.db ".backup /tmp/copy.db"`, never the real file.
- **Deploying** is by hand, never on a push: `bun run deploy` in `worker/`, or Actions → Cloud board → Run workflow, which checks first. That needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The cloud board and `wb` check they speak the same sync format (`SYNC_FORMAT` in sync.ts).
