#!/usr/bin/env bun
// Gather a release's files into one folder, after `bun run app:build --config src-tauri/tauri.release.conf.json`:
//
//   bun scripts/release-assets.ts <version> [--out dist] [--notes notes.md] [--unsigned]
//
// It copies the .deb and the AppImage with their .sig files, the standalone server binary (the same file the app
// carries as its sidecar), and writes:
// - latest.json: the Tauri updater's manifest. The app reads it from
//   https://github.com/<repo>/releases/latest/download/latest.json (plugins.updater.endpoints in tauri.conf.json);
//   each platform entry points at this release's asset and carries the content of its .sig file.
// - SHA256SUMS: one line per file, `sha256sum -c` format.
// --unsigned skips the .sig files and latest.json (a build without the signing key, e.g. a local test).
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const version = args[0]?.replace(/^v/, "");
const unsigned = args.includes("--unsigned");
const out = resolve(root, opt("--out") ?? "dist");
const notesFile = opt("--notes");
const repo = process.env.GITHUB_REPOSITORY || "Kostas-Xafis/workbench";

function fail(msg: string): never {
	console.error(`release-assets: ${msg}`);
	process.exit(1);
}
if (!version) fail("usage: bun scripts/release-assets.ts <version> [--out dist] [--notes notes.md] [--unsigned]");

const pkg = await Bun.file(join(root, "package.json")).json();
if (pkg.version !== version) fail(`package.json says ${pkg.version}, not ${version}; run \`bun run release ${version}\` first`);

const bundle = join(root, "src-tauri/target/release/bundle");
const deb = join(bundle, "deb", `Workbench_${version}_amd64.deb`);
const appimage = join(bundle, "appimage", `Workbench_${version}_amd64.AppImage`);
const server = join(root, "src-tauri/binaries/workbench-server-x86_64-unknown-linux-gnu");
const serverName = `workbench-server_${version}_linux_x86_64`;

const need = [deb, appimage, server, ...(unsigned ? [] : [`${deb}.sig`, `${appimage}.sig`])];
for (const f of need) if (!(await Bun.file(f).exists())) fail(`missing ${f}`);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const f of [deb, appimage, ...(unsigned ? [] : [`${deb}.sig`, `${appimage}.sig`])]) await copyFile(f, join(out, basename(f)));
await copyFile(server, join(out, serverName));
await chmod(join(out, serverName), 0o755);
await chmod(join(out, basename(appimage)), 0o755);

if (!unsigned) {
	const url = (file: string) => `https://github.com/${repo}/releases/download/v${version}/${basename(file)}`;
	const sig = async (file: string) => (await Bun.file(`${file}.sig`).text()).trim();
	const appimageEntry = { signature: await sig(appimage), url: url(appimage) };
	const notes = notesFile ? (await Bun.file(notesFile).text()).trim() : `Workbench ${version}`;
	const latest = {
		version,
		notes,
		pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		platforms: {
			// The updater looks for "<os>-<arch>-<installer>" first (installer = how this copy was installed),
			// then "<os>-<arch>". The plain key is the AppImage, the format that can replace itself.
			"linux-x86_64": appimageEntry,
			"linux-x86_64-appimage": appimageEntry,
			"linux-x86_64-deb": { signature: await sig(deb), url: url(deb) },
		},
	};
	await Bun.write(join(out, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
}

const files = (await readdir(out)).filter((f) => f !== "SHA256SUMS").sort();
const sums: string[] = [];
for (const f of files) {
	const hash = createHash("sha256");
	for await (const chunk of Bun.file(join(out, f)).stream()) hash.update(chunk);
	sums.push(`${hash.digest("hex")}  ${f}`);
}
await Bun.write(join(out, "SHA256SUMS"), sums.join("\n") + "\n");

for (const f of [...files, "SHA256SUMS"]) {
	const size = Bun.file(join(out, f)).size;
	console.log(`${(size / 1048576).toFixed(1).padStart(7)} MB  ${f}`);
}
