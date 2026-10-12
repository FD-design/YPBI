import { describe, expect, test } from "bun:test";
import { dailyDashboardMatchesQuery } from "../../contracts/daily-dashboard";
import { currentUpstreamRequestProfile, runWithUpstreamRequestProfile } from "../upstream/request-profile";
import { DailyDashboardService, dailyDashboardMatchesMapping } from "./daily-dashboard.service";

const query = { boardId: "5.7", pid: "PH", dateRange: ["2026-09-21", "2026-09-22"] as [string, string] };
const envelope = (rows: unknown[] = []) => ({ code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-23T01:00:00Z", watermark: null, rows } });
type Params = Record<string, string>;
const make = (grouped: (params: Params) => unknown = () => envelope([]), observe?: (params: Params) => void) => new DailyDashboardService({ get: async (path, params) => {
  if (path === "/api/admin/bi/v1/metrics") {
    if (["channel", "downloadPlatform"].includes(params.dimensions)) { observe?.(params); return grouped(params); }
    return envelope([]);
  }
  if (path.endsWith("pDaySum")) return { msg: { pageData: [{ pid: "PH", sumDate: query.dateRange[0], totalVistCount: 100, registerUserCount: 5 }], totalCount: 1 } };
  if (path.includes("channelStatByTypeV2")) return { msg: { pageData: [], totalData: [{ totalDownCountNoDedup: 10, visiCountNoDedup: 100 }] } };
  return { data: [], msg: { pageData: [], totalData: [], totalCount: 0 } };
} }, () => new Date("2026-09-24T00:00:00Z"));
const groupedRows = (params: Params) => envelope(params.metricCodes.split(",").map(metricCode => {
  const ratio = !["M001", "M003"].includes(metricCode), summary = params.granularity === "summary";
  return { metricCode, ...(!summary ? { businessDate: query.dateRange[0] } : {}), dimensions: { pid: "PH", [params.dimensions]: "A-B" },
    value: ratio ? 0.5 : summary ? 80 : 3, numerator: ratio ? 2 : summary ? 80 : 3, denominator: ratio ? 4 : 0,
    unit: ratio ? "ratio" : "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "returned-rule" };
}));

describe("日看板动态获客分组兼容接入", () => {
  test("渠道只请求四项支持指标，六列保留来源状态且总体注册转化不重复查询", async () => {
    const selectedQuery = { ...query, dateRange: [query.dateRange[0], query.dateRange[0]] as [string, string] };
    const requests: Params[] = [];
    const service = new DailyDashboardService({ get: async (path, params) => {
      if (path !== "/api/admin/bi/v1/metrics") return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
      requests.push(params);
      const grouped = ["channel", "downloadPlatform"].includes(params.dimensions);
      const ratios: Record<string, [number, number]> = { M005: [3, 4], M006: [3, 3], M007: [3, 4], M099: [3, 4] };
      return envelope(params.metricCodes.split(",").filter(metricCode => grouped || metricCode in ratios).map(metricCode => {
        const ratio = !["M001", "M003"].includes(metricCode), [numerator, denominator] = ratios[metricCode] ?? [metricCode === "M001" ? 4 : 3, 0];
        return { metricCode, ...(params.granularity === "summary" ? {} : { businessDate: selectedQuery.dateRange[0] }),
          dimensions: { pid: "PH", ...(grouped ? { [params.dimensions]: "A-B" } : {}) },
          value: ratio ? numerator / denominator : numerator, numerator, denominator,
          unit: ratio ? "ratio" : "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "returned-rule" };
      }));
    } }, () => new Date("2026-09-24T00:00:00Z"));
    const result = await service.execute(selectedQuery), channel = result.data.acquisitionGroups!.channel;
    const channelRequests = requests.filter(request => request.dimensions === "channel");
    expect(channelRequests).toHaveLength(2);
    expect(channelRequests.map(request => [request.granularity, request.metricCodes])).toEqual([
      ["day", "M001,M003,M005,M099"], ["summary", "M001,M003,M005,M099"]
    ]);
    expect(channel.groups[0].series.map(series => series.metric.id)).toEqual(["M001", "M003", "M005", "M006", "M007", "M099"]);
    for (const [id, value] of [["M001", 4], ["M003", 3], ["M005", .75], ["M099", .75]] as const) {
      const series = channel.groups[0].series.find(series => series.metric.id === id)!;
      expect(series.points[0]).toMatchObject({ state: "available", value, sourceStatus: "READY" });
      expect(series.summary).toMatchObject({ state: "available", value, sourceStatus: "READY" });
    }
    for (const lane of [channel.day, channel.summary]) {
      expect(lane.state).toBe("returned");
      for (const metricId of ["M006", "M007"]) expect(lane.scopeStatuses).toContainEqual({ metricId, sourceStatus: "SOURCE_INCOMPLETE" });
    }
    for (const id of ["M006", "M007"]) {
      const grouped = channel.groups[0].series.find(series => series.metric.id === id)!;
      for (const point of [...grouped.points, grouped.summary]) {
        expect(point).toMatchObject({ state: "no_value", value: null, ruleVersion: null });
        expect(point.sourceStatus).toBeUndefined();
        expect(point.inputs.every(input => input.value === null)).toBe(true);
      }
      const overallRequests = requests.filter(request => request.metricCodes.split(",").includes(id));
      expect(overallRequests).toHaveLength(1);
      expect(overallRequests[0].dimensions).toBeUndefined();
      expect(overallRequests[0].dimensionFilters).toBeUndefined();
      expect(result.data.series.find(series => series.metric.id === id)!.points[0])
        .toMatchObject({ state: "available", value: id === "M006" ? 1 : .75, sourceStatus: "READY" });
    }
    expect(dailyDashboardMatchesQuery(result, selectedQuery, result.data.series.map(series => series.metric.id))).toBe(true);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });
  test("仅5.7额外发四路分组，原总体series与周期统计不被分组替换", async () => {
    const calls: Params[] = [], service = make(groupedRows, params => calls.push(params));
    const populated = await service.execute(query), empty = await make().execute(query);
    expect(populated.data.series).toEqual(empty.data.series);
    expect(calls).toHaveLength(4);
    expect(populated.data.sourceApiIds).toEqual(empty.data.sourceApiIds);
    const groups = populated.data.acquisitionGroups!;
    expect(groups.channel.groups[0].series.map(series => series.metric.id)).toEqual(["M001", "M003", "M005", "M006", "M007", "M099"]);
    expect(groups.downloadPlatform.groups[0].series.map(series => series.metric.id)).toEqual(["M003"]);
    const reading = groups.channel.groups[0].series.find(series => series.metric.id === "M005")!;
    expect(reading.points[0]).toMatchObject({ state: "available", value: 0.5, inputs: [{ key: "totalDownCountNoDedup", value: 2 }, { key: "visiCountNoDedup", value: 4 }], ruleVersion: "returned-rule" });
    expect(reading.metric.sourceNote).toContain("独立分组结果");
    expect(groups.channel.groups[0].series[1].summary.value).toBe(80);
    expect(dailyDashboardMatchesQuery(populated, query, populated.data.series.map(series => series.metric.id))).toBe(true);
    expect(dailyDashboardMatchesMapping(populated)).toBe(true);
    const before = calls.length, otherBoard = await service.execute({ ...query, boardId: "5.8" });
    expect(calls).toHaveLength(before); expect(otherBoard.data.acquisitionGroups).toBeUndefined();
  });
  test("一个维度请求失败，其他结果与旧序列继续可用", async () => {
    const failed = await make(params => {
      if (params.dimensions === "channel") throw new Error("fixture failure");
      return groupedRows(params);
    }).execute(query);
    expect(failed.data.acquisitionGroups!.channel).toMatchObject({ groups: [], day: { state: "source_failure" }, summary: { state: "source_failure" } });
    expect(failed.data.acquisitionGroups!.downloadPlatform.groups[0].series[0].summary.value).toBe(80);
    expect(failed.data.series).toEqual((await make().execute(query)).data.series);
    expect(dailyDashboardMatchesMapping(failed)).toBe(true);
  });
  test("沿用本次请求client/profile，无独立环境回退", async () => {
    const profile = { environment: "test" as const, baseUrl: "https://fixture.invalid", token: "isolated-fixture-only", userName: "fixture", cachePartition: "fixture-partition" };
    const observed: Array<ReturnType<typeof currentUpstreamRequestProfile>> = [];
    await runWithUpstreamRequestProfile(profile, () => make(groupedRows, () => observed.push(currentUpstreamRequestProfile())).execute(query));
    expect(observed).toHaveLength(4);
    expect(observed.every(value => value === profile)).toBe(true);
    expect(currentUpstreamRequestProfile()).toBeUndefined();
  });
  test("映射校验拒绝分组元数据漂移，但兼容没有扩展的旧v2结果", async () => {
    const result = await make(groupedRows).execute(query);
    const missing = structuredClone(result); delete missing.data.acquisitionGroups;
    expect(dailyDashboardMatchesMapping(missing)).toBe(true);
    result.data.acquisitionGroups!.channel.groups[0].series[0].metric.formula = "invented";
    expect(dailyDashboardMatchesMapping(result)).toBe(false);
  });
});
