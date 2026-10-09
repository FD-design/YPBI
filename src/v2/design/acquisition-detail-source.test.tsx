import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { LiveDashboardContext, liveMetricModel, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { acquisitionDetailSource, acquisitionTypeWorkbook } from "./acquisition-detail-source";
import { acquisitionDailyCards, acquisitionRows, DEFAULT_ACQUISITION_FILTERS } from "./acquisition-preview-model";
import { DEFAULT_ACQUISITION_VIEW, type AcquisitionDetailKey } from "./acquisition-view-state";

// The browser router takes its initial location when the page module loads.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { pathname: "/dashboards/public", search: "?board=5.7", hash: "" } } });
const { AcquisitionDetailSection } = await import("./AcquisitionPreview");
if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
else Reflect.deleteProperty(globalThis, "window");

function reading(): LiveDashboardReading {
  const query = { boardId: "5.7", pid: "PH", dateRange: ["2020-01-01", "2020-01-01"] as [string, string] };
  const values = { M001: 4, M003: 3, M008: 3, M005: .75, M006: null, M007: null, "M008.nature": 2, "M008.internal": 1, "M008.android": 77 };
  const result: DailyDashboardSuccess = { success: true, data: {
    schemaVersion: "day-dashboard/v1", query, queryId: "acquisition-source-test", fetchedAt: "2026-10-09T00:00:00Z", timezone: "Asia/Shanghai",
    validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["/api/admin/bi/v1/metrics"],
    series: Object.entries(values).map(([id, value]) => ({
      metric: { id, name: id, unit: ["M005", "M006", "M007"].includes(id) ? "%" : id.startsWith("M008") ? "人" : "次", definition: "测试口径", authorityVersion: "test", formula: null, referenceMetricId: id.split(".")[0], sourceNote: null, inputs: [{ key: id, name: id, unit: "人" }] },
      points: [{ date: query.dateRange[0], state: value === null ? "no_value" : "available", sourceStatus: value === null ? "SOURCE_INCOMPLETE" : "READY", value, inputs: [{ key: id, value }] }]
    }))
  } };
  return { query, metricIds: Object.keys(values), state: { status: "success", data: result, refreshing: false, refreshError: null }, platformName: "PH", canExport: true, retry() {},
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}
function result(live: LiveDashboardReading) {
  if (live.state.status !== "success") throw Error("Expected result");
  return live.state.data;
}
function periodReading(dateRange: [string, string] = ["2020-01-01", "2020-01-02"]) {
  const live = reading(), original = result(live);
  live.query = { ...live.query, dateRange };
  live.state = { status: "success", refreshing: false, refreshError: null, data: { success: true, data: {
    ...original.data, schemaVersion: "day-dashboard/v2", query: live.query,
    series: original.data.series.map(series => ({
      ...series,
      points: dateRange.map((date, index) => ({ ...series.points[0], date, value: series.points[0].value === null ? null : series.points[0].value + index })),
      periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange, dayCount: 2, state: "available",
        values: [{ kind: "period_sum", value: series.points[0].value === null ? 0 : series.points[0].value * 2 + 1 }], reason: null }
    }))
  } } };
  return live;
}
function periodSeries(live: LiveDashboardReading, id = "M008.nature") {
  const data = result(live).data;
  if (data.schemaVersion !== "day-dashboard/v2") throw Error("Expected period statistics");
  return data.series.find(series => series.metric.id === id)!;
}
function markup(dimension: AcquisitionDetailKey, live: LiveDashboardReading | null) {
  return renderToStaticMarkup(<LiveDashboardContext.Provider value={live}><AcquisitionDetailSection
    dimension={dimension} filters={DEFAULT_ACQUISITION_FILTERS} comparisonEnabled={false} mixed={false}
    open={() => {}} detail={DEFAULT_ACQUISITION_VIEW.detail.sections[dimension]} update={() => {}} onExport={() => {}} pending={false}
  /></LiveDashboardContext.Provider>);
}

test("真实渠道、下载目标与结算只显示BI分组待接入，完整结构和操作保留", () => {
  const live = reading();
  for (const dimension of ["channel", "target", "settlement"] as const) {
    const source = acquisitionDetailSource(dimension, DEFAULT_ACQUISITION_FILTERS, live);
    expect(source.origin).toBeNull();
    expect(source.rows).toEqual([]);
    expect(source.unavailableReason).toContain("BI 尚未接入");
    const html = markup(dimension, live);
    expect(html).toContain('data-data-origin="unavailable"');
    expect(html).toContain(source.unavailableReason!);
    expect(html).toContain("2020-01-01");
    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("导出");
    expect(html).not.toContain("合成演示");
    expect(html).not.toContain('data-data-origin="demo"');
    expect(html).not.toContain("推广渠道 A");
    expect(html).not.toContain("结算渠道 A");
    expect(html).not.toContain("Android");
  }
  const channel = markup("channel", live);
  for (const text of ["搜索来源渠道", "规模与转化", "首次体验", "注册留存", "付费价值", "完整明细", "排序落地页访问次数"]) expect(channel).toContain(text);
  expect(channel).not.toContain("排序新增用户数");
});

test("显式预览继续显示原分组演示与完整导出入口", () => {
  for (const dimension of ["channel", "target", "type", "settlement"] as const) {
    expect(acquisitionDetailSource(dimension, DEFAULT_ACQUISITION_FILTERS, null)).toEqual({ origin: "demo", rows: acquisitionRows(dimension, DEFAULT_ACQUISITION_FILTERS) });
    const html = markup(dimension, null);
    expect(html).toContain('data-data-origin="demo"');
    expect(html).toContain("演示数据");
    expect(html).toContain("导出");
    expect(html).not.toContain("BI 尚未接入");
  }
  expect(markup("target", null)).toContain("Android");
  expect(markup("channel", null)).toContain("推广渠道 A");
});

test("总体4／3／3、75%及两个来源限制保持，获客类型2／1直接来自各自投影", () => {
  const live = reading(), original = structuredClone(result(live));
  const source = acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live);
  expect(source.origin).toBe("pending");
  expect(source.rows.map(row => [row.name, row.values.M008])).toEqual([["自然新增", 2], ["内部导量", 1]]);
  const cards = acquisitionDailyCards(false);
  for (const [id, value] of [["M001", 4], ["M003", 3], ["M008", 3], ["M005", .75]] as const) {
    const model = liveMetricModel(cards.find(card => card.model.metric.id === id)!.model, live);
    expect(model.result.status === "available" && model.result.value.raw).toBe(value);
  }
  for (const id of ["M006", "M007"]) {
    const model = liveMetricModel(cards.find(card => card.model.metric.id === id)!.model, live);
    expect(model.result.status).not.toBe("available");
    expect(result(live).data.series.find(series => series.metric.id === id)!.points[0]).toMatchObject({ value: null, sourceStatus: "SOURCE_INCOMPLETE" });
  }
  expect(acquisitionTypeWorkbook(live)[1].rows.slice(1).map(row => row[4])).toEqual([2, 1]);
  expect(result(live)).toEqual(original);
});

