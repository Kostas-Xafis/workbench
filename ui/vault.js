/* ---------- Vault ---------- */

// Secrets are encrypted here in the browser, with a key derived from the vault password. The server keeps
// ciphertext and a hash of an auth token derived next to the key, never the password. Unlocking shows the
// names; every value asks for the password again. Leaving the vault, or a few idle minutes, locks it.
const ITERATIONS = 600_000;
// Settings → Privacy and security; read each time a timer starts, so an open vault picks a change up on its next one.
const lockMinutes = () => setting("vault.lock-minutes") ?? 5;
const showSeconds = () => setting("vault.show-seconds") ?? 20;
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (bytes) => btoa(Array.from(new Uint8Array(bytes), (b) => String.fromCharCode(b)).join(""));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
// `then` is what to do right after unlocking ("rekey" when Settings → Privacy and security sent you here).
const vault = { info: undefined, error: "", key: null, auth: null, secrets: [], shown: new Map(), idle: 0, then: null };
// WebCrypto exists only in a secure context: localhost, not the LAN address of `wb serve --lan`.
const canVault = () => window.isSecureContext && !!crypto.subtle;
const ICON = {
	lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
	eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
	hide: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><path d="m2.5 2.5 11 11"/>',
	copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
	edit: '<path d="M10.5 2.5l3 3-8 8H2.5v-3z"/>',
	duplicate: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5M9.5 7.5v4M7.5 9.5h4"/>',
	trash: '<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9"/>',
};
const icon = (name) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.4">${ICON[name]}</g></svg>`;

async function deriveVault(password, salt = vault.info.salt, iterations = vault.info.iterations) {
	const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(salt), iterations }, base, 512));
	return {
		key: await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]),
		auth: Array.from(bits.slice(32), (b) => b.toString(16).padStart(2, "0")).join(""),
	};
}
async function seal(key, data) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	return `${b64(iv)}.${b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(data))))}`;
}
async function unseal(key, sealed) {
	const [iv, ct] = sealed.split(".");
	return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct))));
}
const vaultApi = (path, auth, opts = {}) => api(path, { ...opts, headers: { "x-vault-auth": auth } });
const newSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)));

async function loadSecrets() {
	const rows = await vaultApi("/api/secrets", vault.auth);
	vault.secrets = await Promise.all(rows.map(async (r) => ({ ...r, ...(await unseal(vault.key, r.meta)) })));
}

function lockVault() {
	vault.then = null;
	clearTimeout(vault.idle);
	for (const s of vault.shown.values()) clearTimeout(s.timer);
	vault.shown.clear();
	if (!vault.key) return;
	vault.key = vault.auth = null;
	vault.secrets = [];
	closePassword(); closeSecret(); closeRekey(); closeEnv();
	if (!$("#vault-view").hidden) renderVault();
}
function touchVault() {
	clearTimeout(vault.idle);
	if (vault.key) vault.idle = setTimeout(lockVault, lockMinutes() * 60e3);
}

async function openVault() {
	// Asked again whenever it's locked: `wb vault reset` may have started it over.
	if (canVault() && !vault.key) {
		try { vault.info = await api("/api/vault"); } catch (e) { vault.error = e.message; }
	}
	renderVault();
}

function vaultTimesText() {
	const m = lockMinutes(), s = showSeconds();
	return `Locks when you leave the vault or after ${m} idle minute${m === 1 ? "" : "s"}. A shown value hides again after ${s} seconds.`;
}

const vaultCard = (title, text, form = "") =>
	`<div class="vault-card"><div class="vault-ic">${icon("lock")}</div><h2>${title}</h2><p>${text}</p>${form}</div>
	<button class="ghost sm vault-back" data-act="board">← Back to the board</button>`;

