import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";
import { LiveSeriesDetails, LiveSeriesExport } from "./ConnectedMetricCard";
import { liveDailyPoint, liveDailyReferenceRows, liveMetricModel, livePointStateLabel, type LiveDashboardReading, type LiveSeries } from "./LiveDashboardContext";
import type { DashboardMetricCardModel } from "./dashboard-metric-card-model";
import { liveObservation } from "../../design/live-reading-projection";
import { operatingLiveCalculationRows, operatingLiveColumns, operatingLiveExportRows, operatingLiveRows } from "../../design/operating-live-model";
import { operatingValueLabel } from "../../design/operating-detail-snapshot";
import { connectedTopicExportSheets } from "../../design/connected-topic-export";
import { buildPreviewWorkbook } from "../../design/preview-workbook";

const date = "2026-09-08";
function fixture() {
  const series: LiveSeries = {
    metric: { id: "M016", referenceMetricId: "M016", name: "日活跃用户数", unit: "人", definition: "同日独立结果", authorityVersion: "test", formula: null, sourceNote: null, inputs: [{ key: "active", name: "活跃人数", unit: "人" }] },
    points: [
      { date: "2026-09-01", state: "available", value: 0, inputs: [{ key: "active", value: 0 }] },
      { date: "2026-09-07", state: "no_value", value: null, inputs: [{ key: "active", value: null }] },
      { date, state: "no_record", value: null, inputs: [{ key: "active", value: null }] }
    ]
  };
  const result: DailyDashboardSuccess = { success: true, data: {
    schemaVersion: "day-dashboard/v1", query: { boardId: "5.2", pid: "PH", dateRange: ["2026-09-01", date] }, queryId: "status-fixture",
    fetchedAt: "2026-09-09T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null,
    sourceApiIds: ["test"], series: [series]
  } };
  const live: LiveDashboardReading = {
    query: result.data.query, metricIds: ["M016"], state: { status: "success", data: result, refreshing: false, refreshError: null }, platformName: "测试平台",
    retry() {}, canExport: true, controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} }
  };
  return { series, result, live };
}

test("真实卡片、日引用与逐日详情同步区分未返回记录、字段空值和0", () => {
  const { live, series, result } = fixture();
  const original: DashboardMetricCardModel = { metric: { id: "M016", name: "日活跃用户数", definitionLabel: "", aggregationLabel: "" }, result: { status: "no_values", contextLabel: "", retryable: false } };
  expect(liveMetricModel(original, live).result).toMatchObject({ status: "no_records", label: "当日未返回记录", retryable: false });
  expect(liveDailyPoint(live, "M016", date)).toMatchObject({ state: "no_record", value: null, reason: "当日未返回记录" });
  expect(liveDailyPoint(live, "M016", "2026-09-07")).toMatchObject({ state: "no_value", value: null, reason: "字段未返回" });
  expect(liveDailyPoint(live, "M016", "2026-09-01")).toMatchObject({ state: "available", value: 0, display: "0", reason: "已返回" });
  live.comparison = { label: "比较", query: live.query, state: live.state };
  expect(liveDailyReferenceRows(live, ["M016"]).map(point => point.reason)).toEqual(["字段未返回", "已返回"]);
  const html = renderToStaticMarkup(<LiveSeriesDetails series={series} result={result} />);
  expect(html).toContain("当日未返回记录"); expect(html).toContain("字段未返回"); expect(html).toContain(">0<");
  expect(html).not.toContain("当日无记录");
});

test("缺失日点保持中性，来源处理状态和失败语义保持", () => {
  const { live, series } = fixture();
  expect(liveObservation(live, "M016", date)?.state).toBe("当日未返回记录");
  expect(liveObservation(live, "M016", "2026-09-06")).toMatchObject({ value: null, state: "该日未返回" });
  expect(liveDailyPoint(live, "M016", "2026-09-06")).toMatchObject({ state: "no_value", reason: "该日未返回" });
  const point = { ...series.points[2], state: "no_value" as const };
  for (const [sourceStatus, label] of [["PROCESSING", "计算中"], ["NOT_MATURE", "待成熟"], ["SOURCE_INCOMPLETE", "数据接入中"], ["FAILED", "数据异常"]] as const) {
    expect(livePointStateLabel({ ...point, sourceStatus })).toBe(label);
  }
  expect(livePointStateLabel({ ...point, state: "zero_denominator" })).toBe("分母为0");
  expect(livePointStateLabel({ ...point, state: "immature" })).toBe("未成熟");
  expect(livePointStateLabel({ ...point, state: "source_failure" })).toBe("来源读取失败");
  live.state = { status: "failure", kind: "error", code: "FAILED", message: "失败" };
  expect(liveDailyPoint(live, "M016", date)).toMatchObject({ state: "source_failure", reason: "该日查询失败" });
});

