import { describe, expect, test } from "bun:test";
import { DAILY_ACQUISITION_METRIC_IDS, type DailyDashboardV2Success } from "../../contracts/daily-dashboard";
import { BI_V1_METRICS_API, type BiV1MetricDataStatus, type BiV1MetricUnit } from "../upstream/bi-v1.metrics-adapter";
import { UpstreamError } from "../upstream/client";
import { DailyDashboardService, dailyDashboardMatchesMapping } from "./daily-dashboard.service";

const businessDate = "2020-01-01";
const range = { pid: "PH", dateRange: [businessDate, businessDate] as [string, string] };
const generatedAt = "2026-10-09T10:00:00+08:00";
type Filters = Record<string, string>;
type Row = {
  metricCode: string;
  businessDate?: string;
  dimensions: Filters;
  value: number | null;
  numerator: number;
  denominator: number;
  unit: BiV1MetricUnit;
  dataStatus: BiV1MetricDataStatus;
  metricVersion: "bi-v1";
  ruleVersion: string;
};
type Request = { path: string; params: Record<string, string> };

const scopeKey = (filters: Filters) => JSON.stringify(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)));
const makeRow = (metricCode: string, filters: Filters, numerator: number, denominator = 0, unit: BiV1MetricUnit = "count"): Row => ({
  metricCode, businessDate, dimensions: { pid: "PH", ...filters },
  value: unit === "count" ? numerator : numerator / denominator,
  numerator, denominator, unit, dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "integration-fixture-v1"
});
const envelope = (rows: Row[]) => ({ code: 200, msg: { metricVersion: "bi-v1", generatedAt, watermark: null, rows } });

const activityGroups: { id: string; filters: Filters; active: number; watch: number }[] = [
  { id: "android", filters: { clientPlatform: "android" }, active: 4, watch: 3 },
  { id: "ios", filters: { clientPlatform: "ios" }, active: 2, watch: 1 },
  { id: "new", filters: { userCohort: "new" }, active: 3, watch: 2 },
  { id: "old", filters: { userCohort: "old" }, active: 3, watch: 2 },
  { id: "androidOld", filters: { clientPlatform: "android", userCohort: "old" }, active: 2, watch: 1 },
  { id: "iosOld", filters: { clientPlatform: "ios", userCohort: "old" }, active: 1, watch: 1 }
];
const acquisitionGroups: { id: string; retentionId: string; filters: Filters; registered: number; retained: number }[] = [
  { id: "android", retentionId: "android", filters: { clientPlatform: "android" }, registered: 6, retained: 5 },
  { id: "ios", retentionId: "ios", filters: { clientPlatform: "ios" }, registered: 4, retained: 3 },
  { id: "nature", retentionId: "natural", filters: { sourceType: "natural" }, registered: 7, retained: 6 },
  { id: "internal", retentionId: "internal", filters: { sourceType: "internal_channel" }, registered: 3, retained: 2 }
];
const paymentGroups = [
  { id: "alipay", filters: { paymentMethod: "ali_pay" }, orders: 8, users: 6, paid: 4 },
  { id: "wechat", filters: { paymentMethod: "wx_pay" }, orders: 12, users: 9, paid: 3 },
  { id: "usdt", filters: { paymentMethod: "usdt_pay" }, orders: 6, users: 5, paid: 2 },
  { id: "unknown", filters: { paymentMethod: "unknown" }, orders: 6, users: 3, paid: 3 }
];

