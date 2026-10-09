import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { dailyDashboardSuccessSchema } from "../../../contracts/daily-dashboard";
import { LiveDashboardContext, liveMetricModel, type LiveDashboardReading, type LiveSeries } from "../features/dashboards/LiveDashboardContext";
import { playbackDiagnosisReading, playbackDiagnosisRows, playbackDiagnosisSeries, playbackDiagnosisSheet } from "./playback-diagnosis-model";

function series(id: string, numerator: number, denominator: number, date = "2020-01-01"): LiveSeries {
  return { metric: { id, name: id, referenceMetricId: id.split(".")[0], authorityVersion: "fixture", unit: id.startsWith("M036") ? "%" : "次", definition: "测试定义", formula: "有效观影次数 ÷ 起播次数", sourceNote: "隔离测试事实",
    inputs: [{ key: "effective", name: "有效观影次数", unit: "次" }, { key: "started", name: "起播次数", unit: "次" }] },
  points: [{ date, value: id.startsWith("M036") ? numerator / denominator : denominator, state: "available", sourceStatus: "READY", inputs: [{ key: "effective", value: numerator }, { key: "started", value: denominator }] }] };
}
function reading(): LiveDashboardReading {
  const data: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v1", query: { boardId: "5.12", pid: "PH", dateRange: ["2020-01-01", "2020-01-01"] }, queryId: "isolated", fetchedAt: "2026-10-09T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"],
    series: [series("M036", 7, 8), series("M036.android", 2, 2), series("M036.ios", 2, 2), series("M036.web", 3, 4), series("M097.android", 2, 2), series("M097.ios", 2, 2), series("M097.web", 3, 4)] } };
  dailyDashboardSuccessSchema.parse(data);
  return { query: data.data.query, metricIds: data.data.series.map(item => item.metric.id), state: { status: "success", data, refreshing: false, refreshError: null }, platformName: "PH", canExport: true, retry() {}, controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}
function payload(live: LiveDashboardReading) {
  if (live.state.status !== "success") throw new Error("expected success");
  return live.state.data;
}

test("PH播放平台有效率读取独立2/2、2/2、3/4，不使用演示或总体", () => {
  const live = reading(), rows = playbackDiagnosisRows(live, "M036", "客户端平台");
  expect(rows.map(row => [row.name, row.value, row.calculation?.numerator.value, row.calculation?.denominator.value])).toEqual([
    ["Android", 1, 2, 2], ["iOS", 1, 2, 2], ["Web", .75, 3, 4]
  ]);
  expect(playbackDiagnosisRows(live, "M097", "客户端平台").map(row => row.value)).toEqual([2, 2, 4]);
  expect(payload(live).data.series[0].points[0].value).toBe(.875);
  expect(playbackDiagnosisSheet(live, "M036", "客户端平台").rows[5].slice(5, 7)).toEqual([.75, "原始比值"]);
  expect(playbackDiagnosisSheet(live, "M097", "客户端平台").rows[5].slice(5, 7)).toEqual([4, "次"]);
});

test("缺失平台及尚未接入维度没有演示回退", () => {
  const live = reading();
  payload(live).data.series = payload(live).data.series.filter(item => item.metric.id !== "M036.ios");
  expect(playbackDiagnosisRows(live, "M036", "客户端平台")[1]).toMatchObject({ value: null, state: "待接入" });
  for (const group of ["版本", "视频类型", "触发方式", "播放模式", "渠道"]) {
    expect(playbackDiagnosisRows(live, "M036", group)).toEqual([]);
    expect(JSON.stringify(playbackDiagnosisSheet(live, "M036", group))).toContain("待接入");
  }
  for (const id of ["M083", "M031", "M030"]) expect(playbackDiagnosisRows(live, id, "客户端平台")).toEqual([]);
});

test("非READY、缺失、真实零及零分母独立呈现", () => {
  for (const sourceStatus of ["PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"] as const) {
    const live = reading();
    payload(live).data.series[1].points[0].sourceStatus = sourceStatus;
    const row = playbackDiagnosisRows(live, "M036", "客户端平台")[0];
    expect(row.value).toBeNull(); expect(row.calculation?.numerator.value).toBeNull(); expect(row.calculation?.denominator.value).toBeNull();
    expect(playbackDiagnosisSheet(live, "M036", "客户端平台").rows[3][5]).toBeNull();
    expect(payload(playbackDiagnosisReading(live, row.seriesId)).data.series[0].points[0].value).toBeNull();
  }
  const live = reading(), point = payload(live).data.series[1].points[0];
  point.value = 0; point.inputs[0].value = 0;
  expect(playbackDiagnosisRows(live, "M036", "客户端平台")[0]).toMatchObject({ value: 0, calculation: { numerator: { value: 0 }, denominator: { value: 2 } } });
  point.value = null; point.state = "zero_denominator"; point.inputs[1].value = 0;
  expect(playbackDiagnosisRows(live, "M036", "客户端平台")[0]).toMatchObject({ value: null, state: "分母为0", calculation: { numerator: { value: 0 }, denominator: { value: 0 } } });
});

