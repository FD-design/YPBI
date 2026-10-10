import { describe, expect, test } from "bun:test";
import { DAILY_PLAYBACK_METRIC_IDS, dailyDashboardMatchesQuery, dailyDashboardSuccessSchema, dailyPlaybackGroupsSchema, dailyPlaybackPointSchema, dailyPlaybackSummarySchema, type DailyDashboardQuery, type DailyPlaybackGroupSeries } from "../../contracts/daily-dashboard";
import { BI_V1_PLAYBACK_API, projectBiV1PlaybackGroups, type BiV1MetricRow } from "../upstream/bi-v1.adapter";
import { UpstreamError } from "../upstream/client";
import { currentUpstreamRequestProfile, runWithUpstreamRequestProfile } from "../upstream/request-profile";
import { DailyDashboardService, dailyDashboardMatchesMapping } from "./daily-dashboard.service";

const date = "2026-09-21";
const query: DailyDashboardQuery = { boardId: "5.12", pid: "PH", dateRange: [date, date] };
const group = (key = "type-a", effective = 7, starts = 8, businessDate = date): BiV1MetricRow[] => DAILY_PLAYBACK_METRIC_IDS.map(metricCode => ({
  metricCode, businessDate, dimensions: { pid: "PH", videoType: key },
  value: metricCode === "M036" ? starts ? effective / starts : null : metricCode === "M034" ? effective : starts,
  numerator: metricCode === "M097" ? starts : effective, denominator: metricCode === "M036" ? starts : 0,
  unit: metricCode === "M036" ? "ratio" : "count", dataStatus: "READY", metricVersion: "bi-v1",
  ruleVersion: metricCode === "M097" ? "successful-start-v1" : "effective_play_v3"
}));
const message = (rows: BiV1MetricRow[]) => ({ metricVersion: "bi-v1" as const, generatedAt: "2026-09-23T00:00:00Z", watermark: "source-watermark", rows });
const execute = async (rows = group(), options: { query?: DailyDashboardQuery; fail?: boolean; payload?: unknown; now?: string; projectionError?: Error } = {}) => {
  const requests: Array<{ path: string; params: Record<string, string>; partition?: string }> = [];
  const Service = options.projectionError ? class extends DailyDashboardService {
    protected override projectPlaybackGroups: typeof projectBiV1PlaybackGroups = () => { throw options.projectionError; };
  } : DailyDashboardService;
  const result = await new Service({ get: async (path, params) => {
    requests.push({ path, params, partition: currentUpstreamRequestProfile()?.cachePartition });
    if (path === BI_V1_PLAYBACK_API) {
      if (options.fail) throw new Error("fixture unavailable");
      return options.payload ?? { code: 200, msg: message(rows) };
    }
    return { code: 200, msg: message([]) };
  } }, () => new Date(options.now ?? "2026-09-24T00:00:00Z")).execute(options.query ?? query);
  const typed = (result.data.playbackGroups?.videoType)!;
  const series = (id = "M036", key = "type-a") => typed.groups.find(group => group.key === key)!.series.find(series => series.metric.id === id)!;
  return { result, typed, requests, series };
};

