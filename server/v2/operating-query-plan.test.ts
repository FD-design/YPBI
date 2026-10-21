import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { biQueryJobRequestSchema } from "../../contracts/query-jobs";
import { createOperatingQueryPlan, normalizeOperatingQueryResults } from "./operating-query-plan";
import { DailyDashboardService } from "./daily-dashboard.service";

const range: [string, string] = ["2026-10-10", "2026-10-17"];
const today = "2026-10-21";
const generatedAt = "2026-10-21T00:00:00Z";
const row = (pid: string, value: number) => ({ metricCode: "M008", businessDate: range[1], dimensions: { pid },
  value, numerator: value, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "fixture-v1" });
const emptyUnits = (count: number) => Array.from({ length: count }, () => ({ rows: [] as unknown[], generatedAt }));

describe("server-owned operating job plan", () => {
  test("one-site CSV shares 12 metric groups, one videoType unit and one natural-month summary", () => {
    const plan = createOperatingQueryPlan(["PH", "FBI"], range, today);
    expect(plan.units).toHaveLength(14);
    expect(plan.units.filter(unit => unit.kind === "metrics")).toHaveLength(12);
    expect(biQueryJobRequestSchema.safeParse(plan.request).success).toBe(true);
    expect(plan.request.queries.every(unit => unit.query.pid === "PH,FBI" && unit.query.includeIncomplete)).toBe(true);
    const daily = plan.request.queries.filter(unit => unit.query.granularity === "day");
    expect(daily).toHaveLength(13);
    expect(daily.every(unit => unit.query.startDate === range[0] && unit.query.endDate === "2026-10-18")).toBe(true);
    expect(daily.find(unit => unit.query.dimensions === "videoType")!.query.metricCodes).toBe("M034,M036,M097");
    expect(plan.request.queries.filter(unit => unit.query.granularity === "summary").map(unit => unit.query))
      .toEqual([{ pid: "PH,FBI", metricCodes: "M018", startDate: "2026-10-01", endDate: "2026-10-21", granularity: "summary", includeIncomplete: true }]);
  });

  test("cross-month range retains two independent monthly summaries and three-day output anchors", () => {
    const plan = createOperatingQueryPlan(["PH"], ["2026-09-27", "2026-10-04"], today);
    expect(plan.units).toHaveLength(15);
    expect(plan.units.filter(unit => unit.kind === "monthly").map(unit => unit.scope)).toEqual([
      { pid: "PH", startDate: "2026-09-01", endDate: "2026-09-30", metricCodes: ["M018"], granularity: "summary", dimensions: [] },
      { pid: "PH", startDate: "2026-10-01", endDate: "2026-10-20", metricCodes: ["M018"], granularity: "summary", dimensions: [] }
    ]);
    expect(plan.months.map(month => month.anchor)).toEqual(["2026-09-30", "2026-10-04"]);
  });

  test("invalid, duplicate and oversized PID groups and non-eight-day ranges fail before a request", () => {
    for (const pids of [[], ["PH", "PH"], ["PH,FBI"], [" PH"], Array.from({ length: 21 }, (_, index) => `P${index}`)]) {
      expect(() => createOperatingQueryPlan(pids, range, today)).toThrow();
    }
    expect(() => createOperatingQueryPlan(["PH"], ["2026-10-11", "2026-10-17"], today)).toThrow();
    expect(createOperatingQueryPlan(Array.from({ length: 20 }, (_, index) => `P${index}`), range, today).pids).toHaveLength(20);
  });

  test("multi-PID rows preserve separate READY zero, value and missing slices without forged metadata", () => {
    const plan = createOperatingQueryPlan(["PH", "FBI"], range, today);
    const units = emptyUnits(plan.units.length);
    const overall = plan.units.findIndex(unit => unit.kind === "metrics" && !unit.scope.dimensionFilters);
    units[overall].rows = [row("PH", 0), row("FBI", 12)];
    const result = normalizeOperatingQueryResults(plan, units);
    expect(result.get("PH")!.metricDays.find(day => day.date === range[1])!.metrics.M008).toMatchObject({ value: 0, state: "available", dataStatus: "READY" });
    expect(result.get("FBI")!.metricDays.find(day => day.date === range[1])!.metrics.M008).toMatchObject({ value: 12, state: "available", dataStatus: "READY" });
    expect(result.get("PH")!.metricDays.find(day => day.date === range[0])!.metrics.M008).toMatchObject({ value: null, state: "no_record", dataStatus: null });
    expect(result.get("PH")!.playbackDays.every(day => Object.values(day.metrics).every(point => point.value === null))).toBe(true);
    expect(units.every(unit => !Object.hasOwn(unit, "metricVersion") && !Object.hasOwn(unit, "watermark"))).toBe(true);
  });

  test("whole-unit validation rejects foreign PID, contradictory PID, date, metric, malformed units and missing units", () => {
    const plan = createOperatingQueryPlan(["PH", "FBI"], range, today);
    const overall = plan.units.findIndex(unit => unit.kind === "metrics" && !unit.scope.dimensionFilters);
    for (const invalid of [row("OTHER", 1), { ...row("PH", 1), pid: "FBI" }, { ...row("PH", 1), businessDate: "2026-10-18" },
      { ...row("PH", 1), metricCode: "M018" }, { ...row("PH", 1), metricVersion: undefined }]) {
      const units = emptyUnits(plan.units.length);
      units[overall].rows = [invalid];
      expect(() => normalizeOperatingQueryResults(plan, units)).toThrow();
    }
    expect(() => normalizeOperatingQueryResults(plan, emptyUnits(plan.units.length - 1))).toThrow();
    const invalidUnits = emptyUnits(plan.units.length);
    invalidUnits[0].generatedAt = "invalid";
    expect(() => normalizeOperatingQueryResults(plan, invalidUnits)).toThrow();
  });

  test("foreign source coverage cannot disappear during PID partitioning or manufacture missing rows", () => {
    const plan = createOperatingQueryPlan(["PH", "FBI"], range, today);
    const playback = plan.units.findIndex(unit => unit.kind === "playback");
    const units: unknown[] = emptyUnits(plan.units.length);
    const coverage = { metricCode: "M034", pid: "PH", businessDate: range[1], dataStatus: "READY", reason: "COMPLETE_SOURCE_SCAN" };
    units[playback] = { rows: [], generatedAt, sourceCoverage: [coverage] };
    const result = normalizeOperatingQueryResults(plan, units);
    expect(result.get("PH")!.playbackDays.find(day => day.date === range[1])!.metrics.M034).toMatchObject({ value: null, state: "no_record" });
    units[playback] = { rows: [], generatedAt, sourceCoverage: [{ ...coverage, pid: "OTHER" }] };
    expect(() => normalizeOperatingQueryResults(plan, units)).toThrow();
  });

  test("real deployed playback unit retains independent states and diagnostic 4/6 inside the 93-column projection", async () => {
    const evidence = JSON.parse(readFileSync(new URL("./fixtures/query-jobs-http-20261021.json", import.meta.url), "utf8"));
    const plan = createOperatingQueryPlan(["PH"], range, today);
    const units: unknown[] = emptyUnits(plan.units.length);
    units[plan.units.findIndex(unit => unit.kind === "playback")] = evidence.result.msg.results[4];
    const source = normalizeOperatingQueryResults(plan, units).get("PH")!;
    const service = new DailyDashboardService({ get: async () => ({ msg: { totalCount: 0, pageData: [], totalData: [] }, data: [] }) }, () => new Date(generatedAt));
    const result = await service.executeOperating({ boardId: "5.2", pid: "PH", dateRange: range, projection: "operating_snapshot" }, Promise.resolve(source));
    const point = (id: string) => result.data.series.find(series => series.metric.id === id)!.points.find(point => point.date === range[1])!;
    expect(result.data.series).toHaveLength(93);
    expect(point("M034")).toMatchObject({ state: "no_value", value: null, sourceStatus: "SOURCE_INCOMPLETE" });
    expect(point("M036")).toMatchObject({ state: "no_value", value: null, sourceStatus: "SOURCE_INCOMPLETE",
      inputs: [{ key: "effectivePlayCount", value: 4 }, { key: "successfulStartCount", value: 6 }] });
    expect(point("M097")).toMatchObject({ state: "available", value: 6, sourceStatus: "READY" });
    expect(result.data.watermark).toBeNull();
  });
});