function renderVault() {
	const el = $("#vault-view");
	if (!canVault()) {
		el.innerHTML = vaultCard("Vault unavailable here", `The vault opens only on this computer, at <a href="http://localhost:${esc(location.port)}/#vault">localhost</a>. On this address the browser offers no encryption, and secrets shouldn't cross the network.`);
		return;
	}
	if (vault.error) { el.innerHTML = vaultCard("Vault unavailable", esc(vault.error)); return; }
	if (vault.info === undefined) { el.innerHTML = vaultCard("Vault", "Loading…"); return; }
	if (!vault.info) {
		el.innerHTML = vaultCard("Set up the vault", "Choose a password for your secrets. It is never stored or sent anywhere: secrets are encrypted with it right here, and the board keeps only the encrypted text.",
			`<form id="vault-setup" autocomplete="off">
				<input class="pw-input" type="password" name="pw" required placeholder="Vault password (10+ characters)" autocomplete="off">
				<input class="pw-input" type="password" name="pw2" required placeholder="Same password again" autocomplete="off">
				<div class="caution">Forget it and the secrets are gone for good: nobody can recover them.</div>
				<div class="error"></div><button class="primary">Create vault</button></form>`);
		return el.querySelector("input").focus();
	}
	if (!vault.key) {
		el.innerHTML = vault.then === "rekey"
			? vaultCard("Change the vault password", "Enter the current password first. Then you choose the new one, and every secret is encrypted again under it.",
				`<form id="vault-unlock" autocomplete="off"><input class="pw-input" type="password" name="pw" required placeholder="Current password" autocomplete="off" aria-label="Current password">
				<div class="error"></div><button class="primary">Continue</button></form>`)
			: vaultCard("The vault is locked", "Enter the vault password to see your secrets' names. Showing or copying a value asks for it again.",
			`<form id="vault-unlock" autocomplete="off"><input class="pw-input" type="password" name="pw" required placeholder="Vault password" autocomplete="off">
				<div class="error"></div><button class="primary">Unlock</button></form>`);
		return el.querySelector("input").focus();
	}
	const visible = vault.secrets.filter((s) => !state.project || !s.project || s.project === state.project)
		.sort((a, b) => a.name.localeCompare(b.name));
	const scopes = state.project ? [state.project, ""] : ["", ...state.allProjects.map((p) => p.slug)];
	const row = (s) => {
		const shown = vault.shown.get(s.id);
		return `<div class="secret" data-secret="${s.id}">
			<div class="s-main"><b>${esc(s.name)}</b>${s.note ? `<small>${esc(s.note)}</small>` : ""}</div>
			<code class="s-val ${shown ? "shown" : ""}">${shown ? esc(shown.value) : "••••••••••••••••"}</code>
			<div class="s-tools">
				<button class="icon-btn" data-act="show" title="${shown ? "Hide" : "Show"}" aria-label="${shown ? "Hide" : "Show"}">${icon(shown ? "hide" : "eye")}</button>
				<button class="icon-btn" data-act="copy" title="Copy" aria-label="Copy">${icon("copy")}</button>
				<button class="icon-btn" data-act="edit" title="Edit" aria-label="Edit">${icon("edit")}</button>
				<button class="icon-btn" data-act="duplicate" title="Duplicate" aria-label="Duplicate">${icon("duplicate")}</button>
				<button class="icon-btn" data-act="delete" title="Delete" aria-label="Delete">${icon("trash")}</button>
			</div></div>`;
	};
	const groups = scopes.map((slug) => [slug, visible.filter((s) => s.project === slug)]).filter(([, list]) => list.length)
		.map(([slug, list]) => `<div class="v-group">${esc(slug ? projectName(slug) : "Every project")}</div>${list.map(row).join("")}`).join("");
	el.innerHTML = `<div class="vault-head"><button class="ghost sm" data-act="board">← Board</button><div><h2>Secrets</h2><small>${esc(state.project ? `${projectName(state.project)}, and those shared with every project` : "All projects")}</small></div>
		<span class="spacer"></span>
		<button class="primary sm" data-act="add">+ Add secret</button>
		<button class="ghost sm" data-act="env"${visible.length ? "" : " disabled"}>Export .env</button>
		<button class="ghost sm" data-act="rekey">Change password</button>
		<button class="ghost sm" data-act="lock">${icon("lock")} Lock</button></div>
		<div class="vault-body">${groups || `<div class="empty">No secrets ${state.project ? "for this project " : ""}yet.</div>`}
		<p class="hint">${esc(vaultTimesText())} <a href="#settings/privacy">Change</a></p></div>`;
}

