const MAX_BYTES = 512 * 1024;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36";

export type Icon = { data: Uint8Array; type: string };

function sniff(data: Uint8Array, header: string): string | null {
	const b = data;
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
	if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return "image/x-icon";
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
	if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "image/webp";
	const head = new TextDecoder().decode(b.slice(0, 256)).trimStart();
	if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
	return header.startsWith("image/") && !header.includes("svg") ? header.split(";")[0] : null;
}

async function get(url: string) {
	return fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(6000) });
}

async function image(url: string): Promise<Icon | null> {
	try {
		if (url.startsWith("data:")) {
			const m = url.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
			if (!m) return null;
			const data = m[2]
				? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0))
				: new TextEncoder().encode(decodeURIComponent(m[3]));
			const type = sniff(data, m[1]);
			return type ? { data, type } : null;
		}
		const res = await get(url);
		if (!res.ok) return null;
		const data = new Uint8Array(await res.arrayBuffer());
		if (!data.length || data.length > MAX_BYTES) return null;
		const type = sniff(data, res.headers.get("content-type") ?? "");
		return type ? { data, type } : null;
	} catch {
		return null;
	}
}

/** `<link rel="…icon…" href>` candidates in the page, best first: apple-touch (large), sized icons largest first, then plain icons. */
function iconLinks(html: string, base: string): string[] {
	const found: { href: string; score: number }[] = [];
	for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
		const attr = (name: string) =>
			tag
				.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
				?.slice(1)
				.find((v) => v !== undefined);
		const rel = (attr("rel") ?? "").toLowerCase();
		const href = attr("href");
		if (!href || !/\bicon\b|apple-touch-icon/.test(rel) || rel.includes("mask-icon")) continue;
		const size = Math.max(0, ...(attr("sizes") ?? "").split(/\s+/).map((s) => Number(s.split("x")[0]) || 0));
		const score = rel.includes("apple-touch-icon") ? 180 : size || (href.endsWith(".svg") ? 150 : 32);
		try {
			found.push({ href: new URL(href.replaceAll("&amp;", "&"), base).href, score });
		} catch {}
	}
	return found.sort((a, b) => b.score - a.score).map((f) => f.href);
}

/** The icon for a bookmark: the given icon address, else the page's declared icon, else /favicon.ico. */
export async function findIcon(pageUrl: string, iconUrl = ""): Promise<Icon | null> {
	if (iconUrl) return image(iconUrl);
	let base = pageUrl;
	const candidates: string[] = [];
	try {
		const res = await get(pageUrl);
		base = res.url || pageUrl;
		if ((res.headers.get("content-type") ?? "").includes("html"))
			candidates.push(...iconLinks((await res.text()).slice(0, 400_000), base));
	} catch {}
	for (const origin of new Set([new URL(base).origin, new URL(pageUrl).origin]))
		candidates.push(`${origin}/favicon.ico`);
	for (const url of new Set(candidates)) {
		const icon = await image(url);
		if (icon) return icon;
	}
	return null;
}