function requestDrivenUpstream(failure: "none" | "cross" | "legacy_fallback" = "none") {
  const calls: Request[] = [];
  const rows = [
    makeRow("M016", {}, 6), makeRow("M026", {}, 4), makeRow("M081", {}, 4, 6, "ratio"),
    makeRow("M008", {}, 10), makeRow("M101", {}, 3),
    makeRow("M059", {}, 5), makeRow("M059", { userCohort: "new" }, 3),
    makeRow("M094", {}, 4), makeRow("M094", { userCohort: "new" }, 2),
    makeRow("M020", {}, 8, 10, "ratio"), makeRow("M021", {}, 7, 10, "ratio"),
    makeRow("M022", {}, 6, 10, "ratio"), makeRow("M023", {}, 5, 10, "ratio"),
    makeRow("M112", {}, 26), makeRow("M113", {}, 20), makeRow("M060", {}, 9), makeRow("M114", {}, 9, 26, "ratio"),
    makeRow("M110", {}, 3, 6, "count_per_user"), makeRow("M111", {}, 2, 6, "ratio"),
    makeRow("M110", { userCohort: "new" }, 2, 3, "count_per_user"), makeRow("M111", { userCohort: "new" }, 1, 3, "ratio"),
    ...activityGroups.flatMap(group => [
      makeRow("M016", group.filters, group.active), makeRow("M026", group.filters, group.watch),
      makeRow("M081", group.filters, group.watch, group.active, "ratio")
    ]),
    ...acquisitionGroups.flatMap(group => [
      makeRow("M008", group.filters, group.registered),
      makeRow("M020", group.filters, group.retained, group.registered, "ratio")
    ]),
    ...paymentGroups.flatMap(group => [
      makeRow("M112", group.filters, group.orders), makeRow("M113", group.filters, group.users),
      makeRow("M060", group.filters, group.paid), makeRow("M114", group.filters, group.paid, group.orders, "ratio")
    ])
  ];
  const client = { get: async (path: string, params: Record<string, string>) => {
    calls.push({ path, params: { ...params } });
    if (path === BI_V1_METRICS_API) {
      const requestedCodes = new Set(params.metricCodes.split(","));
      const filters: Filters = JSON.parse(params.dimensionFilters ?? "{}");
      if (failure === "cross" && scopeKey(filters) === scopeKey({ clientPlatform: "android", userCohort: "old" })
        || failure === "legacy_fallback" && scopeKey(filters) === scopeKey({ clientPlatform: "android" })) {
        throw new UpstreamError("UPSTREAM_TIMEOUT", "fixture group unavailable", 504);
      }
      if (failure === "legacy_fallback" && scopeKey(filters) === scopeKey({}) && (requestedCodes.has("M110") || requestedCodes.has("M111"))) {
        return { code: 400, err: "Unsupported metric: M110, M111" };
      }
      if (params.granularity === "summary") {
        const monthly = makeRow("M018", {}, 6);
        delete monthly.businessDate;
        return envelope(requestedCodes.has("M018") && scopeKey(filters) === scopeKey({}) ? [monthly] : []);
      }
      const selected = rows.filter(row => {
        const { pid: _pid, ...rowFilters } = row.dimensions;
        return requestedCodes.has(row.metricCode) && scopeKey(rowFilters) === scopeKey(filters);
      }).map(row => {
        if (failure !== "cross" || scopeKey(filters) !== scopeKey({ clientPlatform: "ios", userCohort: "old" })) return row;
        const dataStatus: BiV1MetricDataStatus = row.metricCode === "M016" ? "PROCESSING" : row.metricCode === "M026" ? "SOURCE_INCOMPLETE" : "NOT_MATURE";
        return { ...row, dataStatus, value: 999 };
      });
      return envelope(selected);
    }
    if (path.endsWith("pRealDayLine")) throw new UpstreamError("UPSTREAM_TIMEOUT", "fixture legacy playback unavailable", 504);
    if (path.endsWith("pDaySum")) return { msg: { pageData: [], totalCount: 0 } };
    if (path.includes("reletionsStatPlus")) return { data: [] };
    if (path.includes("channelStatByTypeV2")) return { msg: { pageData: [], totalData: [] } };
    if (path.endsWith("getRechargeSucRate")) return { msg: { pageData: [] } };
    if (path.endsWith("/bi/v1/playback")) return envelope([]);
    throw new Error(`Unexpected upstream endpoint: ${path}`);
  } };
  return { calls, service: new DailyDashboardService(client, () => new Date(generatedAt)) };
}

function point(result: DailyDashboardV2Success, id: string) {
  const series = result.data.series.find(item => item.metric.id === id);
  expect(series).toBeDefined();
  return series!.points[0];
}

function expectReady(result: DailyDashboardV2Success, id: string, value: number) {
  expect(point(result, id)).toMatchObject({ date: businessDate, state: "available", sourceStatus: "READY", value });
}

