import { expect, test } from "bun:test";
import type { DailyDashboardQuery, DailyDashboardSuccess, DailyDashboardV2Success } from "../../../contracts/daily-dashboard";
import type { LiveDashboardReading, LiveSeries } from "../features/dashboards/LiveDashboardContext";
import { connectedStructureModel } from "./connected-structure-model";

const query: DailyDashboardQuery = { boardId: "5.7", pid: "PH", dateRange: ["2020-01-01", "2020-01-03"] };
const priorQuery: DailyDashboardQuery = { ...query, dateRange: ["2019-12-29", "2019-12-31"] };

function series(id: string, dates: string[], values: (number | null)[], unit = "人"): LiveSeries {
  const ratio = unit === "%";
  return {
    metric: { id, name: id, unit, definition: "测试口径", authorityVersion: "test", referenceMetricId: id.split(".")[0],
      formula: ratio ? "观影人数 ÷ 活跃人数 × 100%" : null, sourceNote: null,
      inputs: ratio ? [{ key: "viewers", name: "观影人数", unit: "人" }, { key: "active", name: "活跃人数", unit: "人" }] : [{ key: "count", name: "人数", unit: "人" }] },
    points: dates.map((date, i) => ({ date, value: values[i], state: values[i] === null ? "no_value" : "available", sourceStatus: "READY",
      inputs: ratio ? [{ key: "viewers", value: values[i] === null ? null : values[i]! * 100 }, { key: "active", value: 100 }] : [{ key: "count", value: values[i] }] }))
  };
}
function payload(scope: DailyDashboardQuery, items: LiveSeries[]): DailyDashboardSuccess {
  return { success: true, data: { schemaVersion: "day-dashboard/v1", query: structuredClone(scope), queryId: "structure-test", fetchedAt: "2026-10-09T00:00:00Z",
    timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null,
    sourceApiIds: ["/api/admin/bi/v1/metrics"], series: items } };
}
function reading(items = [series("M008.nature", ["2020-01-01", "2020-01-02", "2020-01-03"], [2, 0, 4]), series("M008.internal", ["2020-01-01", "2020-01-02", "2020-01-03"], [3, 5, 7])]): LiveDashboardReading {
  return { query: structuredClone(query), metricIds: items.map(item => item.metric.id), platformName: "测试平台", canExport: true, retry() {},
    state: { status: "success", data: payload(query, items), refreshing: false, refreshError: null },
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}
function result(live: LiveDashboardReading) {
  if (live.state.status !== "success") throw new Error("Expected successful fixture");
  return live.state.data;
}
function compare(live: LiveDashboardReading, points = series("M008.nature", ["2019-12-31", "2019-12-29"], [30, 10])) {
  live.comparison = { label: "上一等长周期", query: structuredClone(priorQuery), state: { status: "success", data: payload(priorQuery, [points]), refreshing: false, refreshError: null } };
}

function withStatistics(live: LiveDashboardReading, kind: "period_sum" | "daily_average", values: number[]) {
  const original = result(live);
  const data: DailyDashboardV2Success = { ...original, data: { ...original.data, schemaVersion: "day-dashboard/v2", series: original.data.series.map((item, i) => ({
    ...item, periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: [...live.query.dateRange], dayCount: 3,
      state: "available", values: [{ kind, value: values[i] }], reason: null }
  })) } };
  live.state = { status: "success", data, refreshing: false, refreshError: null };
  return data;
}

test("获客累计和活跃观影日均读取同范围服务端统计，未返回不自行求和", () => {
  const live = reading();
  expect(connectedStructureModel(live, "M008", "acquisition").summaries.map(summary => summary.value)).toEqual([null, null]);
  const data = withStatistics(live, "period_sum", [6, 15]);
  let model = connectedStructureModel(live, "M008", "acquisition");
  expect(model.summaries.map(summary => [summary.value, summary.summaryLabel])).toEqual([[6, "所选范围累计"], [15, "所选范围累计"]]);
  data.data.series[0].periodStatistics.state = "incomplete";
  data.data.series[0].periodStatistics.values = [];
  data.data.series[0].periodStatistics.reason = "存在缺失日期";
  expect(connectedStructureModel(live, "M008", "acquisition").summaries.map(summary => summary.value)).toEqual([null, 15]);
  for (const id of ["M016", "M026"]) {
    const audience = reading([series(`${id}.android`, ["2020-01-01", "2020-01-02", "2020-01-03"], [1, 2, 4])]);
    withStatistics(audience, "daily_average", [7 / 3]);
    model = connectedStructureModel(audience, id, "platform");
    expect(model.summaries[0]).toMatchObject({ value: 7 / 3, summaryLabel: "所选范围日均" });
  }
});