describe("5.12 视频类型分组", () => {
  test("同一原始日请求供总体与可选分组，保留未知类型、版本和分子分母", async () => {
    const { result, typed, requests, series } = await execute([...group(), ...group("unknown-type/中文", 1, 2)]);
    expect(requests.filter(request => request.path === BI_V1_PLAYBACK_API)).toEqual([{ path: BI_V1_PLAYBACK_API,
      params: { pid: "PH", startDate: date, endDate: "2026-09-22", granularity: "day", dimensions: "videoType", metricCodes: "M034,M036,M097", includeIncomplete: "true" }, partition: undefined }]);
    expect(typed.completeness).toBe("unknown");
    expect(typed.groups.map(group => [group.key, group.label])).toEqual([["type-a", "type-a"], ["unknown-type/中文", "unknown-type/中文"]]);
    expect(series().points[0]).toEqual({ date, state: "available", value: 7 / 8, ruleVersion: "effective_play_v3", sourceStatus: "READY",
      inputs: [{ key: "effectivePlayCount", value: 7 }, { key: "successfulStartCount", value: 8 }] });
    expect(series("M097").summary.value).toBe(8);
    expect(result.data.series.find(series => series.metric.id === "M036")!.points[0].value).toBe(8 / 10);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
    expect(dailyDashboardMatchesQuery(result, query, result.data.series.map(series => series.metric.id))).toBe(true);
  });

  test("区间次数相加、比率按总分子分母，不平均日比率", async () => {
    const { series } = await execute([...group("type-a", 3, 4), ...group("type-a", 1, 10, "2026-09-22")], { query: { ...query, dateRange: [date, "2026-09-22"] } });
    expect(series("M034").summary.value).toBe(4);
    expect(series("M097").summary.value).toBe(14);
    expect(series().summary).toEqual({ state: "available", value: 4 / 14, ruleVersion: "effective_play_v3", sourceStatus: "READY",
      inputs: [{ key: "effectivePlayCount", value: 4 }, { key: "successfulStartCount", value: 14 }] });
  });

  test("类型缺日不补0；所有日明细保留，区间不生成数值", async () => {
    const { series } = await execute(group(), { query: { ...query, dateRange: [date, "2026-09-22"] } });
    expect(series().points.map(point => point.state)).toEqual(["available", "no_record"]);
    expect(series().points[1].inputs.every(input => input.value === null)).toBe(true);
    expect(series().summary.state).toBe("incomplete");
    expect(series().summary.value).toBeNull();
  });

  test("真实0与0/0保留不同日/区间状态", async () => {
    const { series } = await execute(group("type-a", 0, 0));
    expect(series("M097").points[0].value).toBe(0);
    expect(series("M034").summary.value).toBe(0);
    expect(series().points[0].state).toBe("zero_denominator");
    expect(series().summary.state).toBe("zero_denominator");
    expect(series().summary.inputs.map(input => input.value)).toEqual([0, 0]);
  });

  for (const [dataStatus, state] of [["PROCESSING", "no_value"], ["SOURCE_INCOMPLETE", "no_value"], ["NOT_MATURE", "immature"], ["FAILED", "source_failure"]] as const) {
    test(`${dataStatus} 保留状态但清空数值输入`, async () => {
      const { series } = await execute(group().map(row => ({ ...row, dataStatus, value: null, ruleVersion: undefined })));
      expect(series().points[0]).toMatchObject({ state, sourceStatus: dataStatus, value: null, ruleVersion: null });
      expect(series().points[0].inputs.every(input => input.value === null)).toBe(true);
      expect(series().summary.state).toBe("incomplete");
    });
  }

  test("PID范围未就绪只补缺日，明确组/日READY优先；无类型不造组", async () => {
    const scopes = group().map(row => ({ ...row, dimensions: { pid: "PH" }, businessDate: undefined, dataStatus: "SOURCE_INCOMPLETE" as const, value: null }));
    const { typed, series } = await execute([...scopes, ...group()], { query: { ...query, dateRange: [date, "2026-09-22"] } });
    expect(typed.day.scopeStatuses).toHaveLength(3);
    expect(series().points.map(point => [point.state, point.sourceStatus])).toEqual([["available", "READY"], ["no_value", "SOURCE_INCOMPLETE"]]);
    expect((await execute(scopes)).typed.groups).toEqual([]);
    expect((await execute(group().map(row => ({ ...row, dimensions: { pid: "PH" } })))).typed.groups).toEqual([]);
  });

  test("同组同日重复只使该组失效，不修补原总体且其他组合法", async () => {
    const rows = [...group(), group()[0], ...group("type-b", 1, 2)];
    const { series, result } = await execute(rows);
    expect(series().points[0].state).toBe("invalid_value");
    expect(series("M036", "type-b").points[0].value).toBe(.5);
    expect(result.data.series.find(series => series.metric.id === "M036")!.points[0].state).toBe("source_failure");
  });

  for (const ruleVersion of ["effective_play_v2", "", undefined]) test(`有效规则${ruleVersion ?? "缺失"}不接入，起播规则独立`, async () => {
    const { series } = await execute(group().map(row => row.metricCode === "M097" ? row : { ...row, ruleVersion }));
    expect(series().points[0].state).toBe("invalid_value");
    expect(series("M034").summary.state).toBe("incomplete");
    expect(series("M097").points[0].value).toBe(8);
  });

  test("起播缺版分组不可读但不改变原总体准入；跨日起播版本混合无汇总", async () => {
    const missing = await execute(group().map(row => row.metricCode === "M097" ? { ...row, ruleVersion: undefined } : row));
    expect(missing.series("M097").points[0]).toMatchObject({ state: "invalid_value", ruleVersion: null, sourceStatus: "READY" });
    expect(missing.result.data.series.find(series => series.metric.id === "M097")!.points[0].value).toBe(8);
    const mixed = await execute([...group(), ...group("type-a", 1, 2, "2026-09-22").map(row => row.metricCode === "M097" ? { ...row, ruleVersion: "successful-start-v2" } : row)], { query: { ...query, dateRange: [date, "2026-09-22"] } });
    expect(mixed.series("M097").summary.state).toBe("incomplete");
    expect(mixed.series("M097").summary.ruleVersion).toBeNull();
  });

  test("当前日未结束不产生区间汇总", async () => {
    const { series } = await execute(group(), { now: "2026-09-21T10:00:00Z" });
    expect(series().summary.state).toBe("immature");
    expect(series().summary.inputs.every(input => input.value === null)).toBe(true);
  });

  test("失败、空、响应异常独立表达，不生成类型", async () => {
    expect((await execute([], { fail: true })).typed.day.state).toBe("source_failure");
    expect((await execute([])).typed.day.state).toBe("empty");
    expect((await execute([], { payload: { code: 200, msg: {} } })).typed.day.state).toBe("invalid_response");
    expect((await execute(group().map(row => ({ ...row, dimensions: { ...row.dimensions, videoId: "unrequested" } })))).typed.day.state).toBe("invalid_response");
    expect((await execute(group().map(row => ({ ...row, businessDate: undefined })))).typed.day.state).toBe("invalid_response");
  });

  test("未知分页元数据不宣称完整；组数和展开点数有安全上限", async () => {
    const { typed, series } = await execute(group(), { payload: { code: 200, msg: { ...message(group()), total: 100, hasMore: true } } });
    expect(typed.completeness).toBe("unknown");
    const metricFor = (id: "M034" | "M036" | "M097") => series(id).metric;
    const rows = Array.from({ length: 1001 }, (_, index) => group(`type-${index}`, 0, 0)).flat();
    const scope = { pid: "PH", startDate: date, endDate: date };
    expect(projectBiV1PlaybackGroups(message(rows), scope, "2026-10-01", metricFor).videoType.day.state).toBe("invalid_response");
    expect(projectBiV1PlaybackGroups(message(rows.slice(0, 300)), { ...scope, startDate: "2026-01-01", endDate: "2026-12-31" }, "2027-01-01", metricFor).videoType.day.state).toBe("invalid_response");
  });

  test("安全整数跨日溢出只关闭汇总，合法日值保留", async () => {
    const { series } = await execute([...group("type-a", 1, Number.MAX_SAFE_INTEGER), ...group("type-a", 1, 1, "2026-09-22")], { query: { ...query, dateRange: [date, "2026-09-22"] } });
    expect(series("M097").points.every(point => point.state === "available")).toBe(true);
    expect(series("M097").summary.state).toBe("invalid_value");
    expect(series().summary.state).toBe("invalid_value");
    expect(series("M034").summary.value).toBe(2);
  });

  test("分组展开点数超限软失败，总体仍保留同一请求的合法值", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => group(`type-${index}`, 1, 2)).flat();
    const { result, typed, requests } = await execute(rows, { query: { ...query, dateRange: ["2026-01-01", "2026-12-31"] } });
    expect(typed.day.state).toBe("invalid_response");
    expect(typed.groups).toEqual([]);
    expect(requests.filter(request => request.path === BI_V1_PLAYBACK_API)).toHaveLength(1);
    for (const [id, value] of [["M034", 100], ["M036", .5], ["M097", 200]] as const) {
      expect(result.data.series.find(series => series.metric.id === id)!.points.find(point => point.date === date)).toMatchObject({ state: "available", value });
    }
  });

  test("扩展投影意外异常隔离，不跳过或重试总体计算", async () => {
    for (const [projectionError, state] of [[new Error("fixture projection failure"), "source_failure"],
      [new UpstreamError("BI_V1_VALUE_CONFLICT", "fixture projection conflict", 502), "invalid_response"]] as const) {
      const { result, typed, requests } = await execute(group(), { projectionError });
      expect(typed.day.state).toBe(state);
      expect(typed.groups).toEqual([]);
      expect(requests.filter(request => request.path === BI_V1_PLAYBACK_API)).toHaveLength(1);
      for (const [id, value] of [["M034", 7], ["M036", 7 / 8], ["M097", 8]] as const) {
        expect(result.data.series.find(series => series.metric.id === id)!.points[0]).toMatchObject({ state: "available", value });
      }
    }
  });

  test("环境上下文原样沿同一请求传播，不新建环境分支", async () => {
    const profile = { environment: "test" as const, baseUrl: "https://test.invalid", token: "fixture-token", userName: "fixture", cachePartition: "playback-fixture" };
    const result = await runWithUpstreamRequestProfile(profile, () => execute());
    expect(result.requests.every(request => request.partition === "playback-fixture")).toBe(true);
    expect((await execute()).requests.every(request => request.partition === undefined)).toBe(true);
  });

  test("可选扩展兼容旧响应，但5.12旧缓存或旧分组元数据必须失效", async () => {
    const { result } = await execute();
    const old = structuredClone(result); delete old.data.playbackGroups;
    expect(dailyDashboardSuccessSchema.safeParse(old).success).toBe(true);
    expect(dailyDashboardMatchesMapping(old)).toBe(false);
    const stale = structuredClone(result); stale.data.playbackGroups!.videoType.groups[0].series[0].metric.sourceNote = "stale";
    expect(dailyDashboardMatchesMapping(stale)).toBe(false);
    expect((await execute(group(), { query: { ...query, boardId: "5.9" } })).result.data.playbackGroups).toBeUndefined();
  });

  test("契约拒绝无版本可读值、未就绪数值和异常输入，接受缺版原始异常", async () => {
    const { series } = await execute();
    const point = series().points[0], summary = series().summary;
    for (const schema of [dailyPlaybackPointSchema, dailyPlaybackSummarySchema]) {
      const reading = schema === dailyPlaybackPointSchema ? point : summary;
      for (const change of [{ sourceStatus: undefined }, { sourceStatus: "PROCESSING" }, { ruleVersion: null }, { ruleVersion: "" }, { ruleVersion: " " }])
        expect(schema.safeParse({ ...reading, ...change }).success).toBe(false);
      expect(schema.safeParse({ ...reading, state: "invalid_value", value: null }).success).toBe(false);
      expect(schema.safeParse({ ...reading, state: "invalid_value", value: null, inputs: reading.inputs.map(input => ({ ...input, value: null })), ruleVersion: null }).success).toBe(true);
      expect(schema.safeParse({ ...reading, state: "no_record", value: null, inputs: reading.inputs.map(input => ({ ...input, value: null })) }).success).toBe(false);
    }
  });

  test("契约拒绝重复类型、错指标、videoId、非返回分组、错误看板及日期输入漂移", async () => {
    const { result, typed } = await execute();
    const invalid = [
      { ...typed, groups: [...typed.groups, typed.groups[0]] },
      { ...typed, dimension: "videoId" },
      { ...typed, day: { ...typed.day, state: "empty" } },
      { ...typed, groups: [{ ...typed.groups[0], series: typed.groups[0].series.map(() => typed.groups[0].series[0]) }] }
    ];
    invalid.forEach(videoType => expect(dailyPlaybackGroupsSchema.safeParse({ videoType }).success).toBe(false));
    expect(dailyDashboardSuccessSchema.safeParse({ ...result, data: { ...result.data, query: { ...query, boardId: "5.13" } } }).success).toBe(false);
    for (const mutate of [
      (series: DailyPlaybackGroupSeries) => { series.points[0].date = "2026-09-20"; },
      (series: DailyPlaybackGroupSeries) => { series.points[0].inputs[0].key = "drift"; }
    ]) {
      const changed = structuredClone(result); mutate(changed.data.playbackGroups!.videoType.groups[0].series[0]);
      expect(dailyDashboardMatchesQuery(changed, query, result.data.series.map(series => series.metric.id))).toBe(false);
    }
  });
});