test("真实0保留，空或缺失类型不回退总体、客户端或演示", () => {
  const live = reading();
  const natural = result(live).data.series.find(series => series.metric.id === "M008.nature")!;
  natural.points[0].value = 0;
  result(live).data.series = result(live).data.series.filter(series => series.metric.id !== "M008.internal");
  expect(acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows.map(row => row.values.M008)).toEqual([0, null]);
  expect(acquisitionTypeWorkbook(live)[1].rows.slice(1).map(row => row[4])).toEqual([0, null]);
  natural.points = [];
  expect(acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows.every(row => row.values.M008 === null)).toBe(true);
  live.state = { status: "loading" };
  expect(acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows.every(row => row.state === "读取中")).toBe(true);
  live.state = { status: "failure", kind: "error", code: "UPSTREAM_ERROR", message: "读取失败" };
  expect(acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows.every(row => row.state === "读取失败")).toBe(true);
  for (const dimension of ["channel", "target", "settlement"] as const) expect(acquisitionDetailSource(dimension, DEFAULT_ACQUISITION_FILTERS, live).rows).toEqual([]);
});

test("非READY即使携带数值也不在类型明细及导出中显示，其他类型独立保留", () => {
  for (const sourceStatus of ["PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"] as const) {
    const live = reading();
    result(live).data.series.find(series => series.metric.id === "M008.nature")!.points[0].sourceStatus = sourceStatus;
    const rows = acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows;
    expect(rows.map(row => row.values.M008)).toEqual([null, 1]);
    expect(acquisitionTypeWorkbook(live)[1].rows.slice(1).map(row => row[4])).toEqual([null, 1]);
    expect(rows[0].state).not.toBe("待验数");
  }
});

