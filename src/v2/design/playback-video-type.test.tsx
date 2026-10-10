import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardV2Success, DailyPlaybackGroupSeries } from "../../../contracts/daily-dashboard";
import { dailyDashboardSuccessSchema } from "../../../contracts/daily-dashboard";
import { LiveDashboardContext, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { playbackDiagnosisComparisonIssue, playbackDiagnosisMetricModel, playbackDiagnosisNotice, playbackDiagnosisReading, playbackDiagnosisRows, playbackDiagnosisSheet, playbackDiagnosisSupported } from "./playback-diagnosis-model";
import { playbackDiagnosisBoardSheets, playbackGroupSeriesId, playbackVideoTypeSheet } from "./live-playback-groups";
import { buildPreviewWorkbook } from "./preview-workbook";

function groupedSeries(id: string, value: number, date: string): DailyPlaybackGroupSeries {
  const inputs = id === "M036" ? [{ key: "effective", name: "有效观影次数", unit: "次" }, { key: "started", name: "起播次数", unit: "次" }] : [{ key: "count", name: id === "M034" ? "有效观影次数" : "起播次数", unit: "次" }];
  const point = { state: "available" as const, value, sourceStatus: "READY" as const, ruleVersion: "playback/v1", inputs: inputs.map((input, index) => ({ key: input.key, value: id === "M036" ? index ? 4 : 3 : value })) };
  return { metric: { id, name: id === "M036" ? "有效观影率" : id === "M034" ? "有效观影次数" : "起播次数", referenceMetricId: id, authorityVersion: "fixture",
    unit: id === "M036" ? "%" : "次", definition: "已确认定义", formula: id === "M036" ? "有效观影次数 ÷ 起播次数" : null, sourceNote: "独立真实视频类型分组", inputs },
    points: [{ ...structuredClone(point), date }], summary: structuredClone(point) };
}
function reading(date = "2020-01-01", keys = ["RAW-X", "raw-x", "special/a.b<类型>"]): LiveDashboardReading {
  const query = { boardId: "5.12", pid: "PH", dateRange: [date, date] as [string, string] };
  const overall = groupedSeries("M097", 999, date);
  const result: DailyDashboardV2Success = { success: true, data: { schemaVersion: "day-dashboard/v2", query, queryId: date, fetchedAt: "2026-10-10T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"], series: [],
    playbackGroups: { videoType: { dimension: "videoType", completeness: "unknown", day: { state: "returned", scopeStatuses: [], generatedAt: "2026-10-10T00:00:00Z", watermark: null },
      groups: keys.map((key, index) => ({ key, label: key, series: [groupedSeries("M034", 3, date), groupedSeries("M036", .75, date), groupedSeries("M097", 4 + index, date)] })) } } } };
  result.data.series = [{ metric: overall.metric, points: overall.points.map(({ ruleVersion: _, ...point }) => point), periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: query.dateRange, dayCount: 1, state: "unsupported", values: [], reason: "单日" } }];
  return { query, metricIds: ["M036", "M097"], state: { status: "success", data: result, refreshing: false, refreshError: null }, platformName: "PH", canExport: true, retry() {},
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}
function data(live: LiveDashboardReading) {
  if (live.state.status !== "success" || live.state.data.data.schemaVersion !== "day-dashboard/v2") throw new Error("fixture");
  return live.state.data.data;
}
const group = (live: LiveDashboardReading) => data(live).playbackGroups!.videoType;

test("视频类型只读实际键及既有M097/M036，不推算总体、不新增selector", () => {
  const live = reading();
  dailyDashboardSuccessSchema.parse(live.state.status === "success" && live.state.data);
  group(live).groups[0].label = "不能猜测的类型名称";
  expect(playbackDiagnosisRows(live, "M036", "视频类型").map(row => [row.key, row.name, row.value, row.calculation?.numerator.value, row.calculation?.denominator.value])).toEqual([
    ["RAW-X", "RAW-X", .75, 3, 4], ["raw-x", "raw-x", .75, 3, 4], ["special/a.b<类型>", "special/a.b<类型>", .75, 3, 4]
  ]);
  expect(playbackDiagnosisRows(live, "M097", "视频类型").map(row => row.value)).toEqual([4, 5, 6]);
  for (const id of ["M034", "M030", "M031", "M083"]) expect(playbackDiagnosisSupported(id, "视频类型")).toBe(false);
  expect(playbackDiagnosisRows(live, "M036", "视频ID")).toEqual([]);
  expect(data(live).series[0].points[0].value).toBe(999);
});

