import { isAbsolute, join } from "node:path";
import type { Project } from "./db";

const MAX_BYTES = 1024 * 1024;
const TYPES: Record<string, string> = {
	svg: "image/svg+xml",
	png: "image/png",
	ico: "image/x-icon",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};
const NAME = /(?:^|\/)(app-icon|icon|logo|favicon)([^/]*)\.(svg|png|ico|jpe?g|webp)$/i;
const NOISE = /(?:^|\/)(archive|legacy|node_modules|test|tests|fixtures?|examples?|vendor|dist|build)\//i;

/** Higher is better: an app icon over a logo over a favicon, vector over bitmap, shallow over deep. */
function score(path: string) {
	const m = path.match(NAME);
	if (!m) return -Infinity;
	const [, name, rest, ext] = m;
	const kind = { "app-icon": 5, icon: 5, logo: 4, favicon: 3 }[name.toLowerCase()] ?? 0;
	const format = { svg: 3, png: 2, webp: 1, jpg: 1, jpeg: 1, ico: 0 }[ext.toLowerCase()] ?? 0;
	return kind + format + (rest ? 0 : 1) - path.split("/").length * 0.5 - (NOISE.test(path) ? 10 : 0);
}

async function trackedFiles(cwd: string) {
	const p = Bun.spawn(["git", "ls-files"], { cwd, stdout: "pipe", stderr: "ignore" });
	const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return code === 0 ? out.split("\n").filter(Boolean) : [];
}

// The repo is searched at most every 10 minutes per project.
const found = new Map<string, { path: string | null; at: number }>();

/** Look again on the next request, e.g. after the project's folder or logo changed. */
export const forgetLogo = (slug: string) => found.delete(slug);

async function logoPath(p: Project): Promise<string | null> {
	if (p.icon) return isAbsolute(p.icon) ? p.icon : join(p.path, p.icon);
	if (!p.path) return null;
	const hit = found.get(p.slug);
	if (hit && Date.now() - hit.at < 600e3) return hit.path;
	const best = (await trackedFiles(p.path))
		.filter((f) => NAME.test(f))
		.sort((a, b) => score(b) - score(a))[0];
	const path = best ? join(p.path, best) : null;
	found.set(p.slug, { path, at: Date.now() });
	return path;
}

/** The project's logo file from its repo, or null (the board then draws its initial). */
export async function projectLogo(p: Project): Promise<{ file: ReturnType<typeof Bun.file>; type: string } | null> {
	const path = await logoPath(p);
	if (!path) return null;
	const file = Bun.file(path);
	const type = TYPES[path.split(".").pop()!.toLowerCase()];
	if (!type || !(await file.exists()) || file.size > MAX_BYTES) return null;
	return { file, type };
}
