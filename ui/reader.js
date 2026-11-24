/* ---------- The reader: one item as a document ---------- */

// createReader(host) shows an item in `host` as something to read: a line of context, the title, the brief with its
// pictures, what it asks of you (choices, No objections / Object…, a check's steps), the agent's run, the history
// as a thread and one reply box; its properties in a narrow column beside it, each changed in place. Nothing waits
// for a Save: an answer goes at once, a property when it's changed, the title and brief when you leave them.
// It doesn't care where it's shown: today the sheet below opens it over the board (openItemById), and it can sit
// beside a list as a reading pane. Features add sections through hooks.readerDoc and hooks.readerProps (hooks.js);
// the agent's run box comes from ui/dispatch.js: runPanel(item), wireRunPanel(el, item), runLive(item) and
// canResume(item), each used only when dispatch.js is there.
// A new item is the same reader in compose mode (r.compose, fields in r.draft): title, brief, pictures and a few
// properties, and Create.

const RD_PRIORITY = [["1", "P1 · launch blocker"], ["2", "P2 · before launch"], ["3", "P3 · later"]];
// Lines the board writes when a field changes ("status: todo → doing", "body edited"…): small and grey in the thread.
const RD_CHANGE = /^(created|body edited|image (added|removed)\b.*|options: .*|pick: (one|several)|recommended: .*|default: .*|deadline: .*|Deferred until .*|Back in the queue|[a-z_]+: .* → .*)$/;
const RD_SYSTEM = new Set(["workbench", "board"]);
const RD_SHOWN_NOTES = 8;
const RD_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const rdTyping = (a = document.activeElement) => !!a && (a.isContentEditable || a.matches?.("textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=file])"));
const rdName = () => setting("name") || "Kostas";
const rdKey = (k) => `<kbd class="rd-k">${esc(k)}</kbd>`;
/** A property: its label above its value. */
const readerProp = (label, value, cls = "") => `<div class="rd-prop${cls ? ` ${cls}` : ""}"><span class="rd-label">${label}</span>${value}</div>`;
const rdSelect = (field, options, value, label) => `<select class="rd-val" data-field="${field}" aria-label="${esc(label)}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value ?? "") ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const rdInput = (field, value, label, more = "") => `<input class="rd-val" data-field="${field}" value="${esc(value ?? "")}" aria-label="${esc(label)}" placeholder="—" spellcheck="false"${more}>`;
const rdAuthor = (a) => a === "kostas" || a === "web" ? rdName() : a === "agent" ? "Agent" : a === "import" ? "Imported" : RD_SYSTEM.has(a) ? "Board" : a || "Someone";
const rdMine = (a) => a === "kostas" || a === "web";
const asDataUrl = (file) => new Promise((ok, no) => {
	const f = new FileReader();
	f.onload = () => ok(f.result);
	f.onerror = () => no(f.error);
	f.readAsDataURL(file);
});
const uploadImage = async (itemId, file, caption = "") =>
	api(`/api/items/${itemId}/images`, { method: "POST", body: JSON.stringify({ data: await asDataUrl(file), caption }) });

/* The thread: notes become entries, oldest first. A field change is a grey line, and changes in a row fold into one
   ("4 changes"); your answer, which the board writes as a field change, reads as what you said. */
function rdThread(notes) {
	const out = [];
	for (const n of notes) {
		if (n.text === "created") continue;
		const parts = n.text.includes("\n") ? null : n.text.split(" · ").map((p) => p.trim());
		const change = parts?.every((p) => RD_CHANGE.test(p));
		const said = change && rdMine(n.author) && parts.map((p) => p.match(/^answer: .* → (.+)$/)?.[1]).find((a) => a && a !== "—");
		if (said) out.push({ type: "mine", note: { ...n, text: `Answered: ${said}` } });
		else if (change || (RD_SYSTEM.has(n.author) && !n.text.includes("\n"))) {
			const last = out.at(-1);
			if (last?.type === "changes") last.notes.push(n); else out.push({ type: "changes", notes: [n] });
		} else out.push({ type: rdMine(n.author) ? "mine" : "note", note: n });
	}
	return out;
}
const rdTime = (at) => `<time title="${esc(at)} UTC">${esc(ago(at))}</time>`;
function rdEntry(e) {
	if (e.type === "changes") {
		const line = (n) => `<div class="rd-change">${esc(n.text)} <span class="rd-dot">·</span> ${rdTime(n.at)}</div>`;
		if (e.notes.length === 1) return line(e.notes[0]);
		return `<details class="rd-changes"><summary>${e.notes.length} changes <span class="rd-dot">·</span> ${rdTime(e.notes.at(-1).at)}</summary>${e.notes.map(line).join("")}</details>`;
	}
	const n = e.note;
	const text = n.text.includes("\n") ? `<div class="rd-md">${md(n.text)}</div>` : `<div class="rd-line">${esc(n.text)}</div>`;
	return `<div class="rd-note${e.type === "mine" ? " mine" : ""}"><div class="rd-who"><b>${esc(rdAuthor(n.author))}</b> ${rdTime(n.at)}</div>${text}</div>`;
}

/* The core properties, in order; features add theirs with hooks.readerProps. In compose mode only those that make
   sense for a new item show. */
const RD_PROPS = [
	{ order: 10, html: (i, r) => r.compose ? "" : readerProp("Status", rdSelect("status", STATUSES.map((s) => [s, s]), i.status, "Status")) },
	{ order: 20, html: (i) => readerProp("Who acts", rdSelect("owner", [["kostas", rdName()], ["agent", "Agent"]], i.owner, "Who acts")) },
	{ order: 30, html: (i) => readerProp("Kind", rdSelect("kind", KINDS.map((k) => [k, k]), i.kind, "Kind")) },
	{ order: 40, html: (i) => readerProp("Priority", rdSelect("priority", RD_PRIORITY, i.priority, "Priority")) },
	{ order: 50, html: (i) => readerProp("Project", rdSelect("project", state.allProjects.filter((p) => !p.archived_at || p.slug === i.project).map((p) => [p.slug, p.name]), i.project, "Project")) },
	{ order: 60, html: (i, r) => r.compose ? "" : readerProp("Area", rdInput("area", i.area, "Area", ' list="areas"')) },
	{ order: 70, html: (i, r) => r.compose ? "" : readerProp("Branch", rdInput("branch", i.branch, "Branch")) },
	{ order: 80, html: (i, r) => {
		if (r.compose) return "";
		// The server's link (a Claude Code or a Desktop session, dispatch.ts desktopLink), opened by the page itself.
		const href = i.desktop || sessionHref(i.session || "");
		return readerProp("Session", rdInput("session", i.session, "Session") + (href ? `<a class="rd-small" href="${esc(href)}" title="Opens the session in Claude Desktop on this computer">Open in Claude Desktop</a>` : ""));
	} },
	// A decision's choices, one per line.
	{ order: 85, html: (i) => i.kind !== "decision" ? "" : readerProp("Choices", `<textarea class="rd-val" data-field="options" rows="${Math.max(2, optionsOf(i).length)}" placeholder="One per line" aria-label="Choices, one per line">${esc(optionsOf(i).join("\n"))}</textarea>`) },
	{ order: 110, html: (i, r) => {
		const code = !r.compose && state.code[i.ref];
		if (!code || (!code.prs.length && !code.commits.length)) return "";
		const prs = [...code.prs].sort((a, b) => b.number - a.number).map((pr) => `<li title="${esc(pr.title)}"><a href="${esc(pr.url)}" target="_blank" rel="noreferrer">PR #${pr.number}</a> <span class="pr ${pr.state}">${pr.draft ? "draft" : pr.state.toLowerCase()}</span>${pr.review ? ` · ${esc(pr.review.toLowerCase().replaceAll("_", " "))}` : ""}${pr.checks ? ` · checks<i class="ck ${pr.checks}"></i>` : ""}</li>`);
		const commits = code.commits.slice(0, 6).map((c) => `<li title="${esc(`${c.subject} · ${c.date}`)}"><code>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noreferrer">${esc(c.short)}</a>` : esc(c.short)}</code> ${esc(c.subject)}</li>`);
		const more = code.commits.length > 6 ? `<li class="rd-muted">${code.commits.length - 6} more commits</li>` : "";
		return readerProp("Code", `<ul class="rd-code">${[...prs, ...commits].join("")}${more}</ul>`);
	} },
	{ order: 130, html: (i, r) => !r.compose && i.sources ? readerProp("From", `<span class="rd-text">${esc(i.sources)}</span>`) : "" },
	{ order: 200, html: (i, r) => r.compose || !i.updated_at ? "" : `<div class="rd-prop rd-muted rd-small">Updated ${esc(ago(i.updated_at))}</div>` },
];

function createReader(host, opts = {}) {
	const r = {
		host, item: null, compose: false, draft: null, full: null, pending: [], drafts: new Map(), resume: new Set(), toAgent: new Set(),
		briefEdit: false, later: false, mode: "", allNotes: false, ownerPicked: false, err: "", propsOpen: false,
	};
	host.classList.add("rd");
	host.innerHTML = `<div class="rd-bar">
			${opts.nav ? `<button type="button" class="icon-btn" data-rd-nav="-1" title="Previous item (K)" aria-label="Previous item"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.6"><path d="m4 10 4-4 4 4"/></g></svg></button>
			<button type="button" class="icon-btn" data-rd-nav="1" title="Next item (J)" aria-label="Next item"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.6"><path d="m4 6 4 4 4-4"/></g></svg></button>` : ""}
			${opts.close ? `<button type="button" class="icon-btn" data-rd-close title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.6"><path d="m4 4 8 8M12 4l-8 8"/></g></svg></button>` : ""}
		</div>
		<div class="rd-scroll" tabindex="-1">
			<div class="rd-cols">
				<article class="rd-doc">
					<div data-part="ctx"></div><div data-part="runtop"></div><div data-part="title"></div><div data-slot="lead"></div>
					<div data-part="brief"></div><div data-part="images"></div><div data-slot="action"></div><div data-part="quiet"></div>
					<div data-part="runend"></div><div data-part="thread"></div><div data-part="reply"></div><div data-part="err"></div>
				</article>
				<aside class="rd-side" aria-label="Properties">
					<button type="button" class="rd-props-toggle" data-rd-props>Properties</button>
					<div class="rd-props" data-slot="props"></div>
				</aside>
			</div>
		</div>
		<input type="file" class="rd-file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>`;
	const scroller = $(".rd-scroll", host);
	const fileInput = $(".rd-file", host);

	/* Drawing. Each part is redrawn only when its markup changed, and never while you type in it, so a refresh
	   from the server doesn't take your cursor or your words. */
	function part(name, html, wire) {
		const old = $(`[data-part="${name}"]`, host);
		if (old._html === html) return;
		if (rdTyping() && old.contains(document.activeElement)) return;
		const el = old.cloneNode(false);
		el.innerHTML = html;
		el._html = html;
		// What you'd typed in a box that's drawn again stays.
		for (const t of old.querySelectorAll("textarea[data-keep]")) { const n = $(`textarea[data-keep="${t.dataset.keep}"]`, el); if (n && t.value) n.value = t.value; }
		old.replaceWith(el);
		if (wire && html) try { wire(el); } catch (e) { console.error(e); }
	}
	function slot(name, sections) {
		const box = $(`[data-slot="${name}"]`, host);
		while (box.children.length < sections.length) box.append(document.createElement("div"));
		while (box.children.length > sections.length) box.lastElementChild.remove();
		sections.forEach((s, n) => {
			let html = "";
			try { html = s.html(r.compose ? r.draft : r.item, r) || ""; } catch (e) { console.error(e); }
			const old = box.children[n];
			if (old._html === html && old._sec === s) return;
			if (rdTyping() && old.contains(document.activeElement)) return;
			const el = document.createElement("div");
			el.className = "rd-sec";
			el.innerHTML = html;
			el._html = html;
			el._sec = s;
			old.replaceWith(el);
			if (s.wire && html) try { s.wire(el, r.compose ? r.draft : r.item, r); } catch (e) { console.error(e); }
		});
	}
	r.render = () => {
		const item = r.compose ? r.draft : r.item;
		if (!item) return;
		host.classList.toggle("rd-composing", r.compose);
		host.classList.toggle("rd-props-open", r.propsOpen);
		const run = !r.compose && typeof runPanel === "function" ? runPanel(item) : "";
		const live = !!run && typeof runLive === "function" && runLive(item);
		const wireRun = (el) => { if (typeof wireRunPanel === "function") wireRunPanel(el, item); };
		part("ctx", ctxHtml(item));
		part("runtop", live ? run : "", wireRun);
		part("title", `<textarea class="rd-title" data-rd-title rows="1" placeholder="What needs doing?" aria-label="Title">${esc(item.title)}</textarea>`);
		slot("lead", r.compose ? [] : hooks.readerDoc.filter((s) => s.slot === "lead"));
		part("brief", briefHtml(item));
		part("images", imagesHtml(item));
		slot("action", r.compose ? [] : [RD_ACTION, ...hooks.readerDoc.filter((s) => s.slot === "action")]);
		part("quiet", quietHtml(item));
		part("runend", live ? "" : run, wireRun);
		part("thread", r.compose ? "" : threadHtml(item));
		part("reply", r.compose ? "" : replyHtml(item));
		if (!r.compose && item.id) part("replyfoot", replyFoot(item));
		part("err", r.err ? `<p class="rd-err" role="alert">${esc(r.err)}</p>` : "");
		slot("props", [...RD_PROPS, ...hooks.readerProps].sort((a, b) => (a.order ?? 150) - (b.order ?? 150)));
		// A button that answered is gone now: keys go on working in the reader rather than the page behind it.
		if ((!document.activeElement || document.activeElement === document.body) && host.getClientRects().length) scroller.focus({ preventScroll: true });
	};

	function ctxHtml(i) {
		const creator = i.notes?.find((n) => n.text === "created")?.author;
		const by = r.compose ? "new" : !i.created_at ? "" : `${rdMine(creator) ? "filed by you" : creator === "agent" ? "filed by the agent" : creator === "import" ? "imported" : "filed"} ${ago(i.created_at)}`;
		const status = !r.compose && i.status !== "todo" ? `<span class="rd-status st-${i.status}">${esc(i.status)}${i.done_at && !OPEN.includes(i.status) ? ` ${esc(ago(i.done_at))}` : ""}</span>` : "";
		return `<div class="rd-ctx">${i.ref ? `<button type="button" class="ref" data-copy="wb-${esc(i.ref)}" title="Copy wb-${esc(i.ref)}">wb-${esc(i.ref)}</button>` : ""}
			<span class="rd-kind">${glyph(`k-${i.kind}`)}${esc(i.kind)}</span>${i.project ? `<span>${esc(projectName(i.project))}</span>` : ""}${by ? `<span>${esc(by)}</span>` : ""}${status}</div>`;
	}
	function briefHtml(i) {
		if (r.compose || r.briefEdit) {
			const hint = r.compose ? "Markdown. Paste or drop pictures anywhere here." : `${rdKey("Ctrl")} ${rdKey("Enter")} or click away to save · ${rdKey("Esc")} to put it back`;
			return `<textarea class="rd-brief-edit" data-rd-brief data-keep="brief-${i.id ?? "new"}" placeholder="Steps, context, links (markdown)" aria-label="Details">${esc(i.body ?? "")}</textarea>
				<div class="rd-tools"><span class="rd-muted">${hint}</span><span class="spacer"></span><button type="button" class="rd-link" data-rd-add-image>Add image</button></div>`;
		}
		if (i.body === undefined) return `<div class="rd-brief rd-muted">Loading the details…</div>`;
		const body = i.body.trim() ? `<div class="rd-brief rd-md">${md(i.body)}</div>` : `<div class="rd-brief rd-muted">No details.</div>`;
		return `${body}<div class="rd-tools"><button type="button" class="rd-link" data-rd-edit-brief>Edit ${rdKey("E")}</button><button type="button" class="rd-link" data-rd-add-image>Add image</button></div>`;
	}
	function imagesHtml(i) {
		const saved = (i.images || []).map((m) => `<figure><a href="/api/images/${m.id}" target="_blank" rel="noreferrer" title="Open full size"><img src="/api/images/${m.id}" alt="${esc(m.caption)}"${m.width && m.height ? ` width="${m.width}" height="${m.height}"` : ""}></a>
			<figcaption><input class="cap" data-cap="${m.id}" value="${esc(m.caption)}" placeholder="Add a caption" aria-label="Caption"><button type="button" class="rd-link" data-rd-unimage="${m.id}">Remove</button></figcaption></figure>`);
		const pending = r.pending.map((p, n) => `<figure class="${p.busy ? "pending" : ""}"><a href="${p.url}" target="_blank" rel="noreferrer"><img src="${p.url}" alt=""></a>
			<figcaption><input class="cap" data-pending="${n}" value="${esc(p.caption)}" placeholder="Add a caption" aria-label="Caption">${p.busy ? "" : `<button type="button" class="rd-link" data-rd-unpend="${n}">Remove</button>`}</figcaption></figure>`);
		return saved.length || pending.length ? `<div class="rd-images">${[...saved, ...pending].join("")}</div>` : "";
	}
	function quietHtml(i) {
		if (r.compose) return `<div class="rd-quiet rd-create"><button type="button" class="primary" data-rd-create>Create</button><button type="button" class="rd-link" data-rd-cancel>Cancel</button><span class="rd-muted">${rdKey("Ctrl")} ${rdKey("Enter")} creates it</span></div>`;
		if (!i.id || !OPEN.includes(i.status)) return "";
		const b = (what, label, key, title) => `<button type="button" class="rd-q" data-rd-act="${what}" title="${esc(title)}">${label} ${rdKey(key)}</button>`;
		if (r.later) return `<div class="rd-quiet rd-later"><span class="rd-muted">Out of the queue until</span>
			<button type="button" class="rd-q" data-rd-later="tomorrow">Tomorrow ${rdKey("D")}</button><button type="button" class="rd-q" data-rd-later="in 3 days">In 3 days ${rdKey("3")}</button>
			<button type="button" class="rd-q" data-rd-later="next week">Next week ${rdKey("W")}</button><label class="rd-q">Another day <input type="date" data-rd-later-date min="${rdLocalDate(new Date(Date.now() + 86400e3))}"></label>
			<button type="button" class="rd-link" data-rd-later-off>Cancel</button></div>`;
		const yours = i.owner === "kostas";
		return `<div class="rd-quiet">${b("done", "Done", "M", "Mark it done")}${b("drop", "Drop", "X", "Drop it: nobody does it")}${yours ? b("later", "Later", "D", "Out of the queue until a day you pick; it still waits on you") : ""}${yours ? b("giveback", "Give back", "G", "Back to the agent: it decides") : ""}</div>`;
	}
	function threadHtml(i) {
		if (!i.id) return "";
		if (!i.notes) return `<h2 class="rd-h">History</h2><p class="rd-muted">Loading the history…</p>`;
		const all = rdThread(i.notes);
		if (!all.length) return "";
		const hidden = r.allNotes ? 0 : Math.max(0, all.length - RD_SHOWN_NOTES);
		return `<h2 class="rd-h">History</h2><div class="rd-thread">${hidden ? `<button type="button" class="rd-link rd-earlier" data-rd-earlier>Show ${hidden} earlier</button>` : ""}${all.slice(hidden).map(rdEntry).join("")}</div>`;
	}
	// The one reply box. On an ask it answers (a decision) or objects (a review, a notice); otherwise it adds a note.
	const defaultMode = (i) => (askOpen(i) && i.kind === "decision" ? "answer" : askOpen(i) && (i.kind === "review" || i.kind === "notice") ? "object" : "note");
	const RD_MODES = {
		answer: { ph: "Answer in your own words…", send: "Answer" },
		object: { ph: "Object: what you'd rather have. It goes back to the agent…", send: "Object" },
		note: { ph: "Add a note…", send: "Add note" },
	// A note with "send to the agent" ticked: the agent's session goes on with it (ui/dispatch.js continueAgent).
	agent: { ph: "Tell the agent… It carries on in the same session, with what it knows", send: "Send to the agent" },
		giveback: { ph: "A line for the agent (empty: “You decide, with your recommendation.”)", send: "Give back" },
	};
	// The box itself is drawn once per item, so what you type (and the cursor) stays while the rest changes; what it
	// does (its placeholder, its foot) follows the item.
	const replyHtml = (i) => !i.id ? "" : `<div class="rd-reply"><textarea data-rd-reply data-keep="reply-${i.id}" rows="1"></textarea><div data-part="replyfoot"></div></div>`;
	function replyFoot(i) {
		const mode = r.mode || defaultMode(i), def = defaultMode(i);
		const toAgent = mode === "note" && toAgentIt(i);
		const m = RD_MODES[toAgent ? "agent" : mode];
		const t = $("[data-rd-reply]", host);
		if (t) { t.placeholder = m.ph; t.setAttribute("aria-label", m.send); }
		const swap = mode === "giveback" ? `<button type="button" class="rd-link" data-rd-mode="">Cancel</button>`
			: def !== "note" ? `<button type="button" class="rd-link" data-rd-mode="${mode === "note" ? "" : "note"}">${mode === "note" ? (def === "answer" ? "Answer instead" : "Object instead") : "Add a note instead"}</button>` : "";
		return `<div class="rd-reply-foot"><span class="rd-muted">${rdKey("Enter")} ${esc(m.send.toLowerCase())} · ${rdKey("Shift")} ${rdKey("Enter")} new line</span>${swap}<span class="spacer"></span>
			${mode === "answer" || mode === "object" ? resumeHtml(i) : mode === "note" ? agentTickHtml(i) : ""}<button type="button" class="${toAgent ? "primary" : "ghost"} sm" data-rd-reply-send>${esc(m.send)}</button></div>`;
	}
	// "Send to the agent": on an item whose agent's last run ended with a session it can carry on in, a note goes to
	// that agent (a new run resumes the session with it) instead of only into the history.
	const canContinueIt = (i) => typeof canContinue === "function" && !!i.id && canContinue(i);
	const toAgentIt = (i) => r.toAgent.has(i.id) && canContinueIt(i);
	const agentTickHtml = (i) => !canContinueIt(i) ? ""
		: `<label class="rd-resume" title="The agent carries on in its session with what you write, in the folder it worked in"><input type="checkbox" data-rd-to-agent${r.toAgent.has(i.id) ? " checked" : ""}> send to the agent</label>`;
	// "Resume the agent": the answer also starts an agent on the item (ui/dispatch.js decides when that can be).
	const canResumeIt = (i) => typeof canResume === "function" && !!i.id && canResume(i);
	function resumeHtml(i) {
		if (!canResumeIt(i)) return "";
		const folder = state.allProjects.find((p) => p.slug === i.project)?.path ?? "its folder";
		return `<label class="rd-resume" title="${esc(`Then start an agent on it in ${folder}`)}"><input type="checkbox" data-rd-resume${r.resume.has(i.id) ? " checked" : ""}> resume the agent</label>`;
	}
	const sending = (i) => r.resume.has(i.id) && canResumeIt(i);
	r.resumeHtml = resumeHtml;

	/* The action area: what the item asks of you. Decisions: the choices (1–9), the recommended one marked; ticks and
	   one Answer when several can be picked. Reviews and notices: No objections / Got it, and Object…. */
	const RD_ACTION = {
		html(i) {
			if (!i.id || !ASK_KINDS.includes(i.kind)) return "";
			// Sent, and on its way: say so at once; nothing here can be clicked again meanwhile.
			if (r.busy?.id === i.id && r.busy.shows) return `<div class="rd-answered"><span class="rd-label">Your answer</span><div>${esc(r.busy.shows)}</div></div>`;
			if (!askOpen(i)) return i.answer ? `<div class="rd-answered"><span class="rd-label">Your answer</span><div>${esc(i.answer)}</div></div>` : "";
			if (i.kind !== "decision") {
				return `<div class="rd-act"><div class="rd-acts"><button type="button" class="rd-choice rd-ok" data-rd-ack>${i.kind === "review" ? "No objections" : "Got it"} ${rdKey("A")}</button>
					<button type="button" class="rd-choice rd-no" data-rd-object>Object… ${rdKey("O")}</button></div>${resumeHtml(i) ? `<div class="rd-act-foot">${resumeHtml(i)}</div>` : ""}</div>`;
			}
			const options = optionsOf(i);
			// The agent's pick: its recommended options, else one whose words say "(recommended)".
			const rec = askRecommended(i).length ? askRecommended(i) : options.filter((o) => /\(recommended\)\s*$/i.test(o));
			if (!options.length) return `<div class="rd-act"><button type="button" class="rd-link" data-rd-own>Answer in your own words ${rdKey("O")}</button></div>`;
			if (askMany(i)) {
				const ticked = askTicked(i);
				return `<div class="rd-act"><div class="rd-label">Pick any</div><div class="rd-choices">${options.map((o, n) => `<label class="rd-choice rd-pick${ticked.has(o) ? " on" : ""}${rec.includes(o) ? " rec" : ""}">
					<input type="checkbox" data-rd-tick value="${esc(o)}"${ticked.has(o) ? " checked" : ""}>${n < 9 ? rdKey(n + 1) : ""}<span>${esc(o)}</span>${rec.includes(o) && !/\(recommended\)/i.test(o) ? `<small>recommended</small>` : ""}</label>`).join("")}</div>
					<div class="rd-act-foot"><button type="button" class="ghost" data-rd-send-picks>${ticked.size ? `Answer with ${ticked.size}` : "Answer: none of them"}</button>${resumeHtml(i)}
					<button type="button" class="rd-link" data-rd-own>Or answer in your own words ${rdKey("O")}</button></div></div>`;
			}
			return `<div class="rd-act"><div class="rd-choices">${options.map((o, n) => `<button type="button" class="rd-choice${rec.includes(o) ? " rec" : ""}" data-rd-choice="${n}">${n < 9 ? rdKey(n + 1) : ""}<span>${esc(o)}</span>${rec.includes(o) && !/\(recommended\)/i.test(o) ? "<small>recommended</small>" : ""}</button>`).join("")}</div>
				<div class="rd-act-foot">${resumeHtml(i)}<button type="button" class="rd-link" data-rd-own>Or answer in your own words ${rdKey("O")}</button></div></div>`;
		},
	};

	/* Showing an item. */
	r.show = (item) => {
		const same = !r.compose && r.item && item.id === r.item.id;
		if (!same) leaveItem();
		r.compose = false;
		r.draft = null;
		r.item = item;
		r.full = item.loading ? null : item;
		if (!same) {
			Object.assign(r, { briefEdit: false, later: false, mode: "", allNotes: false, err: "" });
			r.render();
			const reply = $("[data-rd-reply]", host);
			if (reply) reply.value = r.drafts.get(item.id) ?? "";
			scroller.scrollTop = 0;
		} else r.render();
		if (item.loading) r.reload();
	};
	// The item as the server has it now; nothing happens when it hasn't changed (api() gives back the same object).
	r.reload = async () => {
		const id = r.item?.id;
		if (!id || r.compose) return;
		try {
			const full = await api(`/api/items/${id}`);
			if (r.compose || r.item?.id !== id || full === r.full) return;
			r.take(full);
		} catch (e) { if (r.item?.id === id) r.error(e.message); }
	};
	r.take = (item) => {
		if (!item || r.compose) return;
		if (r.item?.id !== item.id) return r.show(item);
		r.item = item;
		r.full = item;
		r.render();
	};
	r.error = (text) => { r.err = text || ""; r.render(); };
	r.open = (id) => (opts.open ? opts.open(id) : openItemById(id)).catch((e) => toast(e.message));
	// Leaving an item: what you'd typed in the reply box waits for you to come back to it.
	function leaveItem() {
		const t = $("[data-rd-reply]", host);
		if (r.item?.id && t) { if (t.value.trim()) r.drafts.set(r.item.id, t.value); else r.drafts.delete(r.item.id); }
		r.pending.forEach((p) => URL.revokeObjectURL(p.url));
		r.pending = [];
	}
	r.leave = leaveItem;

	/** A new item: the same reader with the title and brief open, a few properties, and Create. */
	r.composeNew = (draft) => {
		leaveItem();
		Object.assign(r, { item: null, full: null, compose: true, draft: { title: "", body: "", options: "[]", ...draft }, ownerPicked: false, briefEdit: false, later: false, err: "" });
		r.render();
		scroller.scrollTop = 0;
		setTimeout(() => $("[data-rd-title]", host)?.focus(), 0);
	};
	r.composing = () => r.compose && !!(r.draft.title.trim() || r.draft.body.trim() || r.pending.length);

	/** Saves fields: on an item at once (the server's answer is shown), on a new item into its draft. */
	r.set = async (patch) => {
		if (r.compose) {
			if (patch.owner !== undefined) r.ownerPicked = true;
			Object.assign(r.draft, patch);
			if (patch.kind && !r.ownerPicked) r.draft.owner = setting(`owner.${patch.kind}`) ?? r.draft.owner;
			r.render();
			return r.draft;
		}
		const id = r.item?.id;
		if (!id) return;
		try {
			const item = await act.update(id, patch);
			r.err = "";
			r.take(item);
			return item;
		} catch (e) { r.error(e.message); }
	};
	// An answer or the like: sent at once; the reader shows the item as it is after.
	// One at a time: while one is on its way, the action area is disabled and further clicks and keys do nothing (a
	// second answer would replace the first, a second ack write it twice). `shows`: what the action area says at once
	// (your answer), before the server has answered. Gives false when another was still on its way.
	async function settle(call, said, shows = "") {
		const id = r.item?.id;
		if (!id || r.busy) return false;
		r.busy = { id, shows };
		host.classList.add("rd-busy");
		r.render();
		try {
			const item = await call(id);
			r.resume.delete(id);
			r.err = "";
			if (r.item?.id === id) { r.mode = ""; r.later = false; r.item = item; r.full = item; }
			if (said) toast(said);
		} catch (e) { r.err = e.message; }
		finally {
			r.busy = null;
			host.classList.remove("rd-busy");
			r.render();
		}
		return true;
	}
	const picksWord = (a) => Array.isArray(a) ? (a.length ? a.join("; ") : "none of them") : a;
	const sentWord = (i) => (sending(i) ? ". The agent is on it" : "");
	r.answer = (answer) => { const i = r.item; const send = sending(i); return settle((id) => act.answer(id, answer, { send }), `Answered${sentWord(i)}`, picksWord(answer)); };
	r.ack = () => { const said = r.item.kind === "review" ? "No objections" : "Got it"; return settle((id) => act.ack(id), said, said); };
	r.object = (text) => { const i = r.item; const send = sending(i); return settle((id) => act.object(id, text, { send }), `Sent back to the agent${sentWord(i)}`, `Objection: ${text}`); };
	r.done = () => settle((id) => act.done(id), "Done");
	r.drop = () => settle((id) => act.drop(id), "Dropped");
	r.defer = (until) => settle((id) => act.defer(id, until), "Out of the queue until then");
	r.giveBack = (text) => settle((id) => act.giveBack(id, text), "Given back to the agent");
	r.note = (text) => settle((id) => act.note(id, text));
	r.tellAgent = (text) => { const i = r.item; return settle(() => continueAgent(i, text), "Sent: the agent carries on"); };

	async function create() {
		const d = r.draft;
		if (!d.title.trim()) { r.error("It needs a title."); return $("[data-rd-title]", host)?.focus(); }
		try {
			const { goal_id, ...rest } = d;
			const body = { ...rest, priority: Number(d.priority), options: d.kind === "decision" ? optionsOf(d) : [], ...(goal_id ? { goal_id: Number(goal_id) } : {}) };
			const { id } = await api("/api/items", { method: "POST", body: JSON.stringify(body) });
			touched(id);
			for (const p of r.pending) {
				try { await uploadImage(id, p.file, p.caption); } catch (e) { toast(`A picture didn't go on: ${e.message}`); }
			}
			r.pending = [];
			r.compose = false;
			await Promise.all([loadItems(), loadProjects()]);
			refreshReport();
			const made = state.items.find((x) => x.id === id);
			toast(made ? `Added wb-${made.ref}` : "Added");
			opts.created ? opts.created(id) : opts.close?.();
		} catch (e) { r.error(e.message); }
	}

	/* Pictures: the button, a paste or a drop. A new item holds them until it's created. */
	async function addImages(files) {
		files = [...files].filter((f) => RD_IMAGE_TYPES.includes(f.type));
		if (!files.length) return r.error("Only PNG, JPEG, WebP or GIF pictures can go on an item.");
		r.err = "";
		if (r.compose) {
			r.pending.push(...files.map((file) => ({ file, url: URL.createObjectURL(file), caption: "" })));
			return r.render();
		}
		const id = r.item?.id;
		if (!id) return;
		const batch = files.map((file) => ({ file, url: URL.createObjectURL(file), caption: "", busy: true }));
		r.pending.push(...batch);
		r.render();
		toast(files.length > 1 ? `Adding ${files.length} pictures…` : "Adding the picture…");
		let last;
		for (const p of batch) {
			try {
				last = await uploadImage(id, p.file);
				const m = last.images.at(-1);
				if (p.caption.trim() && m) last = await api(`/api/images/${m.id}`, { method: "PATCH", body: JSON.stringify({ caption: p.caption }) });
			} catch (e) { r.err = e.message; }
		}
		batch.forEach((p) => URL.revokeObjectURL(p.url));
		if (r.item?.id !== id) return;
		r.pending = r.pending.filter((p) => !batch.includes(p));
		if (last) { r.take(last); loadItems(); } else r.render();
	}

	/* The title and the brief, edited in place. */
	function saveTitle(t) {
		const v = t.value.replace(/\s*[\r\n]+\s*/g, " ").trim();
		if (r.compose) { r.draft.title = v; return; }
		if (!r.item?.id || !v || v === r.item.title || v === r.titleSent) { if (!v) t.value = r.item?.title ?? ""; return; }
		r.titleSent = v;
		r.set({ title: v }).finally(() => { r.titleSent = ""; });
	}
	function editBrief(on) {
		if (r.compose || !r.item?.id || r.item.body === undefined) return;
		r.briefEdit = on;
		r.render();
		if (on) { const t = $("[data-rd-brief]", host); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
	}
	function saveBrief(t) {
		if (r.compose) { r.draft.body = t.value; return; }
		if (!r.briefEdit) return;
		r.briefEdit = false;
		if (r.item?.id && t.value !== (r.item.body ?? "")) r.set({ body: t.value });
		else r.render();
	}
	// The reply box: Enter sends it as what the box says; Shift+Enter is a new line.
	function sendReply() {
		const t = $("[data-rd-reply]", host);
		const i = r.item;
		if (!t || !i?.id) return;
		const text = t.value.trim();
		const mode = r.mode || defaultMode(i);
		if (!text && mode !== "giveback") return t.focus();
		const done = () => { r.drafts.delete(i.id); const n = $("[data-rd-reply]", host); if (n) n.value = ""; };
		const call = mode === "answer" ? r.answer(text) : mode === "object" ? r.object(text) : mode === "giveback" ? r.giveBack(text) : toAgentIt(i) ? r.tellAgent(text) : r.note(text);
		return call.then((went) => { if (went !== false && !r.err) done(); });
	}
	function replyIn(mode) {
		r.mode = mode;
		r.render();
		const t = $("[data-rd-reply]", host);
		t?.focus();
		t?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}
	function quiet(what) {
		const i = r.item;
		if (!i?.id || !OPEN.includes(i.status)) return;
		if (what === "done") return r.done();
		if (what === "drop") return r.drop();
		if (what === "later" && i.owner === "kostas") { r.later = true; return r.render(); }
		if (what === "giveback" && i.owner === "kostas") return replyIn("giveback");
	}
	function choose(n) {
		const i = r.item;
		if (!i?.id || i.kind !== "decision" || !askOpen(i)) return;
		const o = optionsOf(i)[n];
		if (o === undefined) return;
		if (askMany(i)) { askTick(i, o, !askTicked(i).has(o)); return r.render(); }
		return r.answer(o);
	}

	/* Clicks, changes and keys, for the whole reader. */
	host.addEventListener("click", (e) => {
		const t = e.target;
		const q = (sel) => t.closest(sel);
		if (q("[data-rd-close]")) return opts.close?.();
		const nav = q("[data-rd-nav]");
		if (nav) return opts.nav?.(Number(nav.dataset.rdNav));
		if (q("[data-rd-props]")) { r.propsOpen = !r.propsOpen; return r.render(); }
		const choice = q("[data-rd-choice]");
		if (choice) { choice.classList.add("picked"); return choose(Number(choice.dataset.rdChoice)); }
		if (q("[data-rd-send-picks]")) return r.answer([...askTicked(r.item)]);
		if (q("[data-rd-own]")) return replyIn("answer");
		if (q("[data-rd-ack]")) return r.ack();
		if (q("[data-rd-object]")) return replyIn("object");
		const a = q("[data-rd-act]");
		if (a) return quiet(a.dataset.rdAct);
		const later = q("[data-rd-later]");
		if (later) return r.defer(later.dataset.rdLater);
		if (q("[data-rd-later-off]")) { r.later = false; return r.render(); }
		const mode = q("[data-rd-mode]");
		if (mode) return replyIn(mode.dataset.rdMode);
		if (q("[data-rd-reply-send]")) return sendReply();
		if (q("[data-rd-edit-brief]")) return editBrief(true);
		if (q("[data-rd-add-image]")) return fileInput.click();
		if (q("[data-rd-earlier]")) { r.allNotes = true; return r.render(); }
		if (q("[data-rd-create]")) return create();
		if (q("[data-rd-cancel]")) return opts.close?.();
		const un = q("[data-rd-unpend]");
		if (un) { const [p] = r.pending.splice(Number(un.dataset.rdUnpend), 1); URL.revokeObjectURL(p.url); return r.render(); }
		const rm = q("[data-rd-unimage]");
		if (rm && confirm("Remove this picture?")) api(`/api/images/${rm.dataset.rdUnimage}`, { method: "DELETE" }).then((it) => { r.take(it); loadItems(); }).catch((err) => r.error(err.message));
	});
	host.addEventListener("change", (e) => {
		const t = e.target;
		if (t.matches("[data-rd-tick]")) { askTick(r.item, t.value, t.checked); return r.render(); }
		if (t.matches("[data-rd-to-agent]")) {
			const id = r.item?.id;
			if (t.checked) r.toAgent.add(id); else r.toAgent.delete(id);
			return r.render();
		}
		if (t.matches("[data-rd-resume]")) {
			const id = r.item?.id;
			if (t.checked) r.resume.add(id); else r.resume.delete(id);
			return r.render();
		}
		if (t.matches("[data-rd-later-date]") && t.value) return r.defer(t.value);
		if (t.matches("[data-cap]")) return api(`/api/images/${t.dataset.cap}`, { method: "PATCH", body: JSON.stringify({ caption: t.value }) }).then((it) => r.take(it)).catch((err) => r.error(err.message));
		const field = t.dataset.field;
		if (!field || !t.closest('[data-slot="props"]') || t.closest(".rd-sec")?._sec?.wire) return;
		const v = field === "priority" ? Number(t.value) : field === "options" ? t.value.split("\n").map((o) => o.trim()).filter(Boolean) : t.value;
		r.set({ [field]: field === "options" && r.compose ? JSON.stringify(v) : v });
	});
	host.addEventListener("input", (e) => {
		const t = e.target;
		if (t.matches("[data-pending]")) r.pending[Number(t.dataset.pending)].caption = t.value;
		if (r.compose && t.matches("[data-rd-title]")) r.draft.title = t.value.replace(/\s*[\r\n]+\s*/g, " ");
		if (r.compose && t.matches("[data-rd-brief]")) r.draft.body = t.value;
	});
	host.addEventListener("focusout", (e) => {
		const t = e.target;
		if (t.matches("[data-rd-title]")) saveTitle(t);
		else if (t.matches("[data-rd-brief]") && !r.compose) {
			// Clicking Add image while editing keeps the editor open.
			if (e.relatedTarget?.matches?.("[data-rd-add-image]")) return;
			saveBrief(t);
		}
	});
	host.addEventListener("keydown", (e) => {
		const t = e.target, k = e.key, mod = e.ctrlKey || e.metaKey;
		if (k === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			if (t.matches?.("[data-rd-brief]") && !r.compose) { r.briefEdit = false; return r.render(); }
			if (t.matches?.("[data-rd-title]") && !r.compose) { t.value = r.item?.title ?? ""; return t.blur(); }
			if (t.matches?.("[data-rd-reply]") && (t.value.trim() || r.mode)) { if (r.mode === "giveback") { r.mode = ""; r.render(); } return scroller.focus(); }
			if (r.later) { r.later = false; return r.render(); }
			if (rdTyping(t) && !r.compose) return scroller.focus();
			return opts.close?.();
		}
		if (r.compose && mod && k === "Enter") { e.preventDefault(); if (t.matches?.("[data-rd-title]")) r.draft.title = t.value.trim(); if (t.matches?.("[data-rd-brief]")) r.draft.body = t.value; return create(); }
		if (t.matches?.("[data-rd-title]") && k === "Enter" && !e.isComposing) { e.preventDefault(); if (!r.compose) { saveTitle(t); scroller.focus(); } else $("[data-rd-brief]", host)?.focus(); return; }
		if (t.matches?.("[data-rd-brief]") && mod && k === "Enter") { e.preventDefault(); return saveBrief(t); }
		if (t.matches?.("[data-rd-reply]") && k === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); return sendReply(); }
		if (t.matches?.("input.cap") && k === "Enter") { e.preventDefault(); return t.blur(); }
		if (t.matches?.("input[data-field]") && k === "Enter") { e.preventDefault(); return t.blur(); }
		if (rdTyping(t) || mod || e.altKey || r.compose) return;
		// A held key repeats: only J and K may; and nothing else while an answer is on its way.
		if ((e.repeat || r.busy) && !/^[jk]$/i.test(k)) { e.preventDefault(); return; }
		const low = k.length === 1 ? k.toLowerCase() : k;
		const key = (fn) => { e.preventDefault(); fn(); };
		if (r.later) {
			if (low === "d" || k === "Enter") return key(() => r.defer("tomorrow"));
			if (k === "3") return key(() => r.defer("in 3 days"));
			if (low === "w") return key(() => r.defer("next week"));
			return;
		}
		if (low === "j") return key(() => opts.nav?.(1));
		if (low === "k") return key(() => opts.nav?.(-1));
		if (low === "e") return key(() => editBrief(true));
		if (/^[1-9]$/.test(k)) return key(() => choose(Number(k) - 1));
		const i = r.item;
		if (!i?.id) return;
		if (low === "r") return key(() => replyIn(r.mode));
		if (low === "o" && askOpen(i) && ASK_KINDS.includes(i.kind)) return key(() => replyIn(i.kind === "decision" ? "answer" : "object"));
		if (low === "a" && askOpen(i) && (i.kind === "review" || i.kind === "notice")) return key(() => r.ack());
		if (low === "m") return key(() => quiet("done"));
		if (low === "x") return key(() => quiet("drop"));
		if (low === "d") return key(() => quiet("later"));
		if (low === "g") return key(() => quiet("giveback"));
	});
	fileInput.addEventListener("change", () => { if (fileInput.files.length) addImages(fileInput.files); fileInput.value = ""; });
	host.addEventListener("paste", (e) => {
		const files = [...(e.clipboardData?.files || [])].filter((f) => RD_IMAGE_TYPES.includes(f.type));
		if (!files.length) return;
		e.preventDefault();
		addImages(files);
	});
	const dragsFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
	host.addEventListener("dragover", (e) => { if (dragsFiles(e)) { e.preventDefault(); host.classList.add("rd-dropping"); } });
	host.addEventListener("dragleave", (e) => { if (!host.contains(e.relatedTarget)) host.classList.remove("rd-dropping"); });
	host.addEventListener("drop", (e) => {
		host.classList.remove("rd-dropping");
		if (!dragsFiles(e)) return;
		e.preventDefault();
		addImages(e.dataTransfer.files);
	});
	r.focus = () => scroller.focus({ preventScroll: true });
	/** The run box's "Tell the agent…": the reply box, with "send to the agent" ticked. */
	r.tellAgentBox = () => { const i = r.item; if (!i?.id || !canContinueIt(i)) return; r.toAgent.add(i.id); replyIn("note"); };
	return r;
}
const rdLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ---------- The sheet: the reader over the board ---------- */

