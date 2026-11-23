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
- **The desktop app** opens the cloud board in its window and signs it in by itself, with a one-time ticket from this computer's device token (nothing to type). It starts no server of its own. Its tray count asks the cloud board. If the cloud board can't be reached, the window says so, with Retry.
- **Agents** keep `claude mcp add -s user wb -- wb mcp`. While this computer syncs, `wb mcp` relays every MCP call to the cloud board's `/mcp` with this computer's token, with the project of the folder it starts in as the default, as before. A picture given as a file path is read here and sent along.
- **`wb open`** opens the desktop app, or the browser signed in with a one-time ticket.
- **The `wb` commands that read or change the board** (`wb ls`, `wb add`, `wb done`, …) don't work over the network yet: they say so and stop, so nothing lands on the local copy by mistake. Use the board or the MCP tools.
- **The local server** (`wb serve`, the service, an older app's sidecar) doesn't serve a board while this computer syncs: it answers every page with "The board is in the cloud" and the link, and never opens the database.

## What needs a computer

The cloud board has no computer, so these aren't on it yet. A helper that does them on a computer that syncs comes next.

| What | On the cloud board |
| --- | --- |
| Agents the board starts (Run, Answer & send, Send it) | The panel shows past runs; starting one says it needs a computer |
| Trackers that run a command; git state and pull requests on items | Commands don't run; the git and code parts are empty |
| The vault's password window for agents (`vault_get`, `vault_list`) | Not available; the vault itself works on the board's page |
| Usage, Health, the setup guide, project folders, logos from the repo | Not shown (projects show their initials) |
| Sharing a report through a tunnel, data sources' sealed headers | Not available |
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
- `worker/src/sqlite.ts`: bun:sqlite's `Database` (as much as the board uses) over the Durable Object's `ctx.storage.sql`: named `$params` rewritten to positional, `transaction()` as `transactionSync`, BLOBs as `Uint8Array`.
- `src/sync.ts`: the sync format and the client side (`wb sync on/off`). `src/cloudcli.ts` is `wb` while this computer syncs, and `src/relay.ts` is `wb mcp`'s relay.
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