function expectRequestScopes(calls: Request[]) {
  const metricCalls = calls.filter(call => call.path === BI_V1_METRICS_API);
  expect(metricCalls.length).toBeGreaterThan(0);
  for (const { params } of metricCalls) {
    const filters: Filters = JSON.parse(params.dimensionFilters ?? "{}");
    expect(params.pid).toBe("PH");
    expect(params.startDate).toBe(businessDate);
    expect(params.includeIncomplete).toBe("true");
    if (params.dimensions === "channel" || params.dimensions === "downloadPlatform") {
      expect(params.dimensionFilters).toBeUndefined();
      expect(["day", "summary"]).toContain(params.granularity);
      expect(params.metricCodes.split(",")).toEqual([...DAILY_ACQUISITION_METRIC_IDS[params.dimensions]]);
      expect(params.endDate).toBe("2020-01-02");
      continue;
    }
    expect((params.dimensions ?? "").split(",").filter(Boolean).sort()).toEqual(Object.keys(filters).sort());
    if (params.granularity === "summary") {
      expect(params.metricCodes).toBe("M018");
      expect(params.endDate).toBe("2020-02-01");
      expect(filters).toEqual({});
    } else {
      expect(params.granularity).toBe("day");
      expect(params.endDate).toBe("2020-01-02");
      expect(params.metricCodes.split(",")).not.toContain("M018");
    }
  }
}

