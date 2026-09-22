import { describe, expect, test } from "bun:test";
import { dailyDashboardMatchesQuery, dailyDashboardSuccessSchema, dailyPeriodStatisticsSchema } from "./daily-dashboard";

const query = { boardId: "5.7", pid: "PH", dateRange: ["2026-09-05", "2026-09-06"] as [string, string] };
const statistics = { aggregationVersion: "daily-statistics/v1", dateRange: query.dateRange, dayCount: 2,
  state: "available", values: [{ kind: "period_sum", value: 5 }, { kind: "daily_average", value: 2.5 }], reason: null };
const series = { metric: { id: "M001", name: "落地页访问次数", unit: "次", definition: "有效页面浏览次数", authorityVersion: "v-test",
  formula: null, referenceMetricId: "M001", sourceNote: null, inputs: [{ key: "totalVistCount", name: "落地页访问次数", unit: "次" }] },
  points: query.dateRange.map((date, i) => ({ date, state: "available", value: i ? 5 : 0, inputs: [{ key: "totalVistCount", value: i ? 5 : 0 }] })) };
const response = (version: "day-dashboard/v1" | "day-dashboard/v2" = "day-dashboard/v2") => ({ success: true,
  data: { schemaVersion: version, query, queryId: "test", fetchedAt: "2026-09-07T01:00:00.000Z", timezone: "Asia/Shanghai",
    validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["/api/admin/statistics/pDaySum"],
    series: [version === "day-dashboard/v1" ? structuredClone(series) : { ...structuredClone(series), periodStatistics: structuredClone(statistics) }] } });

describe("日看板周期统计版本契约", () => {
  for (const version of ["day-dashboard/v1", "day-dashboard/v2"] as const) test(`${version}兼容四源并允许五源，超出五源拒绝`, () => {
    for (const count of [4, 5, 6]) {
      const result = response(version);
      result.data.sourceApiIds = Array.from({ length: count }, (_, i) => `/api/admin/source-${i}`);
      expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(count <= 5);
    }
  });
  for (const version of ["day-dashboard/v1", "day-dashboard/v2"] as const) test(`${version}按各自严格结构读取`, () => {
    const parsed = dailyDashboardSuccessSchema.parse(response(version));
    expect(dailyDashboardMatchesQuery(parsed, query, ["M001"])).toBe(true);
    expect("periodStatistics" in parsed.data.series[0]).toBe(version === "day-dashboard/v2");
  });
  test("版本和统计字段必须匹配，不吞掉缺失或多余字段", () => {
    const v1WithStatistics = response(); v1WithStatistics.data.schemaVersion = "day-dashboard/v1";
    const v2WithoutStatistics = response("day-dashboard/v1"); v2WithoutStatistics.data.schemaVersion = "day-dashboard/v2";
    expect(dailyDashboardSuccessSchema.safeParse(v1WithStatistics).success).toBe(false);
    expect(dailyDashboardSuccessSchema.safeParse(v2WithoutStatistics).success).toBe(false);
    expect(dailyDashboardSuccessSchema.safeParse({ ...response(), data: { ...response().data, schemaVersion: "day-dashboard/v3" } }).success).toBe(false);
  });
  test("周期统计范围必须等于本次查询，不能混入对比日", () => {
    const result = response();
    const changed = result.data.series[0] as typeof series & { periodStatistics: typeof statistics };
    changed.periodStatistics.dateRange = ["2026-09-04", "2026-09-05"];
    const parsed = dailyDashboardSuccessSchema.parse(result);
    expect(dailyDashboardMatchesQuery(parsed, query, ["M001"])).toBe(false);
  });
  test("未统计必须给原因，成功必须提供无重复类型的有限非负值", () => {
    for (const bad of [
      { dayCount: 3 }, { values: [] }, { reason: "数据缺失" },
      { values: [{ kind: "period_sum", value: 5 }, { kind: "period_sum", value: 5 }] },
      { values: [{ kind: "daily_average", value: -1 }] }, { values: [{ kind: "daily_average", value: Infinity }] },
      { state: "incomplete" }, { state: "unsupported", values: [], reason: null }
    ]) expect(dailyPeriodStatisticsSchema.safeParse({ ...statistics, ...bad }).success).toBe(false);
    for (const state of ["incomplete", "unsupported"]) expect(dailyPeriodStatisticsSchema.safeParse({ ...statistics, state, values: [], reason: "数据尚不适用" }).success).toBe(true);
    expect(dailyPeriodStatisticsSchema.safeParse({ ...statistics, values: [{ kind: "daily_average", value: 0 }] }).success).toBe(true);
  });
});