// A sheet from the right on a computer, full screen on a phone. Its address is #item/wb-xxxx, so a link or a reload
// opens it; closing it goes back to where you were. J and K go through the list it was opened from.
const sheetDlg = document.createElement("dialog");
sheetDlg.id = "reader";
sheetDlg.className = "rd-sheet";
sheetDlg.setAttribute("aria-label", "Item");
document.body.append(sheetDlg);
// Where the address was before the sheet opened, and whether opening it added a step to the history.
let sheetUnder = "", sheetPushed = false, routeSkip = null;
// The order it was opened from, for J and K (openItemById's `list`).
let sheetList = null;
const sheet = createReader(sheetDlg, {
	close: () => closeSheet(),
	nav: (dir) => sheetNav(dir),
});
const sheetBase = () => location.pathname + location.search;
const readerOpen = () => sheetDlg.open;

function sheetShow(item, fromRoute = false) {
	const was = sheetDlg.open;
	if (!was) {
		sheetUnder = fromRoute ? "" : location.hash;
		sheetPushed = false;
		sheetDlg.showModal();
	}
	const h = item.ref ? `#item/wb-${item.ref}` : "";
	if (h && !fromRoute && location.hash !== h) {
		if (was) history.replaceState(null, "", sheetBase() + h);
		else { history.pushState(null, "", sheetBase() + h); sheetPushed = true; }
	}
	sheet.show(item);
	if (!was) sheet.focus();
}
/**
 * Opens an item at once from what the board already has (state.items), then fills in what the list leaves out: the
 * history, the pictures, what it waits on, and a closed item's details. One the board doesn't list (another
 * project's, tidied away) waits for the server. `key` is an id or a ref (wb-k3f9, k3f9).
 * `list`: the order it was opened from, for J and K (the board's cards, the queue, Today's lines, search results):
 * an array of ids or refs, or a function that gives one when asked. Without it, J and K do nothing.
 * `route`: opened by the address (#item/wb-k3f9), which stays as it is.
 */
