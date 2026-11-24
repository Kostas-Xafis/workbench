import { describe, expect, test } from "bun:test";
import { addItem, createSchema, DAY_PAGE_VERSIONS, pruneDayVersions, publishReport, reportHtml } from "../src/db";
import { currentDay, publishDay } from "../src/day";
import { freshDb } from "./helpers";

type D = ReturnType<typeof freshDb>;
const versions = (d: D, id: number) => (d.query("SELECT n FROM report_versions WHERE report_id = ? ORDER BY n").all(id) as { n: number }[]).map((v) => v.n);
const publishMany = (d: D, name: string, grp: string, times: number) => {
	let id = 0;
	for (let i = 1; i <= times; i++) id = publishReport(d, { project: "demo", name, html: `<p>${name} ${i}</p>`, grp }).id;
	return id;
};

describe("day pages keep few versions", () => {
	test("the migration trims existing day pages, leaves other reports alone, and is safe to run again", () => {
		const d = freshDb();
		const day = publishMany(d, "day-2026-11-10", "Days", 8);
		const plan = publishMany(d, "plan", "Plans", 8);
		const notInDays = publishMany(d, "day-2026-11-11", "Plans", 6);
		const notDated = publishMany(d, "day-notes", "Days", 6);
		expect(versions(d, day)).toHaveLength(8);
		createSchema(d);
		expect(versions(d, day)).toEqual([6, 7, 8]);
		expect(reportHtml(d, day)!.html).toBe("<p>day-2026-11-10 8</p>");
		expect(versions(d, plan)).toHaveLength(8);
		expect(versions(d, notInDays)).toHaveLength(6);
		expect(versions(d, notDated)).toHaveLength(6);
		createSchema(d);
		expect(versions(d, day)).toEqual([6, 7, 8]);
		expect(pruneDayVersions(d)).toBe(0);
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
