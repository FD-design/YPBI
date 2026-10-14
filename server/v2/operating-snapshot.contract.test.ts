import { describe, expect, test } from "bun:test";
import { dailyDashboardMatchesQuery, dailyDashboardQuerySchema, dailyDashboardSuccessSchema, type DailyDashboardQuery } from "../../contracts/daily-dashboard";
import { OPERATING_LIVE_IDS, OPERATING_METRIC_IDS, operatingSnapshotDates } from "../../contracts/operating-detail-projection";
import { DailyDashboardService } from "./daily-dashboard.service";

const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-05", "2026-10-12"], projection: "operating_snapshot" };
const service = () => new DailyDashboardService({ get: async path => path.includes("/bi/v1/")
  ? { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-10-14T00:00:00Z", watermark: null, rows: [] } }
  : { msg: { pageData: [], totalCount: 0, totalData: [] }, data: [] } }, () => new Date("2026-10-14T00:00:00Z"));

describe("经营快照唯一投影与日期契约", () => {
  test("共享注册覆盖现有93列且不增加相邻系列", () => {
    expect(Object.keys(OPERATING_LIVE_IDS).length).toBe(93);
    expect(OPERATING_METRIC_IDS.length).toBe(93);
    expect(new Set(OPERATING_METRIC_IDS).size).toBe(93);
    expect(Object.values(OPERATING_LIVE_IDS)).toEqual([...OPERATING_METRIC_IDS]);
    expect(OPERATING_METRIC_IDS).not.toContain("M101");
    expect(OPERATING_METRIC_IDS).not.toContain("M016.web");
    expect(OPERATING_METRIC_IDS).not.toContain("M112.unknown");
  });
  test("快照只适用于5.2和精确八日边界，其他参数仍严格拒绝", () => {
    expect(dailyDashboardQuerySchema.safeParse(query).success).toBe(true);
    for (const change of [{ boardId: "5.8" }, { projection: "unknown" }, { dateRange: ["2026-10-11", "2026-10-12"] },
      { dateRange: ["2026-10-05", "2026-10-13"] }, { rawToken: "fixture-only" }]) {
      expect(dailyDashboardQuerySchema.safeParse({ ...query, ...change }).success).toBe(false);
    }
    expect(dailyDashboardQuerySchema.safeParse({ boardId: "5.8", pid: "PH", dateRange: ["2026-10-12", "2026-10-12"] }).success).toBe(true);
  });
  test("跨月跨年和闰日仍准确返回升序三观察日", () => {
    expect(operatingSnapshotDates(["2024-02-26", "2024-03-04"])).toEqual(["2024-02-26", "2024-03-03", "2024-03-04"]);
    expect(operatingSnapshotDates(["2025-12-26", "2026-01-02"])).toEqual(["2025-12-26", "2026-01-01", "2026-01-02"]);
  });
  test("完整快照匹配，不能与默认查询的响应或预期集合混用", async () => {
    const result = await service().execute(query);
    expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(true);
    expect(dailyDashboardMatchesQuery(result, query, OPERATING_METRIC_IDS)).toBe(true);
    const { projection: _projection, ...defaultQuery } = query;
    expect(dailyDashboardMatchesQuery(result, defaultQuery, OPERATING_METRIC_IDS)).toBe(false);
    expect(dailyDashboardMatchesQuery(result, query, [...OPERATING_METRIC_IDS, "M101"])).toBe(false);
  });
  test("快照缺列、错序、额外日期或伪周期统计均拒绝", async () => {
    const result = await service().execute(query);
    const mutations = [
      (data: typeof result.data) => { data.series.pop(); },
      (data: typeof result.data) => { data.series.reverse(); },
      (data: typeof result.data) => { data.series[0].points[0].date = "2026-10-06"; },
      (data: typeof result.data) => { data.series[0].points.push({ ...data.series[0].points[0], date: "2026-10-06" }); },
      (data: typeof result.data) => { data.series[0].periodStatistics = { ...data.series[0].periodStatistics, state: "available", values: [{ kind: "period_sum", value: 0 }], reason: null }; },
      (data: typeof result.data) => { data.series[0].periodStatistics.dayCount = 3; }
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(result);
      mutate(changed.data);
      expect(dailyDashboardSuccessSchema.safeParse(changed).success).toBe(false);
      expect(dailyDashboardMatchesQuery(changed, query, OPERATING_METRIC_IDS)).toBe(false);
    }
  });
});