test("当前与对比独立匹配平台、看板和日期，周期缺日不求部分和", () => {
  for (const query of [{ boardId: "5.8" }, { pid: "other" }, { dateRange: ["2020-01-02", "2020-01-02"] as [string, string] }]) {
    const live = reading();
    live.query = { ...live.query, ...query };
    expect(acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows.every(row => row.values.M008 === null)).toBe(true);
    expect(acquisitionTypeWorkbook(live)[1].rows.slice(1).every(row => row[4] === null)).toBe(true);
  }
  const live = reading();
  live.query = { ...live.query, dateRange: ["2020-01-01", "2020-01-02"] };
  result(live).data.query = live.query;
  expect(acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows.every(row => row.values.M008 === null)).toBe(true);
  live.query = { ...live.query, dateRange: ["2020-01-01", "2020-01-01"] };
  live.comparison = { label: "对比", query: { ...live.query, dateRange: ["2019-12-31", "2019-12-31"] }, state: live.state };
  const rows = acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows;
  expect(rows.map(row => row.values.M008)).toEqual([2, 1]);
  expect(rows.map(row => row.baseline.M008)).toEqual([null, null]);
  expect(acquisitionTypeWorkbook(live)[1].rows.slice(3).every(row => row[4] === null)).toBe(true);
  const differentPlatform = structuredClone(result(live));
  differentPlatform.data.query = { ...live.query, pid: "other" };
  live.comparison = { label: "对比", query: differentPlatform.data.query, state: { status: "success", data: differentPlatform, refreshing: false, refreshError: null } };
  expect(acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows.every(row => row.baseline.M008 === null)).toBe(true);
});

test("类型多日汇总读取同快照服务端合计，当前与对比页面及导出一致", () => {
  const live = periodReading(), baseline = periodReading(["2019-12-30", "2019-12-31"]);
  live.comparison = { label: "对比", query: baseline.query, state: baseline.state };
  const rows = acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows;
  expect(rows.map(row => [row.values.M008, row.baseline.M008])).toEqual([[5, 5], [3, 3]]);
  const sheets = acquisitionTypeWorkbook(live);
  expect(sheets[1].rows.slice(1).map(row => row[4])).toEqual([2, 3, 1, 2, 2, 3, 1, 2]);
  expect(sheets[2].rows.slice(1).map(row => [row[0], row[1], row[2], row[4], row[5]])).toEqual([
    ["当前", "2020-01-01", "2020-01-02", "自然新增", 5], ["当前", "2020-01-01", "2020-01-02", "内部导量", 3],
    ["对比", "2019-12-30", "2019-12-31", "自然新增", 5], ["对比", "2019-12-30", "2019-12-31", "内部导量", 3]
  ]);
  periodSeries(live).points.forEach(point => { point.value = 0; });
  periodSeries(live).periodStatistics.values = [{ kind: "period_sum", value: 0 }];
  expect(acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows[0].values.M008).toBe(0);
  expect(acquisitionTypeWorkbook(live)[2].rows[1][5]).toBe(0);
});