// Asks for the vault password again; resolves to the derived key and token, or null if cancelled.
let pwResolve = null;
function askPassword(title) {
	return new Promise((resolve) => {
		pwResolve = resolve;
		touchVault();
		$("#pw-title").textContent = title;
		$("#pw-form").pw.value = "";
		$("#pw-err").textContent = "";
		$("#pw-dlg").showModal();
	});
}
$("#pw-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const btn = e.target.querySelector(".primary");
	btn.disabled = true;
	try {
		const d = await deriveVault(e.target.pw.value);
		if (d.auth !== vault.auth) { $("#pw-err").textContent = "Wrong password."; e.target.pw.select(); return; }
		const resolve = pwResolve;
		pwResolve = null;
		$("#pw-dlg").close();
		$("#pw-form").pw.value = "";
		resolve(d);
	} finally { btn.disabled = false; }
});
// Each vault dialog is closed through one function that wipes it at once; "close" (Escape) does the same,
// but that event waits for the next frame, and secret text shouldn't.
function closePassword() {
	$("#pw-form").pw.value = "";
	if (pwResolve) { pwResolve(null); pwResolve = null; }
	if ($("#pw-dlg").open) $("#pw-dlg").close();
}
$("#pw-cancel").onclick = closePassword;
$("#pw-dlg").addEventListener("close", closePassword);

async function secretValue(s, why) {
	const shown = vault.shown.get(s.id);
	if (shown) return shown.value;
	const creds = await askPassword(`${why} “${s.name}”: vault password`);
	if (!creds) return null;
	const { value } = await vaultApi(`/api/secrets/${s.id}`, creds.auth);
	return (await unseal(creds.key, value)).value;
}
function showSecret(id, value) {
	clearTimeout(vault.shown.get(id)?.timer);
	vault.shown.set(id, { value, timer: setTimeout(() => { vault.shown.delete(id); renderVault(); }, showSeconds() * 1e3) });
	renderVault();
}
let toastTimer;
function toast(text) {
	const t = $("#toast");
	t.textContent = text;
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (t.hidden = true), 1800);
}

const secretDlg = $("#secret-dlg");
const secretForm = $("#secret-form");
let currentSecret = null;
function openSecret(s) {
	currentSecret = s;
	touchVault();
	setOptions(secretForm.project, [{ value: "", label: "Every project" }, ...state.allProjects.map((p) => ({ value: p.slug, label: p.name }))]);
	secretForm.name.value = s.name ?? "";
	secretForm.value.value = s.value ?? "";
	secretForm.note.value = s.note ?? "";
	secretForm.project.value = s.project ?? "";
	$("#secret-title").textContent = s.id ? "Edit secret" : s.copyOf ? `Duplicate ${s.copyOf}` : "New secret";
	$("#secret-err").textContent = "";
	secretDlg.showModal();
	secretForm.name.focus();
	if (s.copyOf) secretForm.name.select();
}
secretForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	try {
		const body = JSON.stringify({
			project: secretForm.project.value,
			meta: await seal(vault.key, { name: secretForm.name.value.trim(), note: secretForm.note.value.trim() }),
			value: await seal(vault.key, { value: secretForm.value.value }),
		});
		if (currentSecret.id) await vaultApi(`/api/secrets/${currentSecret.id}`, vault.auth, { method: "PATCH", body });
		else await vaultApi("/api/secrets", vault.auth, { method: "POST", body });
		vault.shown.delete(currentSecret.id);
		closeSecret();
		await loadSecrets();
		renderVault();
	} catch (err) { $("#secret-err").textContent = err.message; }
});
function closeSecret() {
	secretForm.reset();
	currentSecret = null;
	if (secretDlg.open) secretDlg.close();
}
$("#secret-cancel").onclick = closeSecret;
// The value doesn't stay in the form once it's closed.
secretDlg.addEventListener("close", closeSecret);

