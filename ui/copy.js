/* ---------- Copy refs ---------- */

async function copyText(text) {
	try { await navigator.clipboard.writeText(text); return true; } catch {}
	const ta = Object.assign(document.createElement("textarea"), { value: text });
	ta.style.cssText = "position:fixed;opacity:0";
	(document.querySelector("dialog[open]") ?? document.body).append(ta);
	ta.select();
	const ok = document.execCommand("copy");
	ta.remove();
	return ok;
}

// Paste-ready ids for prompts ("Do wb-k3f9"). Capture phase, so a card under the button doesn't open.
document.addEventListener("click", async (e) => {
	const btn = e.target.closest("[data-copy]");
	if (!btn || !btn.dataset.copy) return;
	e.stopPropagation();
	e.preventDefault();
	if (!(await copyText(btn.dataset.copy))) return;
	const text = btn.textContent;
	btn.classList.add("copied");
	btn.textContent = "copied";
	window.lastCopied = btn.dataset.copy;
	setTimeout(() => { btn.classList.remove("copied"); btn.textContent = text; }, 900);
}, true);
