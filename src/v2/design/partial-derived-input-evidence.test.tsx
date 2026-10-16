import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { recordDailyDashboardEnvironment } from "../api/daily-dashboard-environment";
import { CalculationEvidence } from "../features/dashboards/CalculationEvidence";
import { LiveSeriesDetails, LiveSeriesExport } from "../features/dashboards/ConnectedMetricCard";
import { liveCalculation, liveDailyPoint, liveMetricModel, type LiveDashboardReading, type LiveSeries } from "../features/dashboards/LiveDashboardContext";
import { calculationInputValues, diagnosticRatioInputs, retentionReferenceRatio, RETENTION_REFERENCE_LABEL } from "../features/dashboards/diagnostic-inputs";
import { connectedDimensionRows, connectedDimensionSeries, connectedDimensionSheet } from "./connected-dimension-model";
import { connectedTopicExportSheets } from "./connected-topic-export";
import { detailColumnKey } from "./operating-detail-columns";
import { OPERATING_LIVE_IDS, operatingLiveCalculationRows, operatingLiveColumns, operatingLiveExportRows, operatingLiveRows } from "./operating-live-model";
import { operatingPlatformSummary } from "./operating-platform-summary";
import { buildPreviewWorkbook, type WorkbookSheet } from "./preview-workbook";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://localhost/dashboards/public?board=5.2") } });
const { connectedBoardExportSheets } = await import("./ConnectedBoard");
if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");

const date = "2020-01-01";
const start = "2019-12-25";
const cases = [
  { id: "M087", name: "活跃用户ARPU", numeratorKey: "diamondChargeAmt", numeratorName: "总充值金额", denominatorKey: "loginUserCount", denominatorName: "同范围日活跃用户数", denominator: 6 },
  { id: "M088", name: "新增用户ARPU", numeratorKey: "newUserDiamondChargeAmt", numeratorName: "新用户注册当日充值金额", denominatorKey: "registerUserCount", denominatorName: "同注册批次新增用户数", denominator: 10 },
  { id: "M067", name: "付费用户ARPPU", numeratorKey: "diamondChargeAmt", numeratorName: "总充值金额", denominatorKey: "payingUserCount", denominatorName: "同范围付费去重用户数", denominator: 5 },
  { id: "M067.new", name: "新用户ARPPU", numeratorKey: "newUserDiamondChargeAmt", numeratorName: "新用户注册当日充值金额", denominatorKey: "newPayingUserCount", denominatorName: "同注册批次注册当日付费用户数", denominator: 3 },
  { id: "M098", name: "人均观影时长", numeratorKey: "totalUserWatchTime", numeratorName: "播放成功后的前台观看时长", denominatorKey: "watchUserCount", denominatorName: "同范围观影用户数", denominator: 5 }
] as const;

function fixture() {
  const series: LiveSeries[] = cases.map(item => {
    const duration = item.id === "M098";
    const inputs = [{ key: item.numeratorKey, name: item.numeratorName, unit: duration ? "秒" : "元" },
      { key: item.denominatorKey, name: item.denominatorName, unit: "人" }];
    return {
      metric: { id: item.id, referenceMetricId: item.id.split(".")[0], name: item.name, unit: duration ? "分钟/人" : "元/人", authorityVersion: "partial-input-fixture-v1",
        definition: duration ? "同日同PID前台观看时长除以观影人数，秒换算为分钟。" : "同日同PID同人群充值金额除以已登记人数。",
        formula: duration ? "播放成功后的前台观看时长（秒） ÷ 同范围观影用户数 ÷ 60" : `${item.numeratorName} ÷ ${item.denominatorName}`,
        sourceNote: "基础金额或时长来源不完整；独立READY人数作为实际计算输入保留。", inputs },
      points: Array.from({ length: 8 }, (_, index) => ({ date: new Date(Date.parse(start) + index * 86400000).toISOString().slice(0, 10),
        state: "no_value" as const, sourceStatus: "SOURCE_INCOMPLETE" as const, value: null,
        inputs: [{ key: item.numeratorKey, value: null }, { key: item.denominatorKey, value: item.denominator }] }))
    };
  });
  const result: DailyDashboardSuccess = recordDailyDashboardEnvironment({ success: true, data: {
    schemaVersion: "day-dashboard/v1", query: { boardId: "5.2", pid: "PH", dateRange: [start, date] }, queryId: "partial-derived-inputs", fetchedAt: "2026-10-16T02:13:58Z",
    timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["/api/admin/bi/v1/metrics"], series
  } }, "test");
  const live: LiveDashboardReading = { query: result.data.query, metricIds: series.map(item => item.metric.id),
    state: { status: "success", data: result, refreshing: false, refreshError: null }, dataEnvironment: "test", platformName: "PH测试平台", canExport: true, retry() {},
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
  return { live, result, series };
}

async function metricCsv(series: LiveSeries, result: DailyDashboardSuccess) {
  let blob: Blob | undefined;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const anchor = { href: "", download: "", click() {}, remove() {} };
  const url = spyOn(URL, "createObjectURL").mockImplementation(value => { blob = value as Blob; return "blob:partial-input-fixture"; });
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => anchor, querySelector: () => null, body: { appendChild() {} } } });
  try {
    const element = LiveSeriesExport({ series, result });
    (element.props.onClick as () => void)();
    return (await blob!.text()).replace(/^\uFEFF/, "").split("\r\n").map(row => row.split(",").map(value => value.slice(1, -1)));
  } finally {
    url.mockRestore(); timer.mockRestore();
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else Reflect.deleteProperty(globalThis, "document");
  }
}