test("两期按稳定键匹配、缺组独立缺失，数据不随名称/位置对齐", () => {
  const live = reading(), previous = reading("2019-12-31", ["raw-x", "baseline-only"]);
  group(previous).groups[0].series[1].points[0].value = .25;
  live.comparison = { label: "上一等长周期", query: previous.query, state: previous.state };
  const rows = playbackDiagnosisRows(live, "M036", "视频类型");
  expect(rows.map(row => [row.key, row.value, row.baseline])).toEqual([["RAW-X", .75, null], ["raw-x", .75, .25], ["special/a.b<类型>", .75, null], ["baseline-only", null, .75]]);
  expect(rows[0].baselineState).toBe("本期未返回该分组");
  const selected = playbackDiagnosisReading(live, rows[1].seriesId);
  expect(selected.metricIds).toEqual([playbackGroupSeriesId("M036", "raw-x")]);
  expect(selected.state.status === "success" && selected.state.data.data.series[0].points[0].value).toBe(.75);
  expect(selected.comparison?.state.status === "success" && selected.comparison.state.data?.data.series[0].points[0].value).toBe(.25);
  live.comparison.state = { status: "failure", kind: "error", code: "UNAVAILABLE", message: "隔离失败" };
  expect(playbackDiagnosisRows(live, "M036", "视频类型")[0]).toMatchObject({ value: .75, baseline: null, baselineState: "读取失败" });
  expect(playbackDiagnosisNotice(live, "M036", "视频类型")).toContain("对比期：读取失败");
});

test("旧响应、空、失败与scope状态有实际提示，无伪造类型或零", () => {
  const legacy = reading(); delete data(legacy).playbackGroups;
  expect(playbackDiagnosisRows(legacy, "M036", "视频类型")).toEqual([]);
  expect(playbackDiagnosisNotice(legacy, "M036", "视频类型")).toContain("待接入");
  for (const [state, label] of [["empty", "未返回分组记录"], ["source_failure", "来源读取失败"], ["invalid_response", "数据异常"]] as const) {
    const live = reading(); group(live).groups = []; group(live).day.state = state;
    expect(playbackDiagnosisRows(live, "M036", "视频类型")).toEqual([]);
    expect(playbackDiagnosisNotice(live, "M036", "视频类型")).toContain(label);
    expect(JSON.stringify(playbackDiagnosisBoardSheets(live))).toContain(label);
  }
  const processing = reading(); group(processing).groups = []; group(processing).day.scopeStatuses = [{ metricId: "M036", sourceStatus: "PROCESSING" }];
  expect(playbackDiagnosisNotice(processing, "M036", "视频类型")).toContain("计算中");
  expect(playbackDiagnosisNotice(processing, "M097", "视频类型")).toContain("未返回分组记录");
});

test("非READY清除值及输入，READY零和零分母保留，不改变相邻组", () => {
  for (const status of ["SOURCE_INCOMPLETE", "PROCESSING", "NOT_MATURE", "FAILED"] as const) {
    const live = reading(), selected = group(live).groups[0].series[1];
    selected.points[0].sourceStatus = status; selected.summary.sourceStatus = status;
    const rows = playbackDiagnosisRows(live, "M036", "视频类型");
    expect(rows[0].value).toBeNull(); expect(rows[0].calculation?.numerator.value).toBeNull(); expect(rows[0].calculation?.denominator.value).toBeNull();
    expect(rows[1].value).toBe(.75);
    const projected = playbackDiagnosisReading(live, rows[0].seriesId);
    expect(projected.state.status === "success" && projected.state.data.data.series[0].points[0].value).toBeNull();
    expect(playbackVideoTypeSheet(live, ["M036"], "RAW-X").rows.slice(3).every(row => row[5] === null)).toBe(true);
  }
  const zero = reading(), selected = group(zero).groups[0].series[1], point = selected.points[0];
  point.value = 0; point.inputs[0].value = 0;
  expect(playbackDiagnosisRows(zero, "M036", "视频类型")[0].value).toBe(0);
  point.state = "zero_denominator"; point.value = null; point.inputs[1].value = 0;
  expect(playbackDiagnosisRows(zero, "M036", "视频类型")[0]).toMatchObject({ value: null, state: "分母为0", calculation: { numerator: { value: 0 }, denominator: { value: 0 } } });
  point.sourceStatus = "PROCESSING";
  expect(playbackDiagnosisRows(zero, "M036", "视频类型")[0].calculation?.denominator.value).toBeNull();
});

