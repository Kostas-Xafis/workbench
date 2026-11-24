/**
 * The page's files' versions on the cloud board (src/fresh.ts): what names each one in the page, /ui/board.js?v=….
 * The asset binding answers each with an ETag that is a hash of the file; a file without one is hashed here. Worked
 * out once per Durable Object: a deploy (the only way the files change) starts new ones.
 */
import { hashOf, pageFiles } from "../../src/fresh";

export async function assetVersions(assets: Fetcher, page: string): Promise<Record<string, string>> {
	const pairs = await Promise.all(
		pageFiles(page).map(async (name) => {
			try {
				const res = await assets.fetch(new Request(`https://assets.local/${name}`));
				if (!res.ok) return null;
				const tag = (res.headers.get("etag") ?? "").replace(/^W\//, "").replace(/"/g, "");
				const version = tag ? hashOf(tag) : hashOf(await res.arrayBuffer());
				if (tag) await res.body?.cancel();
				return [name, version] as const;
			} catch {
				return null;
			}
		}),
	);
	return Object.fromEntries(pairs.filter((p) => p !== null));
}