const rekeyDlg = $("#rekey-dlg");
const rekeyForm = $("#rekey-form");
// `fresh`: the current password was typed a moment ago to unlock for this, so it isn't asked again.
let rekeyFresh = false;
function openRekey(fresh) {
	rekeyFresh = fresh && !!vault.key;
	rekeyForm.cur.hidden = rekeyForm.cur.disabled = rekeyFresh;
	touchVault();
	rekeyDlg.showModal();
	(rekeyFresh ? rekeyForm.pw : rekeyForm.cur).focus();
}
rekeyForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const err = $("#rekey-err");
	const btn = rekeyForm.querySelector(".primary");
	if (rekeyForm.pw.value.length < 10) return (err.textContent = "Use at least 10 characters.");
	if (rekeyForm.pw.value !== rekeyForm.pw2.value) return (err.textContent = "The new passwords don't match.");
	btn.disabled = true;
	err.textContent = "Re-encrypting…";
	try {
		const old = rekeyFresh ? { key: vault.key, auth: vault.auth } : await deriveVault(rekeyForm.cur.value);
		if (old.auth !== vault.auth) return (err.textContent = "The current password is wrong.");
		const salt = newSalt();
		const nu = await deriveVault(rekeyForm.pw.value, salt, ITERATIONS);
		const rows = await vaultApi("/api/secrets", old.auth);
		const secrets = await Promise.all(rows.map(async (r) => {
			const { value } = await vaultApi(`/api/secrets/${r.id}`, old.auth);
			return { id: r.id, meta: await seal(nu.key, await unseal(old.key, r.meta)), value: await seal(nu.key, await unseal(old.key, value)) };
		}));
		vault.info = await vaultApi("/api/vault/rekey", old.auth, { method: "POST", body: JSON.stringify({ salt, iterations: ITERATIONS, auth: nu.auth, secrets }) });
		vault.key = nu.key;
		vault.auth = nu.auth;
		closeRekey();
		await loadSecrets();
		renderVault();
		toast("Vault password changed");
	} catch (e2) { err.textContent = e2.message; } finally { btn.disabled = false; }
});
function closeRekey() {
	rekeyForm.reset();
	rekeyFresh = false;
	rekeyForm.cur.hidden = rekeyForm.cur.disabled = false;
	$("#rekey-err").textContent = "";
	if (rekeyDlg.open) rekeyDlg.close();
}
$("#rekey-cancel").onclick = closeRekey;
rekeyDlg.addEventListener("close", closeRekey);

