import { describe, expect, test } from "bun:test";
import {
	addTracker, checkThresholds, formatEvery, getTracker, meterLevel, meterText, parseEvery, parseReading,
	recordReading, trackerHistory, trackerText, worst, type Meter,
} from "../src/trackers";
import { freshDb } from "./helpers";

const m = (out: string) => parseReading(out).meters;

describe("reading parser: lines", () => {
	test("a bare number, a fraction and a percentage", () => {
		expect(m("42")).toEqual([{ label: "", value: 42 }]);
		expect(m("12/15")).toEqual([{ label: "", value: 12, max: 15 }]);
		expect(m("Coverage 78%")).toEqual([{ label: "Coverage", value: 78, unit: "%" }]);
	});
	test("one meter per line, with labels, units and 'of'", () => {
		expect(m("Android 12/15\niOS: 3 of 15 builds\n")).toEqual([
			{ label: "Android", value: 12, max: 15 },
			{ label: "iOS", value: 3, max: 15, unit: "builds" },
		]);
		expect(m("1,240 / 2,000 min")).toEqual([{ label: "", value: 1240, max: 2000, unit: "min" }]);
		expect(m("Disk 45G/100G")[0]).toMatchObject({ label: "Disk", value: 45, max: 100 });
		expect(m("Free: 12.5 GB of 50 GB")).toEqual([{ label: "Free", value: 12.5, max: 50, unit: "GB" }]);
		expect(m("$1.52 / $12")[0]).toMatchObject({ value: 1.52, max: 12, unit: "$" });
	});
	test("text in brackets is kept as the meter's text", () => {
		expect(m("Open PRs: 3 (2 drafts)")).toEqual([{ label: "Open PRs", value: 3, text: "2 drafts" }]);
	});
	test("a state in words", () => {
		expect(m("Status: In review")).toEqual([{ label: "Status", text: "In review" }]);
		expect(m("Version: v1.2.3")).toEqual([{ label: "Version", text: "v1.2.3" }]);
		expect(m("all good")).toEqual([{ label: "", text: "all good" }]);
	});
	test("nothing printed is an error", () => {
		expect(() => parseReading("  \n")).toThrow(/nothing/);
	});
});

describe("reading parser: JSON", () => {
	test("a number, a string, a boolean", () => {
		expect(m("7")).toEqual([{ label: "", value: 7 }]);
		expect(m('"In review"')).toEqual([{ label: "", text: "In review" }]);
		expect(m("true")).toEqual([{ label: "", text: "yes" }]);
		expect(m("false")).toEqual([{ label: "", text: "no" }]);
	});
	test("a meter object, with the alternative key names", () => {
		expect(m('{"value":3,"max":10,"unit":"GB","label":"Disk","level":"warn"}')).toEqual([
			{ label: "Disk", value: 3, max: 10, unit: "GB", level: "warn" },
		]);
		expect(m('{"used":3,"total":10}')[0]).toMatchObject({ value: 3, max: 10 });
		expect(m('{"used":3,"limit":10}')[0]).toMatchObject({ value: 3, max: 10 });
		// left + max reads as used
		expect(m('{"left":4,"max":10}')[0]).toMatchObject({ value: 6, max: 10 });
		expect(m('{"status":"Live"}')[0]).toMatchObject({ text: "Live" });
	});
	test("a list of meters", () => {
		expect(m('[1, {"label":"b","value":2}, "ok"]')).toEqual([
			{ label: "", value: 1 },
			{ label: "b", value: 2 },
			{ label: "", text: "ok" },
		]);
	});
	test("{ meters, note, resets_at, url }", () => {
		const r = parseReading('{"meters":[{"value":1,"max":2}],"note":"Free plan","resets_at":"2026-12-01","url":"https://x.test"}');
		expect(r).toEqual({ meters: [{ label: "", value: 1, max: 2 }], note: "Free plan", resets_at: "2026-12-01", url: "https://x.test" });
	});
	test("a meter that is something else is refused", () => {
		expect(() => parseReading("[[1]]")).toThrow(/meter/);
	});
});