describe("日看板按实际请求范围读取模拟上游", () => {
  test("经营明细独立读取总体、单维、交叉维与月活，旧日接口无值时保留正式端值", async () => {
    const { service, calls } = requestDrivenUpstream();
    const result = await service.execute({ ...range, boardId: "5.2" });
    expectReady(result, "M018", 6);
    expectReady(result, "M101", 3);
    expectReady(result, "M059", 5);
    expectReady(result, "M059.new", 3);
    expectReady(result, "M094.ads", 4);
    expectReady(result, "M094.new", 2);
    expect(calls.filter(call => call.path.endsWith("pRealDayLine"))).toHaveLength(1);
    expectReady(result, "M110.new", 2 / 3);
    expect(point(result, "M110.new").inputs.map(input => input.value)).toEqual([2, 3]);
    expect(result.data.series.find(item => item.metric.id === "M110.new")?.metric.unit).toBe("次/人");
    expectReady(result, "M110", .5);
    expectReady(result, "M111", 1 / 3);
    for (const group of activityGroups) {
      expectReady(result, `M016.${group.id}`, group.active);
      expectReady(result, `M026.${group.id}`, group.watch);
      expectReady(result, `M081.${group.id}`, group.watch / group.active);
      expect(point(result, `M081.${group.id}`).inputs.map(input => input.value)).toEqual([group.watch, group.active]);
    }
    for (const group of acquisitionGroups) {
      expectReady(result, `M008.${group.id}`, group.registered);
      expectReady(result, `M020.${group.retentionId}`, group.retained / group.registered);
    }
    for (const group of paymentGroups) {
      for (const [metric, value] of [["M112", group.orders], ["M113", group.users], ["M060", group.paid], ["M114", group.paid / group.orders]] as const) {
        expectReady(result, `${metric}.${group.id}`, value);
      }
      expect(point(result, `M114.${group.id}`).inputs.map(input => input.value)).toEqual([group.paid, group.orders]);
    }
    for (const [period, retained] of [["d1", 8], ["d3", 7], ["d7", 6], ["d30", 5]] as const) {
      expectReady(result, `M115.${period}`, retained);
    }
    expectReady(result, "display:M016", 2);
    expect(point(result, "display:M016").inputs.map(input => input.value)).toEqual([4, 2]);
    expectReady(result, "display:M008", 1.5);
    expect(point(result, "display:M008").inputs.map(input => input.value)).toEqual([6, 4]);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
    expectRequestScopes(calls);
    const requests = calls.filter(call => call.path === BI_V1_METRICS_API);
    expect(requests.filter(call => call.params.granularity === "summary")).toHaveLength(1);
    for (const group of [...activityGroups, ...acquisitionGroups, ...paymentGroups]) {
      const groupedCalls = requests.filter(call => scopeKey(JSON.parse(call.params.dimensionFilters ?? "{}")) === scopeKey(group.filters));
      expect(groupedCalls).toHaveLength(1);
    }
    for (const platform of ["android", "ios"]) {
      const cross = requests.find(call => scopeKey(JSON.parse(call.params.dimensionFilters ?? "{}")) === scopeKey({ clientPlatform: platform, userCohort: "old" }));
      expect(cross).toBeDefined();
      expect(cross!.params.metricCodes.split(",").sort()).toEqual(["M016", "M026", "M081"]);
      expect(cross!.params.dimensions.split(",").sort()).toEqual(["clientPlatform", "userCohort"]);
    }
  });

  test("一个交叉分组失败仅影响该分组，非READY丢弃脏值且不补零", async () => {
    const { service, calls } = requestDrivenUpstream("cross");
    const result = await service.execute({ ...range, boardId: "5.2" });
    for (const metric of ["M016", "M026", "M081"]) {
      expect(point(result, `${metric}.androidOld`)).toMatchObject({ state: "source_failure", value: null });
      expect(point(result, `${metric}.androidOld`).inputs.every(input => input.value === null)).toBe(true);
    }
    for (const [metric, state, sourceStatus] of [
      ["M016", "no_value", "PROCESSING"], ["M026", "no_value", "SOURCE_INCOMPLETE"], ["M081", "immature", "NOT_MATURE"]
    ] as const) {
      expect(point(result, `${metric}.iosOld`)).toMatchObject({ state, sourceStatus, value: null });
      expect(point(result, `${metric}.iosOld`).inputs.every(input => input.value === null)).toBe(true);
    }
    for (const group of activityGroups.filter(group => !group.id.endsWith("Old"))) {
      expectReady(result, `M016.${group.id}`, group.active);
      expectReady(result, `M026.${group.id}`, group.watch);
      expectReady(result, `M081.${group.id}`, group.watch / group.active);
    }
    expectReady(result, "M016", 6);
    expectReady(result, "M026", 4);
    expectReady(result, "M081", 4 / 6);
    expectReady(result, "M018", 6);
    expectReady(result, "M101", 3);
    expectReady(result, "M110.new", 2 / 3);
    expectReady(result, "M114.alipay", .5);
    expectReady(result, "display:M016", 2);
    expectReady(result, "display:M008", 1.5);
    expectRequestScopes(calls);
    const failedCalls = calls.filter(call => call.path === BI_V1_METRICS_API && scopeKey(JSON.parse(call.params.dimensionFilters ?? "{}")) === scopeKey({ clientPlatform: "android", userCohort: "old" }));
    expect(failedCalls).toHaveLength(1);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  test("旧日接口为空时保留端别与总体广告来源失败，不回退成无记录或零", async () => {
    const { service, calls } = requestDrivenUpstream("legacy_fallback");
    const result = await service.execute({ ...range, boardId: "5.2" });
    for (const id of ["M016.android", "M110", "M111", "display:M016", "display:M008"]) {
      expect(point(result, id)).toMatchObject({ state: "source_failure", value: null });
    }
    expectReady(result, "M016", 6);
    expectReady(result, "M016.ios", 2);
    expectReady(result, "M008.ios", 4);
    expectReady(result, "M110.new", 2 / 3);
    expectReady(result, "M111.new", 1 / 3);
    expectReady(result, "M018", 6);
    expectReady(result, "M101", 3);
    expectReady(result, "M114.alipay", .5);
    expectRequestScopes(calls);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  test("获客、活跃、观影和支付专题与经营明细读取同一精确分组", async () => {
    const { service, calls } = requestDrivenUpstream();
    const core = await service.execute({ ...range, boardId: "5.2" });
    for (const boardId of ["5.7", "5.8", "5.9", "5.11", "5.12"]) {
      const result = await service.execute({ ...range, boardId });
      for (const series of result.data.series) {
        if (series.points[0].sourceStatus !== "READY") continue;
        expect(series.points[0]).toEqual(point(core, series.metric.id));
      }
      expect(dailyDashboardMatchesMapping(result)).toBe(true);
    }
    expectRequestScopes(calls);
    const grouped = calls.filter(call => ["channel", "downloadPlatform"].includes(call.params.dimensions));
    expect(grouped.map(call => `${call.params.dimensions}/${call.params.granularity}`).sort()).toEqual([
      "channel/day", "channel/summary", "downloadPlatform/day", "downloadPlatform/summary"
    ]);
  });
});