async function openItemById(key, { list = null, route = false } = {}) {
	const k = String(key).replace(/^wb-/i, "").toLowerCase();
	const known = state.items.find((i) => String(i.id) === k || i.ref === k);
	const item = known ? { ...known, loading: true } : await api(`/api/items/${encodeURIComponent(k)}`);
	sheetList = list;
	sheetDlg.classList.toggle("rd-nolist", !list);
	sheetShow(item, route);
}
function openNewItem() {
	if (!sheetDlg.open) { sheetUnder = location.hash; sheetPushed = false; sheetDlg.showModal(); }
	sheet.composeNew({
		kind: "task", owner: setting("owner.task") ?? "agent", priority: 2,
		project: state.project || state.report?.project || state.projects[0]?.slug || "",
	});
}
function closeSheet({ nav = true } = {}) {
	if (!sheetDlg.open) return;
	if (sheet.composing() && !confirm("Leave this new item without creating it?")) return;
	document.activeElement?.blur?.();
	sheet.leave();
	sheetDlg.close();
	if (nav && /^#item\//.test(location.hash)) {
		if (sheetPushed) { routeSkip = sheetUnder; history.back(); }
		else { history.replaceState(null, "", sheetBase() + sheetUnder); route(); }
	}
	sheetPushed = false;
	hookRun(hooks.readerClosed);
}
// J and K: the next or previous item in the order the reader was opened from; nothing when it wasn't from a list.
function sheetNav(dir) {
	if (!sheetList) return;
	const keys = [...new Set((typeof sheetList === "function" ? sheetList() : sheetList).map((k) => String(k).replace(/^wb-/i, "").toLowerCase()))];
	const at = keys.findIndex((k) => k === String(sheet.item?.id) || k === sheet.item?.ref);
	const next = at < 0 ? (dir > 0 ? keys[0] : undefined) : keys[at + dir];
	if (next !== undefined) openItemById(next, { list: sheetList }).catch((e) => toast(e.message));
}
/** route() asks this first (report.js): #item/wb-xxxx opens the reader over the view that's showing. */
function readerRoute() {
	const h = location.hash;
	if (routeSkip !== null) { const skip = routeSkip === h; routeSkip = null; if (skip) return true; }
	const m = h.match(/^#item\/(?:wb-)?([a-z0-9]+)$/i);
	if (m) {
		if (!viewShown) { showView("board"); document.title = "Workbench"; renderRail(); }
		if (!sheetDlg.open || sheet.item?.ref !== m[1].toLowerCase()) openItemById(m[1], { route: true }).catch(() => { toast(`wb-${m[1]} isn't on the board.`); if (sheetDlg.open) closeSheet(); else history.replaceState(null, "", sheetBase()); });
		return true;
	}
	if (sheetDlg.open) {
		// Back (or a link inside it) while it's open: it closes, and the view under it stays as it was.
		const under = sheetUnder;
		closeSheet({ nav: false });
		if (h === under) return true;
	}
	return false;
}
/** Shows the reader's item again if it's `id` (after a change made elsewhere on the page). */
function readerRefresh(id) { if (sheetDlg.open && (id === undefined || sheet.item?.id === Number(id))) sheet.reload(); }
/** Draws the reader again from what the page knows (ui/dispatch.js, once it learns more of the item's runs). */
function readerRedraw(id) { if (sheetDlg.open && sheet.item?.id === Number(id)) sheet.render(); }
/** The run box's "Tell the agent…" (ui/dispatch.js): the reply box, set to send to the agent. */
function readerTellAgent(id) { if (sheetDlg.open && sheet.item?.id === Number(id)) sheet.tellAgentBox(); }

sheetDlg.addEventListener("cancel", (e) => { e.preventDefault(); closeSheet(); });
// A click on the dimmed board beside the sheet closes it; press and release must both land there, so a text
// selection dragged out of the sheet doesn't.
const outsideSheet = (e) => {
	const b = sheetDlg.getBoundingClientRect();
	return e.target === sheetDlg && (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom);
};
let sheetPressedOut = false;
sheetDlg.addEventListener("pointerdown", (e) => { sheetPressedOut = outsideSheet(e); });
sheetDlg.addEventListener("click", (e) => { if (sheetPressedOut && outsideSheet(e)) closeSheet(); sheetPressedOut = false; });
// The board's poll goes on while it's open: the item is asked for again (a 304 when nothing changed) and drawn
// again where it changed, never in the box you're typing in.
hooks.refresh.push(() => { if (sheetDlg.open && !sheet.compose) sheet.reload(); });
$("#new").onclick = openNewItem;