describe("levels", () => {
	const lvl = (value: number, max: number | undefined, warn = "", bad = "") => meterLevel({ label: "", value, max } as Meter, warn, bad);
	test("a meter with a max warns at 75% and is bad at 90%", () => {
		expect(lvl(10, 100)).toBe("ok");
		expect(lvl(75, 100)).toBe("warn");
		expect(lvl(89, 100)).toBe("warn");
		expect(lvl(90, 100)).toBe("bad");
	});
	test("no max and no thresholds: no level; a text meter has none", () => {
		expect(lvl(5, undefined)).toBe("");
		expect(meterLevel({ label: "", text: "x" }, "50%", "")).toBe("");
	});
	test("thresholds as a share of max or a number", () => {
		expect(lvl(50, 100, "50%", "80%")).toBe("warn");
		expect(lvl(14, 15, "10", "14")).toBe("bad");
		expect(lvl(5, 15, "10", "14")).toBe("ok");
	});
	test("low is bad: bad below warn, or a '<' prefix", () => {
		expect(lvl(15, 100, "20%", "10%")).toBe("warn");
		expect(lvl(8, 100, "20%", "10%")).toBe("bad");
		expect(lvl(50, 100, "20%", "10%")).toBe("ok");
		expect(lvl(5, 100, "", "<10%")).toBe("bad");
		expect(lvl(50, 100, "", "<10%")).toBe("ok");
		expect(lvl(40, undefined, "<50", "<20")).toBe("warn");
	});
	test("high is bad with a share of max and a number mixed (warn 80% of 15, bad 14)", () => {
		expect(lvl(12, 15, "80%", "14")).toBe("warn");
		expect(lvl(14, 15, "80%", "14")).toBe("bad");
	});
	test("a level set by the reading wins", () => {
		expect(meterLevel({ label: "", value: 1, max: 100, level: "bad" }, "", "")).toBe("bad");
	});
	test("worst of several", () => {
		expect(worst(["ok", "warn", ""])).toBe("warn");
		expect(worst(["ok", "bad", "warn"])).toBe("bad");
		expect(worst([])).toBe("");
	});
	test("thresholds that point opposite ways, or can't be read, are refused", () => {
		expect(() => checkThresholds("<20%", ">90%")).toThrow(/opposite/);
		expect(() => checkThresholds("lots", "")).toThrow(/threshold/);
		expect(() => checkThresholds("80%", "95%")).not.toThrow();
	});
});

describe("intervals and text", () => {
	test("parseEvery and formatEvery", () => {
		expect(parseEvery("15m")).toBe(900);
		expect(parseEvery("2h")).toBe(7200);
		expect(parseEvery("1d")).toBe(86400);
		expect(parseEvery("off")).toBe(0);
		expect(() => parseEvery("soon")).toThrow(/interval/);
		expect(formatEvery(3600)).toBe("every hour");
		expect(formatEvery(0)).toBe("only when asked");
	});
	test("meterText", () => {
		expect(meterText({ label: "Android", value: 12, max: 15, level: "warn", left: 3 })).toBe("Android 12/15, 3 left [warn]");
		expect(meterText({ label: "Status", text: "In review", level: "" })).toBe("Status: In review");
	});
});

describe("stored trackers", () => {
	test("record a reading by hand, level worked out, history kept", () => {
		const db = freshDb();
		const t = addTracker(db, { project: "demo", name: "builds", max: 15 });
		expect(t.kind).toBe("manual");
		expect(t.reading).toBeNull();
		const r = recordReading(db, t.id, "Android 14/15", "agent");
		expect(r.reading!.meters[0]).toMatchObject({ label: "Android", value: 14, max: 15, level: "bad" });
		expect(trackerText(getTracker(db, t.id)!)).toContain("Android 14/15");
		recordReading(db, t.id, "Android 14/15");
		recordReading(db, t.id, "Android 3/15");
		const h = trackerHistory(db, t.id);
		expect(h).toHaveLength(2);
		expect(h[0].author).toBe("agent");
	});
	test("max and unit from the tracker fill in what a reading leaves out", () => {
		const db = freshDb();
		const t = addTracker(db, { project: "demo", name: "mins", max: 2000, unit: "min", warn: "<20%", bad: "<10%" });
		const r = recordReading(db, t.id, "300");
		expect(r.reading!.meters[0]).toMatchObject({ value: 300, max: 2000, unit: "min", level: "warn" });
	});
	test("names are unique per project; a bad reading is refused", () => {
		const db = freshDb();
		const t = addTracker(db, { project: "demo", name: "disk" });
		expect(() => addTracker(db, { project: "demo", name: "disk" })).toThrow();
		expect(() => recordReading(db, t.id, "")).toThrow(/nothing/);
		expect(() => recordReading(db, 9999, "1")).toThrow(/no tracker/);
		expect(() => addTracker(db, { project: "demo", name: "x", command: "echo 1", kind: "manual" })).toThrow();
	});
});