test("经营明细三个日期的单元格、详情和导出读取各自状态，93列不变", () => {
  const { live } = fixture(), columns = operatingLiveColumns(live), rows = operatingLiveRows(live, { PH: live.state });
  expect(columns).toHaveLength(93); expect(rows[0].values).toHaveLength(93);
  const index = columns.findIndex(column => column.metric.id === "M016" && !column.slice), value = rows[0].values[index], column = columns[index];
  expect(operatingValueLabel(value, column)).toBe("当日未返回记录");
  expect(operatingValueLabel(value, column, "previousDay", true)).toBe("字段未返回");
  expect(operatingValueLabel(value, column, "previousWeek", true)).toBe("0 人");
  expect(operatingValueLabel({ current: null, previousDay: null, previousWeek: null }, column)).toBe("—");
  const exported = operatingLiveExportRows(rows, columns, date), offset = 3 + index * 9;
  expect([exported[1][offset], exported[1][offset + 3], exported[1][offset + 6]]).toEqual([null, null, 0]);
  expect([exported[1][offset + 1], exported[1][offset + 4], exported[1][offset + 7]]).toEqual(["待验数 · 当日未返回记录", "待验数 · 字段未返回", "待验数 · 已返回"]);
  const evidence = operatingLiveCalculationRows(rows, columns).filter(row => row[3] === "M016:overall");
  expect(evidence.map(row => row[10])).toEqual(["待验数 · 当日未返回记录", "待验数 · 字段未返回", "待验数 · 已返回"]);
  const workbook = new TextDecoder().decode(buildPreviewWorkbook([{ name: "经营明细", rows: exported }]));
  expect(workbook).toContain("当日未返回记录"); expect(workbook).not.toContain("当日无记录");
});

test("经营明细历史状态不借当前日，计算中与查询失败按各日展示", () => {
  const { live, series } = fixture();
  series.points[1].sourceStatus = "PROCESSING";
  series.points[0] = { ...series.points[0], state: "source_failure", value: null, inputs: [{ key: "active", value: null }] };
  const columns = operatingLiveColumns(live), rows = operatingLiveRows(live, { PH: live.state });
  const index = columns.findIndex(column => column.metric.id === "M016" && !column.slice), value = rows[0].values[index];
  expect(operatingValueLabel(value, columns[index], "previousDay", true)).toBe("计算中");
  expect(operatingValueLabel(value, columns[index], "previousWeek", true)).toBe("来源读取失败");
});

test("缺少evidence时仅当前日使用显式no_record，参考日不借当前状态", () => {
  const { live } = fixture(), columns = operatingLiveColumns(live), rows = operatingLiveRows(live, { PH: live.state });
  const index = columns.findIndex(column => column.metric.id === "M016" && !column.slice);
  const value = rows[0].values[index] = { current: null, previousDay: null, previousWeek: 0, state: "no_record" };
  expect(operatingValueLabel(value, columns[index])).toBe("当日未返回记录");
  expect(operatingValueLabel(value, columns[index], "previousDay", true)).toBe("—");
  expect(operatingValueLabel(value, columns[index], "previousWeek", true)).toBe("0 人");
  const exported = operatingLiveExportRows(rows, columns, date), offset = 3 + index * 9;
  expect([exported[1][offset + 1], exported[1][offset + 4], exported[1][offset + 7]]).toEqual(["当日未返回记录", "无可用结果", "无可用结果"]);
});

test("图表CSV和页级工作表共用技术状态文案且不把缺值补0", async () => {
  const { live, series, result } = fixture();
  const sheets = connectedTopicExportSheets(live, live, "overall");
  const daily = sheets.find(sheet => sheet.name === "当前期-日活跃用户数")!;
  expect(daily.rows.slice(1).map(row => [row[1], row[3]])).toEqual([[0, "已返回"], [null, "字段未返回"], [null, "当日未返回记录"]]);
  let blob: Blob | undefined;
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const anchor = { href: "", download: "", click() {}, remove() {} };
  const url = spyOn(URL, "createObjectURL").mockImplementation(value => { blob = value as Blob; return "blob:test"; });
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => anchor, querySelector: () => null, body: { appendChild() {} } } });
  try {
    LiveSeriesExport({ series, result }).props.onClick();
    const csv = await blob!.text();
    expect(csv).toContain('"2026-09-08","","","当日未返回记录"');
    expect(csv).toContain('"2026-09-07","","","字段未返回"');
    expect(csv).toContain('"2026-09-01","0","0","已返回"');
    expect(csv).not.toContain("当日无记录");
    expect(anchor.download).toEndWith(".csv");
  } finally {
    url.mockRestore(); timer.mockRestore();
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
