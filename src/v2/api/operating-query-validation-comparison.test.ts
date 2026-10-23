import { expect, test } from "bun:test";
import { DAILY_STATISTICS_VERSION, type DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, OPERATING_SNAPSHOT_STATISTICS_REASON, operatingSnapshotDates } from "../../../contracts/operating-detail-projection";
import { operatingQueryDateRange } from "../../../contracts/operating-query-jobs";
import { compareOperatingValidation } from "./operating-query-validation-comparison";

function snapshot(pid = "PH", date = "2026-10-21"): DailyDashboardSuccess {
  const dateRange = operatingQueryDateRange(date);
  return { success: true, data: { schemaVersion: "day-dashboard/v2", query: { boardId: "5.2", pid, dateRange, projection: "operating_snapshot" },
    queryId: "fixture", fetchedAt: "2026-10-23T01:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation",
    completeness: "unknown", watermark: null, sourceApiIds: ["fixture"],
    series: OPERATING_METRIC_IDS.map(id => ({ metric: { id, name: id, unit: "人", definition: "fixture", authorityVersion: "fixture-v1",
      formula: null, referenceMetricId: id, sourceNote: "fixture-v1", inputs: [{ key: "n", name: "人数", unit: "人" }] },
      points: operatingSnapshotDates(dateRange).map(date => ({ date, state: "available", sourceStatus: "READY", value: 0, inputs: [{ key: "n", value: 0 }] })),
      periodStatistics: { aggregationVersion: DAILY_STATISTICS_VERSION, dateRange, dayCount: 8, state: "unsupported", values: [], reason: OPERATING_SNAPSHOT_STATISTICS_REASON }
    })) } };
}

test("两站20平台三期保留93列权威映射，仅排除月活两期不适用", () => {
  const left = Array.from({ length: 20 }, (_, i) => snapshot(`PID${i}`)), right = structuredClone(left);
  right.forEach(item => { item.data.queryId = "another"; item.data.fetchedAt = "2026-10-23T02:00:00Z"; });
  expect(compareOperatingValidation(left, right, { pids: left.map(item => item.data.query.pid), date: "2026-10-21" })).toEqual({ totalCells: 5540, matchedCells: 5540, notApplicableCells: 40,
    readyCells: 5540, nonReadyCells: 0, differences: [], scopeErrors: [] });
});

test("来源状态相同可对照，但不被统计为已取得数值", () => {
  const left = snapshot();
  for (const point of left.data.series[0].points) Object.assign(point, { state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: [{ key: "n", value: 5 }] });
  const result = compareOperatingValidation([left], [structuredClone(left)], { pids: ["PH"], date: "2026-10-21" });
  expect(result).toMatchObject({ totalCells: 277, matchedCells: 277, readyCells: 274, nonReadyCells: 3, differences: [], scopeErrors: [] });
});

for (const kind of ["value", "state", "inputs", "unit", "version", "month"] as const) test(`${kind}差异不被值为零、相同显示文案或日期掩盖`, () => {
  const left = snapshot(), right = structuredClone(left), series = right.data.series[0], point = series.points[2];
  if (kind === "value") { point.value = 1; point.inputs[0].value = 1; }
  if (kind === "state") Object.assign(point, { state: "no_value", sourceStatus: "PROCESSING", value: null });
  if (kind === "inputs") point.inputs[0].value = 12;
  if (kind === "unit") series.metric.unit = "秒";
  if (kind === "version") series.metric.sourceNote = "fixture-v2";
  if (kind === "month") point.monthlyMetadata = { month: "2026-10", cutoffDate: "2026-10-22", isComplete: false };
  const result = compareOperatingValidation([left], [right], { pids: ["PH"], date: "2026-10-21" });
  expect(result.scopeErrors).toEqual([]);
  expect(result.differences.length).toBeGreaterThan(0);
  expect(result.matchedCells).toBeLessThan(result.totalCells);
});

test("平台顺序可按PID对齐，缺平台、重复平台、混日或缺列不能通过", () => {
  const a = snapshot("PH"), b = snapshot("FBI");
  const expected = { pids: ["PH", "FBI"], date: "2026-10-21" };
  expect(compareOperatingValidation([a, b], [b, a], expected).differences).toEqual([]);
  expect(compareOperatingValidation([a, b], [a], expected).scopeErrors).toContain("MISSING_PID:FBI");
  expect(compareOperatingValidation([a, a], [a], expected).scopeErrors).toContain("async:DUPLICATE_PID:PH");
  const changed = snapshot("FBI", "2026-10-20");
  expect(compareOperatingValidation([a, changed], [a, changed], expected).scopeErrors).toContain("MIXED_BUSINESS_DATES");
  const missing = structuredClone(a); missing.data.series.pop();
  expect(compareOperatingValidation([missing], [a], expected).scopeErrors).toContain("async:INVALID_SNAPSHOT");
  expect(compareOperatingValidation([], [], expected).scopeErrors).toContain("EMPTY_SCOPE");
  expect(compareOperatingValidation([a], [a], expected).scopeErrors).toContain("async:MISSING_EXPECTED_PID:FBI");
  expect(compareOperatingValidation([changed], [changed], expected).scopeErrors).toContain("sync:UNEXPECTED_DATE:FBI");
});
