import { describe, expect, test } from "bun:test";
import { DAILY_ACQUISITION_METRIC_IDS, DAILY_DASHBOARD_MAX_SERIES, dailyAcquisitionGroupsSchema, dailyDashboardMatchesQuery, dailyDashboardSuccessSchema, dailyPeriodStatisticsSchema, type DailyAcquisitionGroups } from "./daily-dashboard";

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
  for (const version of ["day-dashboard/v1", "day-dashboard/v2"] as const) test(`${version}支持已登记八类来源，超出八源拒绝`, () => {
    for (const count of [4, 5, 8, 9]) {
      const result = response(version);
      result.data.sourceApiIds = Array.from({ length: count }, (_, i) => `/api/admin/source-${i}`);
      expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(count <= 8);
    }
  });
  for (const version of ["day-dashboard/v1", "day-dashboard/v2"] as const) test(`${version}容纳完整经营明细切片且保留响应数量上限`, () => {
    for (const count of [101, DAILY_DASHBOARD_MAX_SERIES, DAILY_DASHBOARD_MAX_SERIES + 1]) {
      const result = response(version);
      const template = result.data.series[0];
      result.data.series = Array.from({ length: count }, (_, i) => ({ ...structuredClone(template), metric: { ...template.metric, id: `slice-${i}` } }));
      expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(count <= DAILY_DASHBOARD_MAX_SERIES);
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

const acquisitionGroups = (): DailyAcquisitionGroups => {
  const request = { state: "returned" as const, scopeStatuses: [], generatedAt: "2026-09-07T01:00:00Z", watermark: null };
  const make = (dimension: "channel" | "downloadPlatform") => ({ dimension, completeness: "unknown" as const, day: structuredClone(request), summary: structuredClone(request), groups: [{ key: "A-B", label: "A-B",
    series: DAILY_ACQUISITION_METRIC_IDS[dimension].map(id => ({ metric: { ...series.metric, id },
      points: series.points.map(point => ({ ...point, state: "available" as const, sourceStatus: "READY" as const, ruleVersion: "actual-rule" })),
      summary: id === "M099" ? { state: "unsupported" as const, value: null, inputs: [{ key: "totalVistCount", value: null }], ruleVersion: null }
        : { state: "available" as const, sourceStatus: "READY" as const, value: 80, inputs: [{ key: "totalVistCount", value: 80 }], ruleVersion: "actual-rule" }
    })) }] });
  return { channel: make("channel"), downloadPlatform: make("downloadPlatform") };
};
const groupedResponse = () => { const result = response(); return { ...result, data: { ...result.data, acquisitionGroups: acquisitionGroups() } }; };

describe("动态获客分组可选扩展契约", () => {
  test("旧v1/v2不带分组仍可读，新分组仅v2且仅5.7", () => {
    for (const version of ["day-dashboard/v1", "day-dashboard/v2"] as const) expect(dailyDashboardSuccessSchema.safeParse(response(version)).success).toBe(true);
    const good = dailyDashboardSuccessSchema.parse(groupedResponse());
    expect(dailyDashboardMatchesQuery(good, query, ["M001"])).toBe(true);
    const v1 = response("day-dashboard/v1");
    expect(dailyDashboardSuccessSchema.safeParse({ ...v1, data: { ...v1.data, acquisitionGroups: acquisitionGroups() } }).success).toBe(false);
    const wrongBoard = groupedResponse(); wrongBoard.data.query = { ...query, boardId: "5.2" };
    expect(dailyDashboardSuccessSchema.safeParse(wrongBoard).success).toBe(false);
  });
  test("原始分组键保持不同；拒绝错误维度、重复组及不支持指标集合", () => {
    const raw = acquisitionGroups(); raw.channel.groups.push({ ...structuredClone(raw.channel.groups[0]), key: "a_b" });
    expect(dailyAcquisitionGroupsSchema.parse(raw).channel.groups.map(group => group.key)).toEqual(["A-B", "a_b"]);
    for (const mutate of [
      (value: DailyAcquisitionGroups) => { value.channel.dimension = "downloadPlatform"; },
      (value: DailyAcquisitionGroups) => { value.channel.groups.push(structuredClone(value.channel.groups[0])); },
      (value: DailyAcquisitionGroups) => { value.channel.groups[0].key = " "; },
      (value: DailyAcquisitionGroups) => { value.channel.groups[0].series.pop(); },
      (value: DailyAcquisitionGroups) => { value.downloadPlatform.groups[0].series[0].metric.id = "M008"; },
      (value: DailyAcquisitionGroups) => { value.channel.groups[0].series[0].metric.id = "M003"; }
    ]) { const value = acquisitionGroups(); mutate(value); expect(dailyAcquisitionGroupsSchema.safeParse(value).success).toBe(false); }
  });
  test("非READY不得携带数值，READY必须保留来源ruleVersion，unsupported不带来源结果", () => {
    for (const mutate of [
      (value: DailyAcquisitionGroups) => { value.channel.groups[0].series[0].points[0].sourceStatus = "SOURCE_INCOMPLETE"; },
      (value: DailyAcquisitionGroups) => { value.channel.groups[0].series[0].summary.sourceStatus = "FAILED"; },
      (value: DailyAcquisitionGroups) => { value.channel.groups[0].series[0].summary.ruleVersion = null; },
      (value: DailyAcquisitionGroups) => { value.channel.groups[0].series[0].points[0].ruleVersion = null; },
      (value: DailyAcquisitionGroups) => { value.channel.groups[0].series[5].summary.sourceStatus = "READY"; },
      (value: DailyAcquisitionGroups) => { value.channel.groups[0].series[5].summary.inputs[0].value = 0; }
    ]) { const value = acquisitionGroups(); mutate(value); expect(dailyAcquisitionGroupsSchema.safeParse(value).success).toBe(false); }
  });
  test("empty/failure与有效行互斥，重复矛盾范围状态及summary日期拒收", () => {
    for (const mutate of [
      (value: DailyAcquisitionGroups) => { value.channel.day.state = "empty"; },
      (value: DailyAcquisitionGroups) => { value.channel.summary.state = "source_failure"; },
      (value: DailyAcquisitionGroups) => { value.channel.day.state = "invalid_response"; value.channel.day.scopeStatuses = [{ metricId: "M003", sourceStatus: "FAILED" }]; },
      (value: DailyAcquisitionGroups) => { value.channel.day.scopeStatuses = [{ metricId: "M003", sourceStatus: "PROCESSING" }, { metricId: "M003", sourceStatus: "PROCESSING" }]; },
      (value: DailyAcquisitionGroups) => { value.channel.day.scopeStatuses = [{ metricId: "M003", sourceStatus: "PROCESSING" }, { metricId: "M003", sourceStatus: "FAILED", businessDate: query.dateRange[0] }]; },
      (value: DailyAcquisitionGroups) => { value.channel.summary.scopeStatuses = [{ metricId: "M003", sourceStatus: "FAILED", businessDate: query.dateRange[0] }]; },
      (value: DailyAcquisitionGroups) => { value.channel.day.scopeStatuses = [{ metricId: "M008", sourceStatus: "FAILED" }]; }
    ]) { const value = acquisitionGroups(); mutate(value); expect(dailyAcquisitionGroupsSchema.safeParse(value).success).toBe(false); }
  });
  test("日期与输入必须对齐查询，多日M099汇总明确不适用", () => {
    const missing = groupedResponse(); missing.data.acquisitionGroups.channel.groups[0].series[0].points.pop();
    expect(dailyDashboardMatchesQuery(dailyDashboardSuccessSchema.parse(missing), query, ["M001"])).toBe(false);
    const wrongDate = groupedResponse(); wrongDate.data.acquisitionGroups.channel.groups[0].series[0].points[0].date = "2026-09-04";
    expect(dailyDashboardMatchesQuery(dailyDashboardSuccessSchema.parse(wrongDate), query, ["M001"])).toBe(false);
    const wrongInput = groupedResponse(); wrongInput.data.acquisitionGroups.channel.groups[0].series[0].summary.inputs[0].key = "other";
    expect(dailyDashboardMatchesQuery(dailyDashboardSuccessSchema.parse(wrongInput), query, ["M001"])).toBe(false);
    const wrongScope = groupedResponse(); wrongScope.data.acquisitionGroups.channel.day.scopeStatuses = [{ metricId: "M003", sourceStatus: "FAILED", businessDate: "2026-09-04" }];
    expect(dailyDashboardMatchesQuery(dailyDashboardSuccessSchema.parse(wrongScope), query, ["M001"])).toBe(false);
    const badSummary = groupedResponse(); badSummary.data.acquisitionGroups.channel.groups[0].series[5].summary = structuredClone(badSummary.data.acquisitionGroups.channel.groups[0].series[0].summary);
    expect(dailyDashboardSuccessSchema.safeParse(badSummary).success).toBe(false);
  });
  test("1000分组上限与总输出点数上限均拒收", () => {
    const excessive = acquisitionGroups(); excessive.downloadPlatform.groups = Array.from({ length: 1001 }, (_, i) => ({ ...structuredClone(excessive.downloadPlatform.groups[0]), key: `group-${i}` }));
    expect(dailyAcquisitionGroupsSchema.safeParse(excessive).success).toBe(false);
    const large = acquisitionGroups(); large.channel.groups = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(large.channel.groups[0]), key: `group-${i}` }));
    for (const group of large.channel.groups) for (const item of group.series) item.points = Array.from({ length: 200 }, () => structuredClone(item.points[0]));
    expect(dailyAcquisitionGroupsSchema.safeParse(large).success).toBe(false);
  });
});