test("多日没有可用服务端合计时不把完整逐日点在浏览器相加", () => {
  for (const mode of ["old-response", "unsupported", "incomplete", "average-only"] as const) {
    const live = periodReading();
    const series = periodSeries(live);
    if (mode === "old-response") {
      const original = result(live);
      live.state = { status: "success", refreshing: false, refreshError: null, data: { success: true, data: {
        ...original.data, schemaVersion: "day-dashboard/v1", series: original.data.series.map(item => ({ metric: item.metric, points: item.points }))
      } } };
    } else if (mode === "average-only") series.periodStatistics.values = [{ kind: "daily_average", value: 2.5 }];
    else series.periodStatistics = { ...series.periodStatistics, state: mode, values: [], reason: "周期统计不可用" };
    const rows = acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows;
    expect(rows[0]).toMatchObject({ values: { M008: null }, state: "区间合计未返回" });
    expect(rows[1].values.M008).toBe(mode === "old-response" ? null : 3);
    expect(acquisitionTypeWorkbook(live)[1].rows.slice(1, 3).map(row => row[4])).toEqual([2, 3]);
    expect(acquisitionTypeWorkbook(live)[2].rows[1][5]).toBeNull();
  }
});

test("服务端合计不能覆盖缺日、重复日期和非READY日值", () => {
  for (const mode of ["missing", "duplicate", "PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"] as const) {
    const live = periodReading(), series = periodSeries(live);
    if (mode === "missing") series.points.pop();
    else if (mode === "duplicate") series.points.push({ ...series.points[1] });
    else series.points[1].sourceStatus = mode;
    const rows = acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows;
    expect(rows.map(row => row.values.M008)).toEqual([null, 3]);
    expect(rows[0].state).not.toBe("待验数");
    const sheets = acquisitionTypeWorkbook(live);
    expect(sheets[1].rows.slice(1, 3).map(row => row[4])).toEqual([2, null]);
    expect(sheets[2].rows.slice(1).map(row => row[5])).toEqual([null, 3]);
  }
});

test("周期合计严格核对查询范围、统计范围、天数及唯一指标", () => {
  for (const mode of ["pid", "board", "query-range", "statistics-range", "day-count", "duplicate-series"] as const) {
    const live = periodReading(), data = result(live).data, series = periodSeries(live);
    if (mode === "pid") data.query = { ...data.query, pid: "other" };
    if (mode === "board") data.query = { ...data.query, boardId: "5.8" };
    if (mode === "query-range") data.query = { ...data.query, dateRange: ["2019-12-31", "2020-01-02"] };
    if (mode === "statistics-range") series.periodStatistics.dateRange = ["2019-12-31", "2020-01-02"];
    if (mode === "day-count") series.periodStatistics.dayCount = 3;
    if (mode === "duplicate-series") data.series.push(structuredClone(series));
    expect(acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows[0].values.M008).toBeNull();
    expect(acquisitionTypeWorkbook(live)[2].rows[1][5]).toBeNull();
  }
});

test("对比期无周期统计不影响当前合计，失败刷新沿用同快照及状态", () => {
  const live = periodReading(), baseline = periodReading(["2019-12-30", "2019-12-31"]);
  periodSeries(baseline).periodStatistics = { ...periodSeries(baseline).periodStatistics, state: "incomplete", values: [], reason: "数据不完整" };
  live.comparison = { label: "对比", query: baseline.query, state: baseline.state };
  if (live.state.status !== "success") throw Error("Expected success");
  live.state.refreshError = { code: "UPSTREAM_TIMEOUT", message: "超时" };
  const rows = acquisitionDetailSource("type", DEFAULT_ACQUISITION_FILTERS, live).rows;
  expect(rows.map(row => [row.values.M008, row.baseline.M008])).toEqual([[5, null], [3, 3]]);
  expect(acquisitionTypeWorkbook(live)[2].rows[1][8]).toBe("刷新失败，保留上次查询结果");
  expect(acquisitionTypeWorkbook(live)[2].rows[3][5]).toBeNull();
});
