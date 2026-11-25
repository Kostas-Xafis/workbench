# Workbench

One board for every project: the work agents are doing or will do, and the decisions, checks and reviews that wait on Kostas (Inbox, Agents, Projects).
A Bun server with SQLite and no runtime dependencies; the desktop app (Tauri) is optional. See README.md and docs/.

<!-- workbench rules v4: kept by `wb integrate`; run it again to update. Project notes go outside these markers. -->
## Open work lives on the workbench

Kostas tracks every project on one local board, the workbench (`wb open` → http://localhost:4321). This project is `workbench` there. Open work goes on the board, never in a markdown list: tasks, bugs, ideas, and everything that waits on Kostas. Use the `wb` command, or the workbench MCP server's tools when you have them (named in brackets).

- **A prompt that names an item** (`wb-` and four letters or digits) means reading it first: `wb show <ref>` (get_item). Its body, notes and pictures are the brief. When Kostas answers a decision or reports a result, record it on the item word for word (`wb note`, add_note) before acting on it.
- **Your work, while you do it:** `wb start <ref> --branch <branch>` when you begin (start_item), or `wb add "…"` first when there's no item yet (add_item). `wb done <ref> "<branch or commit>: what changed"` when it lands (finish_item), `wb wait <ref> "why"` when you're blocked (wait_item); when it's on another item, say which (`--on wb-xxxx`, `on`), and your work goes back to to-do by itself the moment that item is answered or finished.
- **Decide open questions yourself and keep moving:** Kostas has no time to explain. Ask only about money, accounts, stores, anything that can't be undone, or what the product should be. First read the rulings (`wb rulings`, list_rulings): what Kostas already decided, one line each. Follow them. When you pick up an answered decision, rewrite its drafted ruling as one clear line (`wb rule <id> "…"`, update_ruling).
- **When you must ask,** it's its own item: one `decision` for related questions (`--pick many`), its brief opening with your recommendation (`--recommend`), which goes ahead by itself unless Kostas objects; a `check` (numbered steps, what right and wrong look like); a `setup` (each click, what to copy back). Changed something? A `notice` says what, never a wording or layout review. Reviews and notices go ahead by themselves after the usual wait. `--blocks <your item>` files the ask and waits on it in one step; `--goal` attaches it to the goal it serves. Kostas reads it on a phone without the repo: the content in the body, plain words, no "see docs/x.md", no internal codes. Read `wb guide` before your first.
- **Anything on screen gets a screenshot** on its item: `wb image add <ref> shot.png "what to look at"` (attach_image). Keep the file out of the repo.
- **Item refs** go in commit messages and PR titles (the ref in brackets at the end of the title), which links them to the item on the board. They never go into code or committed docs (this block names none), and an item is never `#12` (that's a pull request).
- **No `wb` and no MCP server** (a cloud session, CI)? End your report with a "For the workbench" list of what to add, start, finish or ask, and Kostas files it.
<!-- /workbench rules -->