function workbookPart(bytes: Uint8Array, name: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decode = new TextDecoder();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + nameLength + extraLength;
    if (decode.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)) === name) return decode.decode(bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  throw new Error(`缺少工作簿部分：${name}`);
}

function columnRef(index: number) {
  let value = "";
  for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) value = String.fromCharCode(65 + (current - 1) % 26) + value;
  return value;
}

describe("BI派生结果缺失时保留独立可用计算输入", () => {
  for (const item of cases) test(`${item.id}详情、分类、整板、专题和单卡CSV保留人数且不生成结果`, async () => {
    const { live, result, series } = fixture(), source = series.find(value => value.metric.id === item.id)!, point = source.points.at(-1)!;
    const before = JSON.stringify(result);
    expect(calculationInputValues(source.metric, point)).toEqual([null, item.denominator]);
    expect(diagnosticRatioInputs(source.metric, point)).toBeNull();
    expect(retentionReferenceRatio(source.metric, point)).toBeNull();
    const calculation = liveCalculation(source, point)!;
    expect(calculation).toMatchObject({ numerator: { value: null, unit: item.id === "M098" ? "秒" : "元" }, denominator: { value: item.denominator, unit: "人" }, percentage: false });
    expect(calculation.result).toBe(`— ${source.metric.unit}`);
    expect(calculation.scope).not.toContain(RETENTION_REFERENCE_LABEL);
    const calculationHtml = renderToStaticMarkup(<CalculationEvidence basis={calculation} />);
    expect(calculationHtml).toContain(`${item.denominator} 人`);
    const details = renderToStaticMarkup(<LiveSeriesDetails series={source} result={result} />);
    expect(details).toContain(`<td>—</td><td>${item.denominator}</td><td>—</td><td>来源不完整</td>`);
    expect(details).not.toContain(RETENTION_REFERENCE_LABEL);
    expect(details).not.toContain("参考比率");

    expect(liveDailyPoint(live, item.id, date)).toMatchObject({ value: null, display: "—", state: "no_value", calculation: { denominator: { value: item.denominator } } });
    for (const sheets of [connectedBoardExportSheets(live), connectedTopicExportSheets(live, live, "overall")]) {
      const sheet = sheets.find(value => value.name === `当前期-${item.name}`)!;
      expect(sheet.rows.at(-1)?.slice(1, 5)).toEqual([null, null, item.denominator, "来源不完整"]);
      expect(sheet.rows[0]).not.toContain("参考比率（%）");
      expect(sheets.find(value => value.name === "周期统计")!.rows).toHaveLength(1);
    }
    const dimension = connectedDimensionSeries(live, item.id)!;
    expect(dimension.points.at(-1)).toMatchObject({ value: null, sourceStatus: "SOURCE_INCOMPLETE", inputs: [{ value: null }, { value: item.denominator }] });
    const rows = connectedDimensionRows(live, [{ key: "scope", name: "已登记范围", seriesId: item.id }]);
    expect(rows[0]).toMatchObject({ value: null, baseline: null, reference: null, calculation: { numerator: { value: null }, denominator: { value: item.denominator } } });
    const dimensionSheet = connectedDimensionSheet(live, item.id, "人群", item.name, rows, true);
    expect(dimensionSheet.rows.at(-1)?.slice(5, 9)).toEqual([null, source.metric.unit, `${item.numeratorName}：—；${item.denominatorName}：${item.denominator}`, "来源不完整"]);
    expect(dimensionSheet.rows[2]).not.toContain("参考比率（%）");
    const csv = await metricCsv(source, result);
    expect(csv.at(-1)?.slice(3, 7)).toEqual(["", String(item.denominator), "", "来源不完整"]);
    expect(csv[0]).not.toContain("参考比率（%）");
    expect(csv.at(-1)?.at(-1)).toBe("测试数据");
    expect(JSON.stringify(result)).toBe(before);
    const original = { metric: { id: item.id, name: item.name, definitionLabel: source.metric.definition, aggregationLabel: date }, result: { status: "no_values" as const, contextLabel: date, retryable: false } };
    expect(liveMetricModel(original, live).result).toMatchObject({ status: "no_values", calculation: { numerator: { value: null }, denominator: { value: item.denominator } } });
  });

  test("经营四项人均金额三期、计算依据与实际XLSX保留空金额和数值分母", () => {
    const { live } = fixture(), resources = { PH: live.state }, columns = operatingLiveColumns(live, resources), rows = operatingLiveRows(live, resources);
    const calculations = operatingLiveCalculationRows(rows, columns), wide = operatingLiveExportRows(rows, columns, date);
    const workbook: WorkbookSheet[] = [{ name: "经营明细", rows: wide }, { name: "计算依据", rows: calculations }];
    const bytes = buildPreviewWorkbook(workbook), wideXml = workbookPart(bytes, "xl/worksheets/sheet1.xml"), inputXml = workbookPart(bytes, "xl/worksheets/sheet2.xml");
    expect(columns).toHaveLength(93);
    expect(wide[0].some(cell => String(cell).includes("参考比率"))).toBe(false);
    for (const item of cases.filter(item => item.id !== "M098")) {
      const index = columns.findIndex(column => OPERATING_LIVE_IDS[detailColumnKey(column)] === item.id);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(columns[index].unit).toBe("元/人");
      const value = rows[0].values[index];
      expect([value.current, value.previousDay, value.previousWeek]).toEqual([null, null, null]);
      for (const period of ["current", "previousDay", "previousWeek"] as const) {
        expect(value.evidence?.[period]).toMatchObject({ state: "no_value", label: "来源不完整", inputs: [{ value: null, unit: "元" }, { value: item.denominator, unit: "人" }] });
        expect(value.evidence?.[period].referenceRatio).toBeUndefined();
      }
      const key = detailColumnKey(columns[index]);
      const inputRows = calculations.map((row, rowIndex) => ({ row, rowIndex })).filter(({ row }) => row[3] === key);
      expect(inputRows).toHaveLength(6);
      for (const label of ["当日", "昨日", "上周同日"]) expect(inputRows.filter(({ row }) => row[4] === label).map(({ row }) => row[8])).toEqual([null, item.denominator]);
      for (const { row, rowIndex } of inputRows) {
        expect(row[10]).toBe("待验数 · 来源不完整");
        expect(inputXml).toContain(row[8] === null ? `<c r="I${rowIndex + 1}"/>` : `<c r="I${rowIndex + 1}"><v>${item.denominator}</v></c>`);
      }
      for (let period = 0; period < 3; period++) {
        const cell = 3 + index * 9 + period * 3;
        expect(wide[1][cell]).toBeNull();
        expect(wide[1][cell + 1]).toBe("待验数 · 来源不完整");
        expect(wideXml).toContain(`<c r="${columnRef(cell)}2"/>`);
      }
    }
  });

  test("平台合计不消费缺失结果的可用分母，完整平台独立参与", () => {
    const source = fixture().series.find(item => item.metric.id === "M067")!, point = source.points.at(-1)!;
    const incomplete = { pid: "PH", name: "来源不完整平台", metric: source.metric, point };
    const unavailable = operatingPlatformSummary(date, { M067: [incomplete] }).find(item => item.metric.id === "M067")!;
    expect(unavailable.result.status).toBe("no_values");
    expect(unavailable.result.calculation).toBeUndefined();
    expect(unavailable.metric.aggregationLabel).toContain("覆盖0/1平台");
    const ready = { pid: "TT", name: "完整平台", metric: source.metric,
      point: { ...point, state: "available" as const, sourceStatus: "READY" as const, value: 10, inputs: [{ key: source.metric.inputs[0].key, value: 20 }, { key: source.metric.inputs[1].key, value: 2 }] } };
    const aggregate = operatingPlatformSummary(date, { M067: [incomplete, ready] }).find(item => item.metric.id === "M067")!;
    expect(aggregate.result).toMatchObject({ status: "available", completeness: "partial", value: { raw: 10, unit: "元/人" }, calculation: { numerator: { value: 20 }, denominator: { value: 2 } } });
    expect(aggregate.metric.aggregationLabel).toContain("覆盖1/2平台");
  });
});
