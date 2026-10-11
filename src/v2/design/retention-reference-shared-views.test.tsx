import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { LiveSeriesDetails, LiveSeriesExport } from "../features/dashboards/ConnectedMetricCard";
import { liveCalculation, liveDailyPoint, liveMetricModel, type LiveDashboardReading, type LiveSeries } from "../features/dashboards/LiveDashboardContext";
import { DIAGNOSTIC_INPUTS_LABEL, RETENTION_REFERENCE_LABEL } from "../features/dashboards/diagnostic-inputs";
import type { ConnectedCategorySource } from "./ConnectedCategoryDimension";
import { connectedDimensionRows, connectedDimensionSheet } from "./connected-dimension-model";
import { connectedTopicExportSheets } from "./connected-topic-export";

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://localhost/dashboards/public?board=5.8") } });
const { connectedBoardMetricSheet } = await import("./ConnectedBoard");
const { ConnectedCategoryDimension } = await import("./ConnectedCategoryDimension");
if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else Reflect.deleteProperty(globalThis, "window");

const date = "2020-01-01";
function fixture(id = "M020.android", points?: LiveSeries["points"]): { series: LiveSeries; result: DailyDashboardSuccess; live: LiveDashboardReading } {
  const series: LiveSeries = {
    metric: { id, referenceMetricId: id.split(".")[0], name: id + "注册用户留存率", unit: "%", definition: "按注册日核对留存", authorityVersion: "test",
      formula: "留存人数 ÷ 注册人数 × 100%", sourceNote: "测试查询", inputs: [{ key: "retained", name: "留存人数", unit: "人" }, { key: "registered", name: "注册人数", unit: "人" }] },
    points: points ?? [{ date, state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: [{ key: "retained", value: 1 }, { key: "registered", value: 2 }] }]
  };
  const result: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v1", query: { boardId: "5.8", pid: "PH", dateRange: [series.points[0].date, series.points.at(-1)!.date] },
    queryId: "reference-fixture", fetchedAt: "2026-10-12T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["test"], series: [series] } };
  const live: LiveDashboardReading = { query: result.data.query, metricIds: [id], state: { status: "success", data: result, refreshing: false, refreshError: null }, platformName: "测试平台", retry() {}, canExport: true,
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
  return { series, result, live };
}
const original = (id: string) => ({ metric: { id, name: "注册用户留存率", definitionLabel: "留存人数 ÷ 注册人数", aggregationLabel: "" }, result: { status: "no_values" as const, contextLabel: date, retryable: false } });
const groups = (id: string) => [{ key: "group", name: "注册分组", seriesId: id }];

async function metricCsv(series: LiveSeries, result: DailyDashboardSuccess, comparison?: DailyDashboardSuccess) {
  let blob: Blob | undefined;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const anchor = { href: "", download: "", click() {}, remove() {} };
  const url = spyOn(URL, "createObjectURL").mockImplementation(value => { blob = value as Blob; return "blob:test"; });
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => anchor, querySelector: () => null, body: { appendChild() {} } } });
  try {
    const element = LiveSeriesExport({ series, result, comparison });
    (element.props.onClick as () => void)();
    return (await blob!.text()).replace(/^\uFEFF/, "").split("\r\n").map(row => row.split(",").map(value => value.slice(1, -1)));
  } finally {
    url.mockRestore(); timer.mockRestore();
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else Reflect.deleteProperty(globalThis, "document");
  }
}

