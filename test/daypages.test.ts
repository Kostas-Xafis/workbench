import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { addItem, addProject, createSchema, DAY_PAGE_MARK, DAY_PAGE_VERSIONS, open, pruneDayVersions, publishReport, reportHtml } from "../src/db";
import { currentDay, publishDay } from "../src/day";
import { freshDb } from "./helpers";

type D = ReturnType<typeof freshDb>;
const versions = (d: D, id: number) => (d.query("SELECT n FROM report_versions WHERE report_id = ? ORDER BY n").all(id) as { n: number }[]).map((v) => v.n);
/** A page as day.ts makes it (with its mark), or as anyone else might publish one (`marked` false). */
const page = (name: string, i: number, marked = true) => `<html><head>${marked ? `${DAY_PAGE_MARK}open:x:${i}">` : ""}</head><body><p>${name} ${i}</p></body></html>`;
const publishMany = (d: D, name: string, grp: string, times: number, marked = true) => {
	let id = 0;
	for (let i = 1; i <= times; i++) id = publishReport(d, { project: "demo", name, html: page(name, i, marked), grp }).id;
	return id;
};

describe("day pages keep few versions", () => {
	test("pruning trims day pages day.ts made, leaves other reports alone, and is safe to run again; opening doesn't prune", () => {
		const d = freshDb();
		const day = publishMany(d, "day-2026-11-10", "Days", 8);
		const plan = publishMany(d, "plan", "Plans", 8);
		const notInDays = publishMany(d, "day-2026-11-11", "Plans", 6);
		const notDated = publishMany(d, "day-notes", "Days", 6);
		// An agent's report named like a day page, in Days: not day.ts's, so it keeps its history.
		const agents = publishMany(d, "day-2026-11-12", "Days", 6, false);
		expect(versions(d, day)).toHaveLength(8);
		// The schema setup (every open) leaves them: it runs before the startup backup.
		createSchema(d);
		expect(versions(d, day)).toHaveLength(8);
		expect(pruneDayVersions(d)).toBe(5);
		expect(versions(d, day)).toEqual([6, 7, 8]);
		expect(reportHtml(d, day)!.html).toBe(page("day-2026-11-10", 8));
		expect(versions(d, plan)).toHaveLength(8);
		expect(versions(d, notInDays)).toHaveLength(6);
		expect(versions(d, notDated)).toHaveLength(6);
		expect(versions(d, agents)).toHaveLength(6);
		expect(pruneDayVersions(d)).toBe(0);
	});

	test("the board prunes after its startup backup, so the backup still has every version", async () => {
		const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "prune-"));
		mkdirSync(join(dir, "home"));
		const file = join(dir, "workbench.db");
		const seed = open(file);
		addProject(seed, { slug: "demo", name: "Demo", path: "" });
		const day = publishMany(seed, "day-2026-11-10", "Days", 8);
		seed.close();
		const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "server.ts")], {
			cwd: dir,
			env: { ...process.env, WB_DB: file, WB_BACKUPS: join(dir, "backups"), WB_PORT: String(Number(process.env.WB_PORT) + 37), HOME: join(dir, "home"), XDG_RUNTIME_DIR: join(dir, "run"), XDG_CONFIG_HOME: join(dir, "config") },
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			let pruned = false;
			for (let i = 0; i < 100 && !pruned; i++) {
				await Bun.sleep(100);
				const d = new Database(file, { readonly: true });
				try {
					pruned = (d.query("SELECT COUNT(*) AS n FROM report_versions WHERE report_id = ?").get(day) as { n: number }).n === DAY_PAGE_VERSIONS;
				} catch {
				} finally {
					d.close();
				}
			}
			expect(pruned).toBe(true);
			const backups = readdirSync(join(dir, "backups"));
			expect(backups).toHaveLength(1);
			const b = new Database(join(dir, "backups", backups[0]), { readonly: true });
			expect((b.query("SELECT COUNT(*) AS n FROM report_versions WHERE report_id = ?").get(day) as { n: number }).n).toBe(8);
			b.close();
		} finally {
			proc.kill();
			await proc.exited;
		}
	});

	test("publishDay keeps only the newest versions as it writes", async () => {
		const d = freshDb();
		const today = currentDay(d);
		for (let i = 1; i <= 6; i++) {
			addItem(d, { title: `Work ${i}`, project: "demo" });
			await publishDay(d, today, "demo");
		}
		const row = d.query("SELECT id FROM reports WHERE name = ?").get(`day-${today}`) as { id: number };
		const n = versions(d, row.id);
		expect(n).toHaveLength(DAY_PAGE_VERSIONS);
		expect(n.at(-1)).toBeGreaterThan(DAY_PAGE_VERSIONS);
	});
});