test("范围切换、重复组/日和请求失败不读旧数值", () => {
  for (const wrong of [{ pid: "OTHER" }, { boardId: "5.9" }, { dateRange: ["2020-01-02", "2020-01-02"] as [string, string] }]) {
    const live = reading(); data(live).query = { ...live.query, ...wrong };
    expect(playbackDiagnosisRows(live, "M036", "视频类型")).toEqual([]);
    expect(playbackDiagnosisNotice(live, "M036", "视频类型")).toContain("范围不匹配");
  }
  const duplicate = reading(); group(duplicate).groups.push(structuredClone(group(duplicate).groups[0]));
  expect(playbackDiagnosisRows(duplicate, "M036", "视频类型")[0].value).toBeNull();
  const dates = reading(); group(dates).groups[0].series[1].points.push(structuredClone(group(dates).groups[0].series[1].points[0]));
  expect(playbackDiagnosisRows(dates, "M036", "视频类型")[0].value).toBeNull();
  const failed = reading(); group(failed).day.state = "source_failure";
  expect(playbackDiagnosisRows(failed, "M036", "视频类型")[0]).toMatchObject({ value: null, state: "来源读取失败" });
});

test("混版两期原值和趋势保留，差值/日基准比较fail-closed", () => {
  const live = reading(), previous = reading("2019-12-31", ["RAW-X"]);
  const point = group(previous).groups[0].series[1].points[0]; point.ruleVersion = "playback/old"; point.value = .25;
  live.comparison = { label: "上一等长周期", query: previous.query, state: previous.state };
  const row = playbackDiagnosisRows(live, "M036", "视频类型")[0];
  expect([row.value, row.baseline]).toEqual([.75, .25]);
  expect(playbackDiagnosisComparisonIssue(live, row)).toBe("规则版本不同，不比较差值");
  const selected = playbackDiagnosisReading(live, row.seriesId);
  const model = playbackDiagnosisMetricModel(selected, row.seriesId, { metric: { id: row.seriesId, name: "有效观影率", definitionLabel: "正式定义", aggregationLabel: "" }, result: { status: "no_values", contextLabel: "真实查询", retryable: false } })!;
  if (model.result.status !== "available") throw new Error("expected readable values");
  expect(model.result.value.raw).toBe(.75); expect(model.result.trend.comparison?.[0].value?.raw).toBe(.25);
  expect(model.result.comparison?.status).toBe("unavailable");
  expect(model.result.reading?.comparisons[0]).toMatchObject({ status: "unavailable", detail: "规则版本不同，不比较差值" });
  expect(model.result.trend.current[0].differenceDisplay).toBeNull(); expect(model.result.trend.comparison?.[0].differenceDisplay).toBeNull();
  expect(model.result.trend.current[0].comparisonUnavailableReason).toBe("规则版本不同，不比较差值");
  expect(JSON.stringify(playbackDiagnosisBoardSheets(live))).toContain("playback/old");
});

test("比较期独有类型保留比较趋势、详情记录和同组完整导出，当前期仍缺组", () => {
  const live = reading("2020-01-01", []), previous = reading("2019-12-31", ["baseline-only"]);
  group(live).day.state = "empty";
  live.comparison = { label: "上一期", query: previous.query, state: previous.state };
  const row = playbackDiagnosisRows(live, "M036", "视频类型")[0];
  expect(row).toMatchObject({ value: null, baseline: .75, state: "本期未返回分组记录" });
  expect(row.series?.points[0]).toMatchObject({ value: null, state: "no_record", inputs: [{ key: "effective", value: null }, { key: "started", value: null }] });
  expect(row.baselineSeries?.points[0].value).toBe(.75);
  const selected = playbackDiagnosisReading(live, row.seriesId);
  const model = playbackDiagnosisMetricModel(selected, row.seriesId, { metric: { id: row.seriesId, name: "有效观影率", definitionLabel: "正式定义", aggregationLabel: "" }, result: { status: "no_values", contextLabel: "真实", retryable: false } })!;
  expect(model.result.status).toBe("no_records");
  if (model.result.status === "available") throw new Error("no current record");
  expect(model.result.history?.trend.comparison?.[0].value?.raw).toBe(.75);
  const rows = playbackVideoTypeSheet(live, ["M036"], "baseline-only").rows.slice(3);
  expect(rows.find(row => row[0] === "当前期")?.[5]).toBeNull();
  expect(rows.find(row => row[0] === "对比期")?.slice(5, 10)).toEqual([.75, "原始比值", "有效观影次数：3 次；起播次数：4 次", "已返回", "playback/v1"]);
});