describe("四个D1分组的共享参考展示", () => {
  for (const scope of ["android", "ios", "natural", "internal"] as const) {
    test(`${scope}详情、整板与专题导出保留正式空值和独立参考值`, async () => {
      const { series, result, live } = fixture(`M020.${scope}`), point = series.points[0], before = JSON.stringify(series);
      expect(liveCalculation(series, point)).toMatchObject({ numerator: { value: 1 }, denominator: { value: 2 }, result: `50.00 % · ${RETENTION_REFERENCE_LABEL}` });
      expect(liveCalculation(series, point)?.scope).toContain(RETENTION_REFERENCE_LABEL);
      expect(liveMetricModel(original(series.metric.id), live).result).toMatchObject({ status: "no_values" });
      expect(liveDailyPoint(live, series.metric.id, date)).toMatchObject({ value: null, display: "—", state: "no_value" });
      const html = renderToStaticMarkup(<LiveSeriesDetails series={series} result={result} />);
      expect(html).toContain("参考比率（%）"); expect(html).toContain("参考说明");
      expect(html).toContain(`<td>1</td><td>2</td><td>—</td><td>${DIAGNOSTIC_INPUTS_LABEL}</td><td>50.00%</td><td>${RETENTION_REFERENCE_LABEL}</td>`);
      const board = connectedBoardMetricSheet(series, result, "当前期").rows;
      expect(board[0].slice(-2)).toEqual(["参考比率（%）", "参考说明"]);
      expect(board[1].slice(1, 5)).toEqual([null, 1, 2, DIAGNOSTIC_INPUTS_LABEL]);
      expect(board[1].slice(-2)).toEqual([50, RETENTION_REFERENCE_LABEL]);
      const topic = connectedTopicExportSheets(live, live, scope).find(sheet => sheet.name === "当前注册留存")!.rows;
      expect(topic[1][5]).toBeNull(); expect(topic[1].slice(-2)).toEqual([50, RETENTION_REFERENCE_LABEL]);
      const csv = await metricCsv(series, result);
      expect(csv[0].slice(-2)).toEqual(["参考比率（%）", "参考说明"]);
      expect(csv[1].slice(3, 7)).toEqual(["1", "2", "", DIAGNOSTIC_INPUTS_LABEL]);
      expect(csv[1].slice(-2)).toEqual(["50", RETENTION_REFERENCE_LABEL]);
      expect(JSON.stringify(series)).toBe(before);
    });
  }

  test("维度当前期与对比期参考只用于标签和详情，不产生排序值与差值", () => {
    const { live, series } = fixture(), previous = fixture();
    previous.series.points[0].inputs[0].value = 2;
    live.comparison = { label: "对比期", query: previous.live.query, state: previous.live.state };
    const rows = connectedDimensionRows(live, groups(series.metric.id));
    expect(rows[0]).toMatchObject({ value: null, baseline: null, reference: { value: .5, label: RETENTION_REFERENCE_LABEL }, baselineReference: { value: 1, label: RETENTION_REFERENCE_LABEL } });
    expect(rows[0].calculation?.result).toBe(`50.00 % · ${RETENTION_REFERENCE_LABEL}`);
    const sheet = connectedDimensionSheet(live, "M020", "注册来源", "D1分组", rows, true).rows;
    expect(sheet[2].slice(-2)).toEqual(["参考比率（%）", "参考说明"]);
    expect(sheet.slice(3).map(row => [row[5], ...row.slice(-2)])).toEqual([[null, 50, RETENTION_REFERENCE_LABEL], [null, 100, RETENTION_REFERENCE_LABEL]]);
    const source: ConnectedCategorySource = { rows: () => rows, supported: () => true, sheet: () => ({ name: "分组", rows: sheet }), unit: () => "%", guidanceKey: "test", inlineInputs: true };
    const html = renderToStaticMarkup(<ConnectedCategoryDimension spec={{ title: "D1分组", ids: ["M020"], groups: ["注册来源"] }} live={live} pending={false} open={() => {}} source={source} />);
    expect(html).toContain(`— · 50.00% · ${RETENTION_REFERENCE_LABEL}`);
    expect(rows[0].value).toBeNull(); expect(rows[0].baseline).toBeNull();
  });

  test("完整结果与来源不完整逐日并存时，正式汇总和趋势只读取完整结果", async () => {
    const { series, live, result } = fixture("M020.android", [
      { date, state: "available", sourceStatus: "READY", value: .25, inputs: [{ key: "retained", value: 1 }, { key: "registered", value: 4 }] },
      { date: "2020-01-02", state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: [{ key: "retained", value: 1 }, { key: "registered", value: 2 }] }
    ]);
    const model = liveMetricModel(original(series.metric.id), live);
    expect(model.result.status).toBe("available");
    if (model.result.status !== "available") throw new Error("完整批次应可读");
    expect(model.result.value.raw).toBe(.25);
    expect(model.result.trend.current.map(point => point.value?.raw ?? null)).toEqual([.25, null]);
    expect(model.result.trend.current[1].differenceDisplay).toBeNull();
    expect(model.result.trend.current[1].calculation?.result).toBe(DIAGNOSTIC_INPUTS_LABEL);
    const board = connectedBoardMetricSheet(series, result, "当前期").rows;
    expect(board.slice(1).map(row => [row[1], ...row.slice(-2)])).toEqual([[.25, null, null], [null, 50, RETENTION_REFERENCE_LABEL]]);
    const csv = await metricCsv(series, result);
    expect(csv.slice(1).map(row => [row[5], ...row.slice(-2)])).toEqual([["0.25", "", ""], ["", "50", RETENTION_REFERENCE_LABEL]]);
  });

  test("参考列不扩展至总体、D3/D7/D30和其他比例诊断", () => {
    for (const id of ["M020", "M021.android", "M022.ios", "M023.natural", "M061"]) {
      const { series, live, result } = fixture(id);
      expect(liveCalculation(series, series.points[0])?.result).toBe(DIAGNOSTIC_INPUTS_LABEL);
      const rows = connectedDimensionRows(live, groups(id));
      expect(rows[0].reference).toBeNull(); expect(rows[0].value).toBeNull();
      expect(connectedBoardMetricSheet(series, result, "当前期").rows[0]).not.toContain("参考比率（%）");
      expect(connectedDimensionSheet(live, id, "分组", "比例", rows, true).rows[2]).not.toContain("参考比率（%）");
      expect(renderToStaticMarkup(<LiveSeriesDetails series={series} result={result} />)).not.toContain(RETENTION_REFERENCE_LABEL);
    }
  });

  test("零分母与其他来源状态不展示参考，合法零分子保留0%参考", () => {
    const { series, result } = fixture();
    series.points[0].inputs = [{ key: "retained", value: 0 }, { key: "registered", value: 0 }];
    expect(liveCalculation(series, series.points[0])?.result).toBe(DIAGNOSTIC_INPUTS_LABEL);
    expect(connectedBoardMetricSheet(series, result, "当前期").rows[0]).not.toContain("参考比率（%）");
    series.points[0].inputs[1].value = 2;
    expect(liveCalculation(series, series.points[0])?.result).toBe(`0.00 % · ${RETENTION_REFERENCE_LABEL}`);
    for (const sourceStatus of ["PROCESSING", "NOT_MATURE", "FAILED"] as const) {
      series.points[0].sourceStatus = sourceStatus;
      expect(liveCalculation(series, series.points[0])?.result).not.toContain(RETENTION_REFERENCE_LABEL);
      expect(connectedBoardMetricSheet(series, result, "当前期").rows[0]).not.toContain("参考比率（%）");
      expect(renderToStaticMarkup(<LiveSeriesDetails series={series} result={result} />)).not.toContain(RETENTION_REFERENCE_LABEL);
    }
  });
});