test("已返回周期统计仍需全日READY与精确范围，不能用宽日期汇总替代子区间", () => {
  const live = reading(); const data = withStatistics(live, "period_sum", [6, 15]);
  data.data.series[0].points.splice(1, 1);
  data.data.series[1].points[0].sourceStatus = "PROCESSING";
  expect(connectedStructureModel(live, "M008", "acquisition").summaries.every(summary => summary.value === null)).toBe(true);
  const subset = reading(); withStatistics(subset, "period_sum", [6, 15]);
  subset.query.dateRange = ["2020-01-02", "2020-01-03"];
  const model = connectedStructureModel(subset, "M008", "acquisition");
  expect(model.points.map(point => point.values["M008.nature"])).toEqual([0, 4]);
  expect(model.summaries.every(summary => summary.value === null)).toBe(true);
  for (const malformed of ["dayCount", "duplicate", "range"] as const) {
    const live = reading(), result = withStatistics(live, "period_sum", [6, 15]);
    const statistics = result.data.series[0].periodStatistics;
    if (malformed === "dayCount") statistics.dayCount = 2;
    if (malformed === "duplicate") statistics.values.push({ kind: "period_sum", value: 60 });
    if (malformed === "range") statistics.dateRange = ["2020-01-02", "2020-01-03"];
    expect(connectedStructureModel(live, "M008", "acquisition").summaries[0].value).toBeNull();
  }
});

test("观影率区间沿用同群输入加权，输入顺序漂移仍按字段键匹配", () => {
  const item = series("M081.android", ["2020-01-01", "2020-01-02", "2020-01-03"], [.1, .5, .8], "%");
  item.points[1].inputs = [{ key: "active", value: 10 }, { key: "viewers", value: 5 }];
  const live = reading([item]);
  const model = connectedStructureModel(live, "M081", "platform");
  expect(model.summaries[0]).toMatchObject({ value: 95 / 210, summaryLabel: "所选范围按基数加权" });
  expect(model.points[1].basis?.["M081.android"]).toMatchObject({ numerator: { value: 5 }, denominator: { value: 10 } });
});

test("分组趋势按完整日期匹配乱序和缺日，对比不依赖第一条序列", () => {
  const live = reading([series("M008.nature", ["2020-01-03", "2020-01-01"], [4, 2]), series("M008.internal", ["2020-01-02"], [0])]);
  compare(live);
  const model = connectedStructureModel(live, "M008", "acquisition");
  expect(model.points.map(point => [point.date, point.values["M008.nature"], point.values["M008.internal"]])).toEqual([
    ["2020-01-01", 2, null], ["2020-01-02", null, 0], ["2020-01-03", 4, null]
  ]);
  expect(model.points.map(point => [point.comparison?.date, point.comparison?.values["M008.nature"]])).toEqual([
    ["2019-12-29", 10], ["2019-12-30", null], ["2019-12-31", 30]
  ]);
  expect(model.summaries.every(summary => summary.value === null)).toBe(true);
  expect(model.points[1].states?.["M008.nature"]).toContain("未返回");
});

test("缺日和重复日不产出完整周期结果，分组独立保留真实0", () => {
  const live = reading();
  result(live).data.series[0].points.splice(1, 1);
  result(live).data.series[1].points = [series("M008.internal", ["2020-01-01", "2020-01-02", "2020-01-03"], [0, 0, 0]).points[0],
    ...series("M008.internal", ["2020-01-02", "2020-01-03"], [0, 0]).points];
  const model = connectedStructureModel(live, "M008", "acquisition");
  expect(model.summaries[0].value).toBeNull();
  expect(model.points.map(point => point.values["M008.internal"])).toEqual([0, 0, 0]);
  result(live).data.series[1].points.push(structuredClone(result(live).data.series[1].points[0]));
  const duplicate = connectedStructureModel(live, "M008", "acquisition");
  expect(duplicate.points[0].values["M008.internal"]).toBeNull();
  expect(duplicate.summaries[1].value).toBeNull();
});

test("非READY及不可用状态的附带数值和输入不进入趋势或导出", () => {
  for (const sourceStatus of ["PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"] as const) {
    const live = reading();
    result(live).data.series[0].points[0].sourceStatus = sourceStatus;
    const model = connectedStructureModel(live, "M008", "acquisition");
    expect(model.points[0].values["M008.nature"]).toBeNull();
    expect(model.summaries[0].value).toBeNull();
    expect(model.workbook[1].rows[1][3]).toBeNull();
    expect(model.workbook[1].rows[1][4]).not.toContain("2");
  }
  const live = reading();
  result(live).data.series[0].points[0].state = "source_failure";
  expect(connectedStructureModel(live, "M008", "acquisition").points[0].values["M008.nature"]).toBeNull();
});

