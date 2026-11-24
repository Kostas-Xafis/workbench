# The cloud board (sync)

The board can live on Cloudflare instead of this computer. It's off by default, and nothing changes until you turn it on. Once it's on, everything goes over the network to the cloud board: the page, the API, the MCP server, phones and the desktop app all use it, and nothing reads or writes this computer's database. That database stays where it is, as it was.

It's the same board: the cloud board runs the board's own code (`src/`, `ui/`), with the database in a [SQLite Durable Object](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) (synchronous SQLite with real transactions, like the board's own, so the code runs there unchanged). The Worker is in `worker/`.

## Turning it on

Once, from `worker/` (the Worker runs on your Cloudflare account, on the Workers Paid plan):

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

- **An empty cloud board gets this computer's board:** every table but the paired phones, row by row with its ids, so `wb-` refs, links, history, reports, pictures and the vault (still encrypted by your password) stay what they were. Every table's count is checked at the end. About 300 MB took a few seconds locally.
- **A cloud board that already has items is used as it is:** a second computer that runs `wb sync on` gets a device and uses the cloud board, and its own board stays on it, untouched. `--replace` sends this computer's board up anyway, over the cloud board's.
- **A second computer without the owner key:** `wb sync on <url> --code XXXX-XXXX`, with a code from `wb sync pair` or Settings → Privacy and security on a device that's already on the cloud board.
- **Afterwards:** restart the desktop app (and the board's service, if it runs) so they switch over.

`wb sync status` says where the board is. `wb sync help` lists it all.

## Using it

- **Phones and browsers** pair once, from anywhere: `wb sync pair` prints a code and the link that takes it, or Settings → Privacy and security → Pair a phone. The phone keeps a cookie for 400 days, renewed whenever it opens the board.
- **Installing it on an Android phone:** open the cloud board in Chrome (once paired), then Chrome's menu ⋮ → **Install app** (or Settings → Notifications → Install). It becomes an app of its own, with its icon on the home screen and in the app drawer, opening in its own window; a long press on the icon offers Today and the queue. Nothing to set up: the cloud board is on https, which Chrome needs (a phone at the board on the home network, over plain http, can't install it or get notifications).
- **Notifications on a phone (push):** Settings → Notifications → turn Notifications on, and allow them when Chrome asks. From then on the cloud board sends them itself, with the board closed: something new needs you, an agent finished, got stuck or can carry on, reports, trackers, as chosen there, with that phone's quiet hours in its own time zone. None comes for a change made on that phone, nor pops up while the board is on its screen. Tapping one opens what it's about. Send a test sends a real one through the push service. Each device turns them on for itself; removing a device in Settings → Privacy and security stops its notifications. The keys are the board's own (Web Push with VAPID, made on first use): no Firebase or other account. The desktop app keeps its own notifications, and a board on a computer keeps popping them up while it's open, as before.
- **The desktop app** opens the cloud board in its window and signs it in by itself, with a one-time ticket from this computer's device token (nothing to type). Behind the window it starts its server for the computer helper (below), or uses the service's when that runs. Its tray count asks the cloud board. If the cloud board can't be reached, the window says so, with Retry.
- **Agents** keep `claude mcp add -s user wb -- wb mcp`. While this computer syncs, `wb mcp` relays every MCP call to the cloud board's `/mcp` with this computer's token, with the project of the folder it starts in as the default, as before, and the desktop-app session it runs in (`x-wb-session`), so `start_item` records it and the board counts its calls as signs of life. A picture given as a file path is read here and sent along.
- **`wb open`** opens the desktop app, or the browser signed in with a one-time ticket.
- **Agents from the terminal:** `wb run <ref>`, `wb land <ref>`, `wb runs` and `wb stop <n>` work on the cloud board; the agent starts on a computer whose helper is online.
- **The `wb` commands** (`wb ls`, `wb add`, `wb start`, `wb done`, `wb note`, `wb report`, `wb image`, `wb goals`, `wb rule`, …: everything `wb help` lists but the next line) run on the cloud board, by the same code as on a computer (`src/cli.ts`), so they print what they print there. `wb` sends the args, the folder it runs in (the board finds its project from the folders the projects keep) and the contents of the files a command names (a report's page, an `.svg` icon, a picture, a JSON import: up to 16 MB in all), and prints what comes back; a file a command writes (`wb image save`) is written here. Nothing lands on this computer's database. `wb help` shows the board's help.
- **What stays on the computer:** `wb backup`, `wb backups`, `wb day` (git) and `wb integrate` (the project's folder) need this computer's own board: while it syncs they say so and what to use instead.
- **Reports with live data** (data sources, `wb.fetch`) work on the cloud board, with no computer online. It can't read a computer's key file, so it seals the sources' headers with its own key, made from a secret of the Worker: `WB_SOURCES_KEY` if you set one (`bunx wrangler secret put WB_SOURCES_KEY`), else the owner key. `wb sync on` seals the sources this computer added again with it; `wb sync sources` does it later (for sources added while another computer was the one that synced). `wb source add` works while syncing: `{env:…}` and `{stdin}` are filled in here and the cloud board seals them. `wb sync off` seals them again with this computer's key file on the way down. Changing the owner key (or `WB_SOURCES_KEY`) leaves the sources unopenable: add them again.
- **The local server** (`wb serve`, the service, the app's sidecar) doesn't serve a board while this computer syncs: it answers every page with "The board is in the cloud" and the link, and never opens the database. It runs the computer helper.

## The computer helper

The cloud board has no computer. What needs one is done by a **helper on a computer that syncs**: the local server's process runs it, so `wb serve`, the service and the desktop app all carry it, with nothing to set up. One per computer (the process that has the port, 4321).

- **How it gets through:** an outbound WebSocket to the cloud board, signed in with this computer's device token (`workbench.db.sync.json`). It's a [hibernatable](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) one: its pings every 30 s are answered without waking the board, and the board wakes only for work (a job, or when a tracker is due). Where a WebSocket won't stay open, it polls over https instead.
- **Jobs:** the cloud board keeps a queue of jobs in its database. Each job goes to one helper: one that's online and has the project's folder, so several computers can sync. With none online, the board says so in words: *No computer is online to do it. Open the Workbench app, or run wb serve, on a computer that syncs with this board.*
- **It runs the board's own code** for each job (dispatch.ts, trackers.ts, git.ts, logo.ts, usage.ts, health.ts), and the cloud board runs the rest: Run's checks and limits, answering the ask, the run's row and its notes, tracker leases and history.
- **New commands wait for an OK on the computer.** On the cloud board any paired device may change a tracker's command or the command that starts agents (Settings → Agents), which on a computer only its own board may. So a computer runs a command only once it's allowed there: the ones the board had when its helper first started, and each new one after **Allow** in a window on that computer (or `wb helper allow`). Until then the board shows "… waits for an OK on <computer>". Kept in `workbench.db.helper.json`.
- **`wb helper`** lists the computers online for the cloud board, and the commands waiting for an OK here.

| What | On the cloud board |
| --- | --- |
| Agents the board starts (Run, Answer & send, Send it, `wb run`) | Start on a computer that has the project's folder; their output and what they did (events) stream back to the board and Stop stops them there. Continue goes to the computer the session ran on (`helper_ran`), or one with the project's folder. Unblocked work is sent by itself when Settings says so |
| Trackers that run a command (and the presets) | Read on a computer when due, and with Refresh |
| Git state, commits and pull requests on items | From the project folders on a computer (and its `gh`), kept on the board for when no computer is online. The Agents place (`/api/agents`) uses the same, and says in `limits` how old it is or what's missing |
| Whether an agent is alive (`alive`, `alive_at`) | The same as on a computer: `wb mcp`'s relay sends the session it runs in (`x-wb-session`), and `wb` its commands, to the cloud board, which counts them |
| The vault's password window for agents (`vault_get`, `vault_list`) | `wb mcp` answers them itself: the window opens on the computer where the agent runs, and the `.env` file is written there. The cloud board only hands over the sealed secrets, as the vault page has them, and keeps the log |
| Usage, what agents cost today, logos from the repo, Settings → Projects' folders, Add project's suggestions, Test the command | From a computer |
| Health, the setup guide | Not shown: they check the computer the board runs on, and the cloud board has none |
| Sharing a report through a tunnel | Not available |
| Backup files, Compact | Cloudflare keeps 30 days of every change instead ([point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)); Export still downloads everything as JSON |

What's different: a paired device may do what the board's page on the computer may (Settings, projects, the vault), since there is no "this computer" in the cloud. Old report versions, tracker readings and closed items are tidied once a day, as Settings → Data says. Asks past their deadline go ahead on the next request, as `wb` does.

## Turning it off

```bash
wb sync off
```

The cloud board's rows come back down into a new database, which takes the place of this computer's. The one from before sync was turned on is kept next to it as `workbench-before-sync-off-<time>.db`. This computer's device is removed from the cloud board, which otherwise stays as it is. `--keep-local` skips the download and goes back to this computer's board exactly as it was. Restart the desktop app and the service afterwards.

## Security

- **Getting in takes a device token.** The first comes from the owner key (the `WB_OWNER_KEY` secret on the Worker, compared in constant time; 10 wrong keys in 10 minutes and it waits). Later ones come from a one-time pairing code (10 minutes, one device), or a one-time login ticket (one minute) that a device makes with its own token. The board keeps only a hash of each token. Settings → Privacy and security lists the devices and removes any of them; removing one stops it at once.
- **Browsers** carry the token in an `HttpOnly; Secure; SameSite=Strict` cookie. `wb`, the MCP relay and the app send it as `Authorization: Bearer`. Writes are JSON only, as on a computer, so no other site's page can change the board. `/mcp` and the sync calls take only the header, never from a page (any `Origin` is refused).
- **Everything goes over https.** This computer's token is in `workbench.db.sync.json` next to the database (mode 0600, outside git like the database).
- **The vault's secrets** go up encrypted, as they're kept: only your password opens them, in the page.

## How it works

- `worker/src/index.ts`: the Worker. Every request goes to the one Durable Object, `Board`.
- `worker/src/board.ts`: the board. It runs `createSchema` (db.ts) on its SQLite and serves the route table from `src/routes.ts` (the same one `server.ts` serves on a computer). It adds the gate, the owner key, login tickets and `/api/sync/*`, and answers what needs a computer itself (`NEEDS_COMPUTER`). The page gets `<html data-cloud="1">`, which `ui/core.js` reads as `CLOUD`.
- `worker/src/helper.ts`: the computer helper's side on the cloud board: its WebSockets and polls (`/api/helper/*`, device tokens in a header only), the job queue (`helper_jobs`), who's online, the hooks the board's code already has (dispatch.ts `launcher`, `places`, `costs`; trackers.ts `reader`), and what it keeps for the page (`helper_cache`). `src/helper.ts` is the helper on a computer; `src/cloudvault.ts` is the relay's vault.
- `worker/src/sqlite.ts`: bun:sqlite's `Database` (as much as the board uses) over the Durable Object's `ctx.storage.sql`: named `$params` rewritten to positional, `transaction()` as `transactionSync`, BLOBs as `Uint8Array`.
- `src/sync.ts`: the sync format and the client side (`wb sync on/off`). `src/cloudcli.ts` is `wb` while this computer syncs, and `src/relay.ts` is `wb mcp`'s relay.
- `src/cli.ts` holds the board-data commands as a function of the args, the database, the folder and an output sink (no `process.exit`, no `console.log`): `wb.ts` runs it on this computer's database, and `POST /api/sync/cli` (`worker/src/cloudcli.ts`, a device token in a header, never from a page) runs it on the cloud board's. `src/cliargs.ts` is the options, which commands need a computer, and which files each one reads.
- **Push notifications:** `worker/src/push.ts` decides, after every write, what changed (the same events as the page's `ui/notify.js`) and sends it to each subscribed device but the one that made the change; `worker/src/webpush.ts` encrypts (RFC 8291, aes128gcm) and signs (VAPID) with WebCrypto, tested against the RFC's own example. `ui/sw.js` (served at `/sw.js`, no caching) shows them; `ui/push.js` subscribes the page. The keys and subscriptions (`push_keys`, `push_subscriptions`) stay on the cloud board (`NOT_MOVED`), and the one alarm also ends quiet hours, with tidying kept at its own time (`tidy_at`).
- **Long pages:** a row holds at most 8 MB in the cloud, so a report page longer than a million characters keeps the rest in `report_parts` (on a computer too; `reportHtml` joins them).

## Development

```bash
cd worker && bun install
bun run dev                          # the cloud board on http://localhost:8787, its data in worker/.wrangler/
bun test                             # the cloud board's tests, on a local Worker they start and stop
cd .. && WB_TEST_SQL=durable-object bun test   # the board's own tests, on the cloud board's SQLite
```

- **A key for `bun run dev`:** put `WB_OWNER_KEY=<anything>` in `worker/.dev.vars` (outside git), then `WB_DB=<a copy> wb sync on http://localhost:8787 --key <it>` tries a whole board on it. Make the copy with `sqlite3 workbench.db ".backup /tmp/copy.db"`, never the real file.
- **Deploying** is by hand, never on a push: `bun run deploy` in `worker/`, or Actions → Cloud board → Run workflow, which checks first. That needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The cloud board and `wb` check they speak the same sync format (`SYNC_FORMAT` in sync.ts).
