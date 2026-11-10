// Phase-1 probe, injected into every frame of the board's window when WB_APP_PROBE=1 (debug builds only,
// see probe.rs). The top frame answers steps that Rust asks for with `window.__wbProbe.step(name, arg)`;
// frames (the report iframe) report what they can reach to the top frame, which passes it on.
// Results go to Rust through the debug-only `probe_result` command, or, when IPC is refused, through the
// document title ("wbprobe:" + JSON), which Rust watches.
(() => {
	if (window.__wbProbe) return;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const errStr = (e) => (e && (e.message || String(e))) || String(e);
	// In every text the probe copies, so a reading can't be mistaken for an earlier run's (GNOME keeps the
	// clipboard after the app that set it quits).
	const NONCE = Math.random().toString(36).slice(2, 7);
	const kind = (v) => (v === undefined ? "undefined" : v === null ? "null" : typeof v);

	// ---------- frames (the report iframe and any other) ----------
	if (window.top !== window) {
		const post = (key, value) => parent.postMessage({ wbprobe: 1, key, value }, "*");
		const forged = (key) => JSON.stringify({
			cmd: "probe_result", callback: 1, error: 2, options: {},
			payload: { key, value: "forged from the iframe" }, __TAURI_INVOKE_KEY__: "guess",
		});
		addEventListener("load", async () => {
			await sleep(300);
			let topInternals;
			try { topInternals = kind(window.top.__TAURI_INTERNALS__); } catch (e) { topInternals = "blocked: " + errStr(e); }
			post("info", {
				origin: location.origin, href: location.href, secure: isSecureContext,
				internals: kind(window.__TAURI_INTERNALS__), global: kind(window.__TAURI__), isTauri: kind(window.isTauri),
				windowIpc: kind(window.ipc), webkitIpc: kind(window.webkit?.messageHandlers?.ipc), topInternals,
				textLength: (document.body?.innerText || "").length, wb: kind(window.wb),
			});
			if (window.__TAURI_INTERNALS__?.invoke) {
				try { post("invoke", { ok: await window.__TAURI_INTERNALS__.invoke("app_info") }); } catch (e) { post("invoke", { error: errStr(e) }); }
			} else post("invoke", { error: "no __TAURI_INTERNALS__ in the frame" });
			try {
				const r = await fetch("ipc://localhost/app_info", {
					method: "POST", body: "{}",
					headers: { "Content-Type": "application/json", "Tauri-Callback": "1", "Tauri-Error": "2", "Tauri-Invoke-Key": "guess" },
				});
				post("fetchIpc", { status: r.status, body: (await r.text()).slice(0, 200) });
			} catch (e) { post("fetchIpc", { error: errStr(e) }); }
			try {
				if (window.ipc?.postMessage) { window.ipc.postMessage(forged("frame.forged.windowIpc")); post("windowIpc", { sent: true }); }
				else post("windowIpc", { sent: false });
			} catch (e) { post("windowIpc", { error: errStr(e) }); }
			try {
				const h = window.webkit?.messageHandlers?.ipc;
				if (h) { h.postMessage(forged("frame.forged.webkitIpc")); post("webkitIpc", { sent: true }); }
				else post("webkitIpc", { sent: false });
			} catch (e) { post("webkitIpc", { error: errStr(e) }); }
			try {
				const items = await window.wb.items({ project: "*" });
				post("bridge", { ok: true, items: items.length });
			} catch (e) { post("bridge", { error: errStr(e) }); }
		});
		window.__wbProbe = { frame: true };
		return;
	}

	// ---------- top frame (the board) ----------
	let seq = 0;
	const queue = [];
	let pumping = false;
	async function pump() {
		pumping = true;
		while (queue.length) {
			document.title = "wbprobe:" + JSON.stringify(queue.shift());
			await sleep(60);
		}
		pumping = false;
	}
	async function send(key, value) {
		const msg = { seq: ++seq, key, value };
		const inv = window.__TAURI_INTERNALS__?.invoke;
		if (inv) {
			try { await inv("probe_result", { key, value }); return; } catch (e) { msg.ipcError = errStr(e); }
		} else msg.ipcError = "no __TAURI_INTERNALS__";
		queue.push(msg);
		if (!pumping) pump();
	}
	const tryInvoke = async (cmd, args) => {
		const I = window.__TAURI_INTERNALS__;
		if (!I?.invoke) return { error: "no __TAURI_INTERNALS__" };
		try { return { ok: await I.invoke(cmd, args) }; } catch (e) { return { error: errStr(e) }; }
	};
	const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => "timeout")]);
	// The board's own fallback (copyText in index.html), verbatim apart from the name.
	function execCopy(text) {
		const ta = Object.assign(document.createElement("textarea"), { value: text });
		ta.style.cssText = "position:fixed;opacity:0";
		(document.querySelector("dialog[open]") ?? document.body).append(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	}
	async function writeText(text) {
		try { await navigator.clipboard.writeText(text); return { ok: true }; } catch (e) { return { error: errStr(e) }; }
	}
	function download(href, name) {
		const a = Object.assign(document.createElement("a"), { href, download: name });
		document.body.append(a);
		a.click();
		a.remove();
	}
	const log = [];
	// Timer ticks per state: do timers keep running while the window is hidden (the board's 20 s notification check)?
	let ticks = 0;
	setInterval(() => ticks++, 250);
	for (const ev of ["visibilitychange", "pagehide", "pageshow"]) document.addEventListener(ev, () => log.push(`${ev}:${document.visibilityState}`));
	for (const ev of ["focus", "blur"]) window.addEventListener(ev, () => log.push(ev));
	addEventListener("message", (e) => {
		if (e.data?.wbprobe === 1) send("frame." + e.data.key, { ...e.data.value, messageOrigin: e.origin });
	});

	const steps = {
		async boot() {
			send("boot", { nonce: NONCE,
				href: location.href, title: document.title, textLength: document.body.innerText.length, ua: navigator.userAgent, secure: isSecureContext, subtle: !!crypto.subtle,
				isTauri: kind(window.isTauri), internals: kind(window.__TAURI_INTERNALS__), global: kind(window.__TAURI__),
				globalCore: kind(window.__TAURI__?.core?.invoke), globalEvent: kind(window.__TAURI__?.event?.listen),
				windowIpc: kind(window.ipc), webkitIpc: kind(window.webkit?.messageHandlers?.ipc),
				notification: "Notification" in window, permission: window.Notification?.permission,
				bellHidden: document.querySelector("#notify")?.hidden, clipboardApi: kind(navigator.clipboard?.writeText),
				visibility: document.visibilityState, hasFocus: document.hasFocus(),
			});
			send("ipc.app_info", await tryInvoke("app_info"));
			send("ipc.notGranted", await tryInvoke("plugin:window|is_visible", { label: "main" }));
			send("ipc.unknownCommand", await tryInvoke("nope_not_a_command"));
			try {
				await window.__TAURI__.event.listen("notification-clicked", (e) => send("event.notification-clicked", e.payload));
				await window.__TAURI__.event.listen("wbprobe-ping", (e) => send("event.wbprobe-ping", e.payload));
				send("event.listen", { ok: true });
			} catch (e) { send("event.listen", { error: errStr(e) }); }
			// No user gesture anywhere in here: this runs from the load event and timers.
			if ("Notification" in window) {
				const before = Notification.permission;
				let req;
				try { req = await withTimeout(Notification.requestPermission(), 3000); } catch (e) { req = "threw: " + errStr(e); }
				send("webnotif.boot", { before, requestPermission: req, after: Notification.permission });
			} else send("webnotif.boot", { notification: false });
			await send("clip.nogesture.writeText", await writeText(`wbprobe-nogesture-writeText-${NONCE}`));
			await sleep(1500);
			await send("clip.nogesture.execCommand", { ok: execCopy(`wbprobe-nogesture-execCommand-${NONCE}`) });
			await sleep(1500);
			send("boot.done", true);
		},
		async ipcAgain(label) {
			send("ipc.app_info." + label, { href: location.href, ...(await tryInvoke("app_info")) });
		},
		async crypto() {
			const te = new TextEncoder();
			const t0 = performance.now();
			const base = await crypto.subtle.importKey("raw", te.encode("probe password"), "PBKDF2", false, ["deriveBits"]);
			const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: crypto.getRandomValues(new Uint8Array(16)), iterations: 600000 }, base, 512));
			const t1 = performance.now();
			const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode("hello vault"));
			const pt = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
			send("crypto", { secure: isSecureContext, pbkdf2Ms: Math.round(t1 - t0), totalMs: Math.round(performance.now() - t0), roundTrip: pt === "hello vault", canVault: window.isSecureContext && !!crypto.subtle });
		},
		// Run through Rust's eval: does WebKit count script it's handed by the app as a user gesture?
		async evalClip() {
			await send("clip.eval.writeText", await writeText(`wbprobe-eval-writeText-${NONCE}`));
		},
		// A button in the top left corner that Rust clicks with a synthetic GDK button event.
		target(mode) {
			let b = document.getElementById("wbprobe-btn");
			if (!b) {
				b = document.createElement("button");
				b.id = "wbprobe-btn";
				b.style.cssText = "position:fixed;left:0;top:0;width:200px;height:80px;z-index:2147483647;background:#f0b45a;color:#000;font:14px system-ui";
				document.documentElement.append(b);
			}
			b.textContent = "probe: " + mode;
			b.onclick = async (e) => {
				const trusted = e.isTrusted, hasFocus = document.hasFocus();
				if (mode === "writeText") send("clip.click.writeText", { trusted, hasFocus, text: `wbprobe-click-writeText-${NONCE}`, ...(await writeText(`wbprobe-click-writeText-${NONCE}`)) });
				else if (mode === "execCommand") send("clip.click.execCommand", { trusted, hasFocus, text: `wbprobe-click-execCommand-${NONCE}`, ok: execCopy(`wbprobe-click-execCommand-${NONCE}`) });
				else if (mode === "boardCopy") send("clip.click.boardCopy", { trusted, hasFocus, text: `wbprobe-click-boardCopy-${NONCE}`, ok: typeof copyText === "function" ? await copyText(`wbprobe-click-boardCopy-${NONCE}`) : "no copyText" });
				else if (mode === "notifPerm") {
					let r;
					try { r = await withTimeout(Notification.requestPermission(), 3000); } catch (err) { r = "threw: " + errStr(err); }
					send("webnotif.click", { trusted, requestPermission: r, after: Notification.permission });
				}
			};
			send("target." + mode, { ready: true, rect: b.getBoundingClientRect().toJSON() });
		},
		untarget() { document.getElementById("wbprobe-btn")?.remove(); },
		// The board's own path: new Notification + onclick (ping() in index.html).
		async webNotification() {
			const r = { permission: window.Notification?.permission };
			try {
				const n = new Notification("wbprobe web", { body: "WebKit's own Notification, from the probe", tag: "wbprobe-web", icon: "/favicon.svg" });
				n.onshow = () => send("webnotif.onshow", true);
				n.onerror = () => send("webnotif.onerror", true);
				n.onclick = () => send("webnotif.onclick", { hasFocus: document.hasFocus() });
				n.onclose = () => send("webnotif.onclose", true);
				window.__wbProbeNotification = n;
				r.constructed = true;
			} catch (e) { r.error = errStr(e); }
			send("webnotif.construct", r);
		},
		closeWebNotification() { window.__wbProbeNotification?.close(); },
		async notify() {
			send("notify.invoke", await tryInvoke("notify", { title: "Workbench probe", body: "From the desktop app's probe: <b>markup</b> & escaping. It closes by itself.", tag: "wbprobe-own", target: { item: 1 } }));
		},
		async download(what) {
			if (what === "backup") {
				// Settings → Data → Backups lists these from /api/data and links each as <a download>.
				const r = await fetch("/api/data");
				const j = await r.json();
				const name = j.backups?.list?.[0]?.name;
				if (!name) return send("download.backup", { error: "no backups", status: r.status });
				download(`/api/data/backups/${encodeURIComponent(name)}`, name);
				send("download.backup", { name });
			} else if (what === "export") {
				download("/api/data/export", "");
				send("download.export", { started: true });
			} else if (what === "blob") {
				const href = URL.createObjectURL(new Blob(["WBPROBE=1\n"], { type: "text/plain" }));
				download(href, "wbprobe.env");
				setTimeout(() => URL.revokeObjectURL(href), 1000);
				send("download.blob", { href });
			}
		},
		vis(label) {
			send("vis." + label, { visibility: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(), events: log.splice(0), ticks250ms: ticks, at: Math.round(performance.now()) });
		},
		async report() {
			const reps = await (await fetch("/api/reports")).json();
			if (!reps.length) return send("frame.none", true);
			location.hash = `#report/${reps[0].id}`;
			send("frame.opened", { id: reps[0].id, title: reps[0].title });
		},
	};
	window.__wbProbe = {
		step(name, arg) {
			Promise.resolve().then(() => steps[name](arg)).catch((e) => send("error." + name, errStr(e)));
		},
	};
	addEventListener("load", () => setTimeout(() => window.__wbProbe.step("boot"), 1500));
})();