const vaultView = $("#vault-view");
vaultView.addEventListener("submit", async (e) => {
	e.preventDefault();
	const f = e.target;
	const err = f.querySelector(".error");
	const btn = f.querySelector(".primary");
	if (f.id === "vault-setup") {
		if (f.pw.value.length < 10) return (err.textContent = "Use at least 10 characters.");
		if (f.pw.value !== f.pw2.value) return (err.textContent = "The passwords don't match.");
	}
	btn.disabled = true;
	err.textContent = f.id === "vault-setup" ? "Creating…" : "Unlocking…";
	try {
		if (f.id === "vault-setup") {
			const salt = newSalt();
			const d = await deriveVault(f.pw.value, salt, ITERATIONS);
			vault.info = await api("/api/vault", { method: "POST", body: JSON.stringify({ salt, iterations: ITERATIONS, auth: d.auth }) });
			Object.assign(vault, d, { secrets: [] });
		} else {
			const d = await deriveVault(f.pw.value);
			const rows = await vaultApi("/api/secrets", d.auth);
			Object.assign(vault, d);
			vault.secrets = await Promise.all(rows.map(async (r) => ({ ...r, ...(await unseal(d.key, r.meta)) })));
		}
		touchVault();
		renderVault();
		// Just typed for this, so the change asks only for the new password.
		if (vault.then === "rekey") { vault.then = null; openRekey(true); }
	} catch (e2) {
		vault.key = vault.auth = null;
		err.textContent = e2.message === "wrong password" ? "Wrong password." : e2.message;
		f.pw.select();
	} finally { btn.disabled = false; }
});
vaultView.addEventListener("click", async (e) => {
	const b = e.target.closest("[data-act]");
	if (b?.dataset.act === "board") return goBoard();
	if (!b || !vault.key) return;
	const act = b.dataset.act;
	if (act === "env") return openEnv();
	if (act === "add") return openSecret({ project: state.project });
	if (act === "lock") return lockVault();
	if (act === "rekey") return openRekey(false);
	const s = vault.secrets.find((x) => x.id === Number(b.closest("[data-secret]")?.dataset.secret));
	if (!s) return;
	try {
		if (act === "show") {
			if (vault.shown.has(s.id)) { clearTimeout(vault.shown.get(s.id).timer); vault.shown.delete(s.id); return renderVault(); }
			const v = await secretValue(s, "Show");
			if (v != null) showSecret(s.id, v);
		} else if (act === "copy") {
			const v = await secretValue(s, "Copy");
			if (v != null && (await copyText(v))) toast(`Copied ${s.name}`);
		} else if (act === "edit") {
			const v = await secretValue(s, "Edit");
			if (v != null) openSecret({ ...s, value: v });
		} else if (act === "duplicate") {
			// A new secret prefilled from this one: nothing is saved until the form is.
			const v = await secretValue(s, "Duplicate");
			if (v != null) openSecret({ name: `${s.name}_COPY`, value: v, note: s.note, project: s.project, copyOf: s.name });
		} else if (act === "delete") {
			if (!confirm(`Delete the secret “${s.name}”? This can't be undone.`)) return;
			await vaultApi(`/api/secrets/${s.id}`, vault.auth, { method: "DELETE" });
			await loadSecrets();
			renderVault();
		}
	} catch (err) { toast(err.message); }
});
for (const ev of ["pointerdown", "keydown"]) vaultView.addEventListener(ev, touchVault);
// Usage opens for the project you're looking at (all of them under "All projects").
$("#usage-btn").onclick = (e) => {
	if (e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
	e.preventDefault();
	location.href = state.project ? `/usage?project=${encodeURIComponent(state.project)}` : "/usage";
};
$("#vault-btn").onclick = () => (location.hash === "#vault" ? goBoard() : (location.hash = "#vault"));

// .env export: pick secrets, enter the password once, then copy or download. The text leaves with the dialog.
const envDlg = $("#env-dlg");
const envName = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^(?=\d)/, "_");
function envValue(v) {
	if (/^[A-Za-z0-9_.\-\/:@+=,]*$/.test(v)) return v;
	if (!/['\n]/.test(v)) return `'${v}'`;
	return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/\n/g, "\\n")}"`;
}
function envSecrets() { return vault.secrets.filter((s) => !state.project || !s.project || s.project === state.project).sort((a, b) => a.name.localeCompare(b.name)); }
function openEnv() {
	touchVault();
	$("#env-title").textContent = `Export as .env${state.project ? ` · ${projectName(state.project)}` : ""}`;
	$("#env-list").innerHTML = envSecrets().map((s) => `<label><input type="checkbox" value="${s.id}" checked>${esc(envName(s.name))}${envName(s.name) !== s.name ? ` <small>from “${esc(s.name)}”</small>` : ""}</label>`).join("");
	$("#env-pick").hidden = false;
	$("#env-out").hidden = $("#env-download").hidden = true;
	$("#env-go").hidden = false;
	$("#env-err").textContent = "";
	envDlg.showModal();
}
$("#env-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const ids = [...$("#env-list").querySelectorAll("input:checked")].map((c) => Number(c.value));
	if (!ids.length) return ($("#env-err").textContent = "Pick at least one secret.");
	const creds = await askPassword(`Export ${ids.length} secret${ids.length > 1 ? "s" : ""}: vault password`);
	if (!creds) return;
	try {
		const lines = await Promise.all(vault.secrets.filter((s) => ids.includes(s.id)).sort((a, b) => a.name.localeCompare(b.name)).map(async (s) => {
			const { value } = await vaultApi(`/api/secrets/${s.id}`, creds.auth);
			const v = (await unseal(creds.key, value)).value;
			return `${s.note ? `# ${s.note.replace(/\n/g, " ")}\n` : ""}${envName(s.name)}=${envValue(v)}`;
		}));
		$("#env-out").value = lines.join("\n") + "\n";
		$("#env-pick").hidden = $("#env-go").hidden = true;
		$("#env-out").hidden = $("#env-download").hidden = false;
		$("#env-cancel").textContent = "Close";
		$("#env-out").select();
		if (await copyText($("#env-out").value)) toast("Copied the .env block");
	} catch (err) { $("#env-err").textContent = err.message; }
});
$("#env-download").onclick = () => {
	const a = Object.assign(document.createElement("a"), {
		href: URL.createObjectURL(new Blob([$("#env-out").value], { type: "text/plain" })),
		download: `${state.project || "workbench"}.env`,
	});
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
function closeEnv() {
	$("#env-out").value = "";
	$("#env-list").innerHTML = "";
	if (envDlg.open) envDlg.close();
}
$("#env-cancel").onclick = closeEnv;
envDlg.addEventListener("close", closeEnv);