test("当前响应平台、看板和覆盖日期不一致时不读取结果", () => {
  for (const scope of [{ ...query, pid: "FBI" }, { ...query, boardId: "5.8" }, { ...query, dateRange: ["2020-01-02", "2020-01-03"] as [string, string] }]) {
    const live = reading(); result(live).data.query = scope;
    const model = connectedStructureModel(live, "M008", "acquisition");
    expect(model.hasCurrentResult).toBe(false);
    expect(model.points.every(point => Object.values(point.values).every(value => value === null))).toBe(true);
    expect(model.summaries.every(summary => summary.value === null)).toBe(true);
  }
});

test("对比查询自身及响应的旧范围与平台隔离，空序列可渲染完整比较日期", () => {
  for (const field of ["queryPid", "queryBoard", "responsePid", "responseBoard", "responseRange", "empty"] as const) {
    const live = reading(); compare(live);
    if (!live.comparison || live.comparison.state.status !== "success" || !live.comparison.state.data) throw new Error("Expected comparison");
    if (field === "queryPid") live.comparison.query.pid = "FBI";
    if (field === "queryBoard") live.comparison.query.boardId = "5.8";
    if (field === "responsePid") live.comparison.state.data.data.query.pid = "FBI";
    if (field === "responseBoard") live.comparison.state.data.data.query.boardId = "5.8";
    if (field === "responseRange") live.comparison.state.data.data.query.dateRange = ["2019-12-30", "2019-12-31"];
    if (field === "empty") live.comparison.state.data.data.series = [];
    const model = connectedStructureModel(live, "M008", "acquisition");
    expect(model.points.map(point => point.comparison?.date)).toEqual(["2019-12-29", "2019-12-30", "2019-12-31"]);
    expect(model.points.every(point => point.comparison?.values["M008.nature"] === null)).toBe(true);
    expect(model.points[0].values["M008.nature"]).toBe(2);
  }
});

test("导出保留完整请求日期和缺失行，顺序、真实0及比较日期与图一致", () => {
  const live = reading([series("M008.nature", ["2020-01-03", "2020-01-01"], [4, 0])]);
  compare(live);
  const rows = connectedStructureModel(live, "M008", "acquisition").workbook[1].rows.slice(1);
  expect(rows.filter(row => row[0] === "当前" && row[2] === "自然新增").map(row => [row[1], row[3]])).toEqual([
    ["2020-01-01", 0], ["2020-01-02", null], ["2020-01-03", 4]
  ]);
  expect(rows.filter(row => row[0] === "对比" && row[2] === "自然新增").map(row => [row[1], row[3]])).toEqual([
    ["2019-12-29", 10], ["2019-12-30", null], ["2019-12-31", 30]
  ]);
  expect(rows.every(row => row[6] === "PH")).toBe(true);
});

test("观影率零分母保留依据且不显示数值，非READY屏蔽依据值", () => {
  const ratio = series("M081.android", ["2020-01-01", "2020-01-02", "2020-01-03"], [.2, null, .6], "%");
  Object.assign(ratio.points[1], { state: "zero_denominator", inputs: [{ key: "viewers", value: 0 }, { key: "active", value: 0 }] });
  const live = reading([ratio]); live.query.boardId = "5.9"; result(live).data.query.boardId = "5.9";
  const model = connectedStructureModel(live, "M081", "platform");
  expect(model.points[1].values["M081.android"]).toBeNull();
  expect(model.points[1].states?.["M081.android"]).toContain("分母为0");
  expect(model.points[1].basis?.["M081.android"]).toMatchObject({ numerator: { value: 0 }, denominator: { value: 0 } });
  ratio.points[0].sourceStatus = "PROCESSING";
  const pending = connectedStructureModel(live, "M081", "platform");
  expect(pending.points[0].values["M081.android"]).toBeNull();
  expect(pending.points[0].basis?.["M081.android"]?.numerator.value ?? null).toBeNull();
  expect(pending.summaries[0].value).toBeNull();
});

test("刷新失败保留匹配快照且图表与导出标记旧结果，首读失败不补值", () => {
  const live = reading();
  if (live.state.status !== "success") throw new Error("Expected success");
  live.state.refreshError = { message: "offline", code: "NETWORK" };
  let model = connectedStructureModel(live, "M008", "acquisition");
  expect(model.points[0].values["M008.nature"]).toBe(2);
  expect(model.points[0].states?.["M008.nature"]).toContain("上次查询结果");
  expect(model.workbook[1].rows[1][5]).toContain("上次查询结果");
  live.state = { status: "failure", kind: "error", message: "offline", code: "NETWORK" };
  model = connectedStructureModel(live, "M008", "acquisition");
  expect(model.points.every(point => point.values["M008.nature"] === null)).toBe(true);
  expect(model.points[0].states?.["M008.nature"]).toContain("读取失败");
});