test("错PID、日期或board的结果不能渲染为当前平台", () => {
  for (const wrong of [{ pid: "other" }, { boardId: "5.9" }, { dateRange: ["2020-01-02", "2020-01-02"] as [string, string] }]) {
    const live = reading();
    payload(live).data.query = { ...live.query, ...wrong };
    expect(playbackDiagnosisRows(live, "M036", "客户端平台").every(row => row.value === null && !row.calculation)).toBe(true);
  }
});

test("末日缺失不回退前日，加载失败与刷新旧结果分别保留状态", () => {
  const live = reading(), data = payload(live);
  const current = data.data.series[1].points[0];
  data.data.series[1].points.unshift({ ...current, date: "2019-12-31" });
  current.value = null; current.state = "no_record"; current.inputs.forEach(input => { input.value = null; });
  expect(playbackDiagnosisRows(live, "M036", "客户端平台")[0]).toMatchObject({ value: null, state: "当日未返回记录" });
  live.state = { status: "loading" };
  expect(playbackDiagnosisRows(live, "M036", "客户端平台")[0]).toMatchObject({ value: null, state: "读取中" });
  live.state = { status: "failure", kind: "error", code: "UNAVAILABLE", message: "隔离失败" };
  expect(playbackDiagnosisRows(live, "M036", "客户端平台")[0]).toMatchObject({ value: null, state: "读取失败" });
  live.state = { status: "success", data, refreshing: false, refreshError: { code: "UNAVAILABLE", message: "隔离失败" } };
  expect(playbackDiagnosisRows(live, "M036", "客户端平台")[1]).toMatchObject({ value: 1, freshness: "刷新失败，保留上次查询结果" });
});

test("主值、详情趋势、比较和导出保留对应日期，不平均多日比率", () => {
  const live = reading(), data = payload(live);
  live.query = { ...live.query, dateRange: ["2019-12-31", "2020-01-01"] }; data.data.query = live.query;
  data.data.series.forEach(item => item.points.unshift({ ...item.points[0], date: "2019-12-31", value: .5, inputs: [{ key: "effective", value: 1 }, { key: "started", value: 2 }] }));
  const previous = reading(), prev = payload(previous); previous.query = { ...previous.query, dateRange: ["2019-12-29", "2019-12-30"] }; prev.data.query = previous.query;
  prev.data.series.forEach(item => { item.points[0].date = "2019-12-30"; item.points[0].value = .25; });
  live.comparison = { label: "上一等长周期", query: previous.query, state: previous.state };
  const row = playbackDiagnosisRows(live, "M036", "客户端平台")[0];
  expect(row.value).toBe(1); expect(row.baseline).toBe(.25);
  expect(playbackDiagnosisSeries(live, row.seriesId)?.points.map(point => point.value)).toEqual([.5, 1]);
  const card = liveMetricModel({ metric: { id: row.seriesId, name: "有效率", definitionLabel: "正式定义", aggregationLabel: "" }, result: { status: "no_values", contextLabel: "真实", retryable: false } }, live);
  expect(card.result.status === "available" && card.result.value.raw).toBe(1);
  const sheet = playbackDiagnosisSheet(live, "M036", "客户端平台");
  expect(sheet.rows.slice(3).map(cells => cells[4])).toEqual(["2019-12-31", "2020-01-01", "2019-12-30", "2019-12-31", "2020-01-01", "2019-12-30", "2019-12-31", "2020-01-01", "2019-12-30"]);
  live.comparison.state = { status: "failure", kind: "error", message: "隔离错误", code: "INTERNAL_ERROR" };
  expect(playbackDiagnosisRows(live, "M036", "客户端平台")[0]).toMatchObject({ value: 1, baseline: null, baselineState: "读取失败" });
});

test("实际组件与详情卡渲染真实平台值，计数不生成比率分母表", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://localhost/dashboards/public?board=5.12") } });
  try {
  const { ConnectedPlaybackDiagnosis } = await import("./ConnectedPlaybackDiagnosis");
  const { PreviewMetricCard } = await import("./PreviewMetricCard");
  const live = reading();
  const render = (id: string) => renderToStaticMarkup(createElement(ConnectedPlaybackDiagnosis, {
    spec: { title: "播放质量诊断", ids: [id], groups: ["客户端平台", "版本"] }, live, pending: false, open() {}
  }));
  const ratio = render("M036"), count = render("M097");
  expect(ratio).toContain("播放质量诊断计算输入表");
  expect(ratio).toContain("75.00%");
  expect(ratio).not.toContain("演示数据");
  expect(count).not.toContain("播放质量诊断计算输入表");
  const selected = playbackDiagnosisReading(live, "M036.web");
  const card = renderToStaticMarkup(createElement(LiveDashboardContext.Provider, { value: selected }, createElement(PreviewMetricCard, {
    model: { metric: { id: "M036.web", name: "有效观影率 · Web", definitionLabel: "正式定义", aggregationLabel: "当前平台" }, result: { status: "no_values", contextLabel: "真实查询", retryable: false } },
    open() {}, retry() {}, exportAction: createElement("button", null, "导出")
  })));
  expect(card).toContain("75.00");
  expect(card).toContain("有效观影率 · Web");
  expect(card).not.toContain("当前为演示样例");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
