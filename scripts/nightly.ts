#!/usr/bin/env bun
// Build what's in this folder right now (any branch or worktree, uncommitted changes included) as "Workbench
// Nightly", and put it next to the installed app to try before a release:
//
//   bun run nightly                 # build, install as Workbench Nightly, (re)start it
//   bun run nightly --fresh-data    # … and copy the real board's data again first
//   bun run nightly --no-launch     # build and install, don't start it
//
// The nightly is its own app: its own name, orange icon, window, tray and settings; the board on port 4322
// (the installed app keeps 4321); and its own copy of the data in ~/.local/share/workbench-nightly/, made from
// the real board the first time (or with --fresh-data). Nothing it does reaches the real board. No updates:
// a new nightly is the next `bun run nightly`.
//
// Version: the next patch with the build time and commit, e.g. 0.2.2-nightly.202611112130+5d45c20 (".dirty" with
// uncommitted changes). package.json gets it only for the build's length, and is put back after.
import { $ } from "bun";
import { Database } from "bun:sqlite";
import { chmod, copyFile, mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const fresh = args.includes("--fresh-data");
const launch = !args.includes("--no-launch");
const home = homedir();
const dataHome = process.env.XDG_DATA_HOME || join(home, ".local/share");

const APPIMAGE = join(home, "Applications/Workbench-Nightly.AppImage");
const DESKTOP = join(dataHome, "applications/workbench-nightly.desktop");
const ICONS = join(dataHome, "icons/hicolor");
const DATA = join(dataHome, "workbench-nightly");
const DB = join(DATA, "workbench.db");
/** The real board's database: the one the installed app and `wb` use. */
const REAL_DB = process.env.WB_DB || join(home, "Projects/workbench/workbench.db");

const say = (s: string) => console.log(`nightly: ${s}`);
function fail(msg: string): never {
	console.error(`nightly: ${msg}`);
	process.exit(1);
}

$.cwd(root);

// ---------- version ----------
const pkgPath = join(root, "package.json");
const pkgText = await readFile(pkgPath, "utf8");
const base = JSON.parse(pkgText).version as string;
if (base.includes("nightly")) fail(`package.json still says ${base}, from a nightly build that was interrupted: put the release version back (git checkout package.json)`);
const m = /^(\d+)\.(\d+)\.(\d+)/.exec(base) ?? fail(`package.json version "${base}" isn't X.Y.Z`);
const d = new Date();
const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
const sha = (await $`git rev-parse --short HEAD`.nothrow().text()).trim() || "nogit";
const dirty = (await $`git status --porcelain`.nothrow().text()).trim() ? ".dirty" : "";
const version = `${m[1]}.${m[2]}.${Number(m[3]) + 1}-nightly.${stamp}+${sha}${dirty}`;
const branch = (await $`git rev-parse --abbrev-ref HEAD`.nothrow().text()).trim();
say(`building ${version} from ${branch || "this folder"}${dirty ? " (with uncommitted changes)" : ""}`);

// ---------- build ----------
await writeFile(pkgPath, pkgText.replace(/^(\t"version": ")[^"]+(")/m, `$1${version}$2`));
let built_ok = false;
try {
	const r = await $`bunx tauri build --config src-tauri/tauri.nightly.conf.json --bundles appimage`
		.env({ ...process.env, WB_CHANNEL: "nightly" })
		.nothrow();
	built_ok = r.exitCode === 0;
} finally {
	// Put the real version back before anything else (fail() exits, which would skip a finally after it).
	await writeFile(pkgPath, pkgText);
}
if (!built_ok) fail("the build failed (its output is above)");
const bundleDir = join(root, "src-tauri/target/release/bundle/appimage");
const built = (await readdir(bundleDir)).filter((f) => f.startsWith("Workbench Nightly_") && f.endsWith(".AppImage"));
const newest = (await Promise.all(built.map(async (f) => ({ f, t: (await stat(join(bundleDir, f))).mtimeMs })))).sort((a, b) => b.t - a.t)[0];
if (!newest) fail(`no Workbench Nightly AppImage in ${bundleDir}`);

// ---------- stop a running nightly ----------
/** Processes whose program is the nightly's binary (inside its mounted AppImage). Read from /proc, so nothing
 *  that only mentions the name (like this script) counts. */
async function nightlyPids() {
	const pids: number[] = [];
	for (const p of await readdir("/proc")) {
		if (!/^\d+$/.test(p)) continue;
		const exe = await readlink(`/proc/${p}/exe`).catch(() => "");
		// The app inside the mounted image, and the AppImage's own runtime that mounts it (it outlives the app a moment).
		if (exe.endsWith("/workbench-nightly") || exe === APPIMAGE) pids.push(Number(p));
	}
	return pids;
}
const running = await nightlyPids();
if (running.length) {
	say("stopping the running nightly");
	for (const pid of running) process.kill(pid, "SIGTERM");
	for (let i = 0; i < 80 && (await nightlyPids()).length; i++) await Bun.sleep(100);
	for (const pid of await nightlyPids()) process.kill(pid, "SIGKILL");
}

// ---------- install ----------
await mkdir(join(home, "Applications"), { recursive: true });
// A new file swapped in by rename: works even if the old image is still mounted or running.
await copyFile(join(bundleDir, newest.f), `${APPIMAGE}.new`);
await chmod(`${APPIMAGE}.new`, 0o755);
await rename(`${APPIMAGE}.new`, APPIMAGE);
for (const [size, file] of [["32x32", "32x32.png"], ["64x64", "64x64.png"], ["128x128", "128x128.png"], ["256x256", "256x256.png"]]) {
	await mkdir(join(ICONS, size, "apps"), { recursive: true });
	await copyFile(join(root, "src-tauri/icons/nightly", file), join(ICONS, size, "apps/workbench-nightly.png"));
}
await mkdir(join(dataHome, "applications"), { recursive: true });
await writeFile(
	DESKTOP,
	`[Desktop Entry]
Type=Application
Name=Workbench Nightly
Comment=The latest local build of the Workbench, on a copy of your board
Exec=${APPIMAGE}
Icon=workbench-nightly
Terminal=false
Categories=Development;Office;
StartupWMClass=workbench-nightly
X-Workbench-Version=${version}
`,
);
await $`update-desktop-database ${join(dataHome, "applications")}`.quiet().nothrow();
await $`gtk-update-icon-cache -q -t ${ICONS}`.quiet().nothrow();
say(`installed ${APPIMAGE} and "Workbench Nightly" in the app launcher`);

// ---------- data ----------
if (fresh || !existsSync(DB)) {
	if (!existsSync(REAL_DB)) fail(`no real board at ${REAL_DB} to copy (set WB_DB to its database)`);
	await mkdir(DATA, { recursive: true });
	for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) await rm(f, { force: true });
	// VACUUM INTO: a consistent copy while the real board keeps running.
	const real = new Database(REAL_DB, { readonly: true });
	real.run(`VACUUM INTO ?`, [DB]);
	real.close();
	say(`copied the real board's data into ${DB}`);
} else {
	say(`keeping the nightly's data in ${DB} (--fresh-data copies the real board again)`);
}

// ---------- start ----------
if (launch) {
	Bun.spawn(["setsid", "-f", APPIMAGE], { stdio: ["ignore", "ignore", "ignore"] });
	say("started Workbench Nightly (board on http://localhost:4322)");
}
say(`done: ${version}`);