test("末日主值与服务端周期summary独立，完整导出包含两期日期/原始比值/输入/规则", () => {
  const live = reading(), previous = reading("2019-12-30", ["RAW-X"]);
  live.query = { ...live.query, dateRange: ["2019-12-31", "2020-01-01"] }; data(live).query = live.query;
  group(live).groups.forEach(group => group.series.forEach(series => { series.points.unshift({ ...structuredClone(series.points[0]), date: "2019-12-31", value: series.metric.id === "M036" ? .1 : 10 }); }));
  const selected = group(live).groups[0].series[1]; selected.summary.value = .42; selected.summary.inputs = [{ key: "effective", value: 42 }, { key: "started", value: 100 }]; selected.summary.ruleVersion = "summary-returned/v9";
  live.comparison = { label: "上一期", query: previous.query, state: previous.state };
  expect(playbackDiagnosisRows(live, "M036", "视频类型")[0].value).toBe(.75);
  const sheet = playbackDiagnosisSheet(live, "M036", "视频类型"), records = sheet.rows.slice(3);
  expect(records.find(row => row[4] === "2019-12-31 至 2020-01-01")?.slice(5, 10)).toEqual([.42, "原始比值", "有效观影次数：42 次；起播次数：100 次", "已返回", "summary-returned/v9"]);
  expect(records.some(row => row[0] === "对比期" && row[4] === "2019-12-30" && row[9] === "playback/v1")).toBe(true);
  selected.summary.state = "incomplete"; selected.summary.value = null; selected.summary.inputs.forEach(input => input.value = null); selected.summary.ruleVersion = null; delete selected.summary.sourceStatus;
  expect(playbackDiagnosisSheet(live, "M036", "视频类型").rows.find(row => row[4] === "2019-12-31 至 2020-01-01")?.slice(5, 10)).toEqual([null, "原始比值", "有效观影次数：— 次；起播次数：— 次", "区间结果不完整", null]);
  const full = playbackDiagnosisBoardSheets(live);
  expect(full).toHaveLength(1); expect(JSON.stringify(full)).toContain("起播次数"); expect(JSON.stringify(full)).toContain("有效观影率");
  expect(buildPreviewWorkbook(full).length).toBeGreaterThan(1000);
  expect(playbackDiagnosisBoardSheets({ ...live, query: { ...live.query, boardId: "5.9" } })).toEqual([]);
});

test("实际原组件保留控件/计算输入/详情及真实视频类型数值", async () => {
  await import("echarts/core");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://localhost/dashboards/public?board=5.12") } });
  try {
    const { ConnectedPlaybackDiagnosis } = await import("./ConnectedPlaybackDiagnosis");
    const { PreviewMetricCard } = await import("./PreviewMetricCard");
    const live = reading(), html = renderToStaticMarkup(<ConnectedPlaybackDiagnosis spec={{ title: "播放质量诊断", ids: ["M036", "M097"], groups: ["视频类型", "客户端平台"] }} live={live} pending={false} open={() => {}} />);
    expect(html).toContain("75.00%"); expect(html).toContain("播放质量诊断计算输入表"); expect(html).toContain("播放质量诊断排序"); expect(html).toContain("special/a.b&lt;类型&gt;"); expect(html).not.toContain("演示数据");
    const selected = playbackDiagnosisReading(live, playbackGroupSeriesId("M036", "RAW-X"));
    const model = playbackDiagnosisMetricModel(selected, selected.metricIds[0], { metric: { id: selected.metricIds[0], name: "有效观影率 · RAW-X", definitionLabel: "正式定义", aggregationLabel: "" }, result: { status: "no_values", contextLabel: "真实查询", retryable: false } })!;
    const { DataOriginProvider } = await import("../components/DataOrigin");
    const card = renderToStaticMarkup(<DataOriginProvider value="pending"><LiveDashboardContext.Provider value={null}><PreviewMetricCard model={model} open={() => {}} retry={() => {}} readingContext={<p>真实来源记录与计算输入</p>} exportAction={<button>导出</button>} /></LiveDashboardContext.Provider></DataOriginProvider>);
    expect(card).toContain("75.00"); expect(card).toContain("2020-01-01"); expect(card).toContain("真实后台结果，待验数"); expect(card).not.toContain("演示数据");
    let comparisonMarkup = "";
    const comparisonCard = PreviewMetricCard({ model, open: (_title, content) => { comparisonMarkup = renderToStaticMarkup(<>{content}</>); }, retry() {}, exportAction: <button>导出</button>,
      comparisonContext: <><p>较前一天 · 2019-12-31</p><p>较上周同日 · 2019-12-25</p><p>真实来源记录</p></> });
    comparisonCard.props.onOpenComparison(model);
    expect(comparisonMarkup).toContain("2019-12-31"); expect(comparisonMarkup).toContain("2019-12-25"); expect(comparisonMarkup).toContain("真实来源记录");
    delete data(live).playbackGroups;
    expect(renderToStaticMarkup(<ConnectedPlaybackDiagnosis spec={{ title: "播放质量诊断", ids: ["M036"], groups: ["视频类型"] }} live={live} pending={false} open={() => {}} />)).toContain("视频类型真实分组待接入");
  } finally { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); }
});
