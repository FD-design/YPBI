import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { connectedCohortExportRows, connectedCohortRows } from "./ConnectedCohorts";
import { connectedTopicExportSheets } from "./connected-topic-export";
import { liveCalculation, liveMetricModel, type LiveDashboardReading, type LiveSeries } from "../features/dashboards/LiveDashboardContext";
import { REGISTRATION_DIAGNOSTIC_LABEL, REGISTRATION_RETENTION_WINDOWS, readableRegistrationCohortSeries, registrationCohortDiagnosticInputs } from "../features/dashboards/registration-cohort";
import { diagnosticRatioInputs, safeDiagnosticSeries } from "../features/dashboards/diagnostic-inputs";
import { connectedDimensionRows, connectedDimensionSheet } from "./connected-dimension-model";
import { liveObservation } from "./live-reading-projection";
import { RetentionMatrix, retentionCellCalculationInputs } from "../features/dashboards/RetentionMatrix";
import { retentionMatrixScale } from "../features/dashboards/retention-matrix-scale";
import { CalculationEvidence } from "../features/dashboards/CalculationEvidence";
import { LiveSeriesDetails, LiveSeriesExport } from "../features/dashboards/ConnectedMetricCard";

const date = "2020-01-01";
const groups = [["android", 1, 2], ["ios", 1, 1], ["natural", 1, 2], ["internal", 1, 1]] as const;
function fixture() {
  const series: LiveSeries[] = groups.flatMap(([scope, numerator, denominator]) => REGISTRATION_RETENTION_WINDOWS.map(([id]) => ({
    metric: { id: `${id}.${scope}`, referenceMetricId: id, name: `${id} ${scope}留存率`, definition: "对应周期回访人数除以注册人数", formula: "留存人数 ÷ 注册人数 × 100%", unit: "%", authorityVersion: "fixture", sourceNote: null,
      inputs: [{ key: "retainedUserCount", name: "对应周期回访人数", unit: "人" }, { key: "registeredUserCount", name: "注册批次人数", unit: "人" }] },
    points: [{ date, state: "no_value" as const, sourceStatus: "SOURCE_INCOMPLETE" as const, value: null, inputs: [{ key: "retainedUserCount", value: numerator }, { key: "registeredUserCount", value: denominator }] }]
  })));
  const result: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v1", query: { boardId: "5.8", pid: "PH", dateRange: [date, date] },
    queryId: "fixture", fetchedAt: "2026-10-10T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["/api/admin/bi/v1/metrics"], series } };
  const live: LiveDashboardReading = { query: result.data.query, metricIds: series.map(series => series.metric.id), state: { status: "success", data: result, refreshing: false, refreshError: null }, platformName: "测试平台", canExport: true, retry() {},
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
  return { result, live, series };
}
const original = (id: string) => ({ metric: { id, name: "注册留存率", aggregationLabel: "", definitionLabel: "留存人数 ÷ 注册人数" }, result: { status: "no_values" as const, contextLabel: date, retryable: false } });

describe("来源不完整留存输入只供核对", () => {
  test("共享比例诊断覆盖付费、广告、支付、播放平台和获客，不生成正式值", () => {
    for (const id of ["M061", "M064", "M111.new", "M114.alipay", "M036.android", "M006", "M007"]) {
      const { live, result, series } = fixture(), source = series[0];
      source.metric = { ...source.metric, id, referenceMetricId: id.split(".")[0] };
      live.metricIds = [id]; result.data.series = [source];
      if (id === "M006" || id === "M007") source.points[0].inputs[0].value = 3;
      const numerator = source.points[0].inputs[0].value!;
      expect(diagnosticRatioInputs(source.metric, source.points[0])).toEqual({ numerator, denominator: 2 });
      const rows = connectedDimensionRows(live, [{ key: "fixture", name: "分组", seriesId: id }]);
      expect(rows[0].value).toBeNull(); expect(rows[0].state).toBe(REGISTRATION_DIAGNOSTIC_LABEL);
      expect(rows[0].calculation).toMatchObject({ numerator: { value: numerator }, denominator: { value: 2 }, result: REGISTRATION_DIAGNOSTIC_LABEL });
      const exported = connectedDimensionSheet(live, id, "范围", "诊断", rows, true).rows[3];
      expect(exported[5]).toBeNull(); expect(exported[8]).toBe(REGISTRATION_DIAGNOSTIC_LABEL);
      expect(String(exported[7])).toContain(`对应周期回访人数：${numerator}`);
      const model = liveMetricModel(original(id), live);
      expect(model.result.status).toBe("no_values");
      expect(model.result.calculation?.numerator.value).toBe(numerator);
      expect(liveObservation(live, id, date)).toMatchObject({ value: null, state: REGISTRATION_DIAGNOSTIC_LABEL });
      expect(renderToStaticMarkup(<LiveSeriesDetails series={source} result={result} />)).toContain(REGISTRATION_DIAGNOSTIC_LABEL);
      const topic = connectedTopicExportSheets(live, live, "overall").find(sheet => sheet.name === "当前期-" + source.metric.name)!;
      expect(topic.rows[1].slice(1, 5)).toEqual([null, numerator, 2, REGISTRATION_DIAGNOSTIC_LABEL]);
    }
  });

  test("共享诊断输入须对应元数据，人数派生及非比例均保持不可用", () => {
    const source = fixture().series[0];
    source.metric = { ...source.metric, id: "M061" };
    const point = source.points[0];
    expect(diagnosticRatioInputs(source.metric, { ...point, inputs: [...point.inputs].reverse() })).toBeNull();
    for (const unit of ["人", "次", "元", "次/人"]) {
      const count = { ...source, metric: { ...source.metric, id: "M115.d1", unit } };
      expect(diagnosticRatioInputs(count.metric, point)).toBeNull();
      expect(safeDiagnosticSeries(count).points[0].inputs.map(input => input.value)).toEqual([null, null]);
    }
    for (const sourceStatus of ["PROCESSING", "NOT_MATURE", "FAILED"] as const) {
      const invalid = { ...source, points: [{ ...point, sourceStatus }] };
      expect(safeDiagnosticSeries(invalid).points[0].inputs.map(input => input.value)).toEqual([null, null]);
    }
  });

  for (const [scope, numerator, denominator] of groups) test(`${scope}四周期详情、卡片计算依据和完整导出保留诊断输入`, () => {
    const { live, series, result } = fixture();
    const rows = connectedCohortRows(live.query, live.state, scope);
    expect(rows[0].base).toBeNull();
    rows[0].cells.forEach(cell => {
      expect([cell.rate, cell.count, cell.base]).toEqual([null, null, null]);
      expect(retentionCellCalculationInputs(rows[0], cell)).toEqual({ count: numerator, base: denominator });
      expect(cell.status).toContain(REGISTRATION_DIAGNOSTIC_LABEL);
    });
    for (const [id] of REGISTRATION_RETENTION_WINDOWS) {
      const source = series.find(series => series.metric.id === `${id}.${scope}`)!;
      const safe = readableRegistrationCohortSeries(source);
      expect(safe.points[0].inputs.map(input => input.value)).toEqual([numerator, denominator]);
      expect(safe.points[0].value).toBeNull();
      const model = liveMetricModel(original(source.metric.id), live);
      expect(model.result.status).toBe("no_values");
      expect(model.result.calculation).toMatchObject({ numerator: { value: numerator }, denominator: { value: denominator }, result: REGISTRATION_DIAGNOSTIC_LABEL });
      expect(model.result.status !== "available" && model.result.history).toBeUndefined();
      const detail = renderToStaticMarkup(<LiveSeriesDetails series={source} result={result} />);
      expect(detail).toContain(REGISTRATION_DIAGNOSTIC_LABEL);
      expect(detail).toContain(`<td>${numerator}</td><td>${denominator}</td><td>—</td>`);
      const calculation = renderToStaticMarkup(<CalculationEvidence basis={liveCalculation(source, source.points[0])} />);
      expect(calculation).toContain(REGISTRATION_DIAGNOSTIC_LABEL);
      expect(calculation).toContain(`${denominator} 人`);
      expect(calculation).not.toContain("50.00%");
      expect(calculation).not.toContain("100.00%");
    }
    const rowsExport = connectedCohortExportRows(live.query, live.state, scope);
    expect(rowsExport[0][2]).toContain("计算输入");
    rowsExport.slice(1).forEach(row => {
      expect([row[2], row[4], row[5]]).toEqual([denominator, numerator, null]);
      expect(String(row[7])).toContain(REGISTRATION_DIAGNOSTIC_LABEL);
    });
    const topicRows = connectedTopicExportSheets(live, live, scope).find(sheet => sheet.name === "当前注册留存")!.rows;
    expect(topicRows).toEqual(rowsExport);
  });

  test("人数/比率模式和色阶均不使用诊断输入，原有主卡空态保留计算入口", async () => {
    const { live } = fixture(), rows = connectedCohortRows(live.query, live.state, "android");
    const columns = REGISTRATION_RETENTION_WINDOWS.map(([id, days]) => ({ id, name: id, label: `D${days}`, definition: "留存人数 ÷ 注册人数 × 100%" }));
    for (const mode of ["rate", "count"] as const) {
      expect(retentionMatrixScale(rows.flatMap(row => row.cells.map(cell => mode === "rate" ? cell.rate : cell.count)), mode).empty).toBe(true);
      for (const initialView of ["heatmap", "table"]) {
        const html = renderToStaticMarkup(<RetentionMatrix title="注册留存" rows={rows} columns={columns} dateLabel="注册日" baseLabel="注册用户数" onOpen={() => {}} resetKey="fixture" initialView={initialView} initialMode={mode} />);
        expect(html).toContain("当前范围暂无成熟结果");
        expect(html).toContain(REGISTRATION_DIAGNOSTIC_LABEL);
        expect(html).not.toContain("50.00%");
        expect(html).not.toContain("100.00%");
        expect(html).toContain("is-pending");
      }
    }
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://localhost/dashboards/public?board=5.8") } });
    try {
      const { DashboardMetricCard } = await import("../features/dashboards/DashboardMetricCard");
      const model = liveMetricModel(original("M020.android"), live);
      const html = renderToStaticMarkup(<DashboardMetricCard model={model} analysisHref="/fixture" onOpenDefinition={() => {}} onOpenComparison={() => {}} onOpenTrendPoint={() => {}} />);
      expect(html).toContain("is-no_values"); expect(html).toContain("计算依据"); expect(html).not.toContain("50.00%");
    } finally { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); }
  });

  test("诊断日不进入成熟批次汇总或对比，合法READY日仍可用", () => {
    const { live, result, series } = fixture();
    result.data.query.dateRange = [date, "2020-01-02"];
    const source = series.find(series => series.metric.id === "M020.android")!;
    source.points.push({ date: "2020-01-02", state: "available", sourceStatus: "READY", value: .75, inputs: [{ key: "retainedUserCount", value: 3 }, { key: "registeredUserCount", value: 4 }] });
    live.comparison = { label: "上一周期", query: live.query, state: live.state };
    const model = liveMetricModel(original("M020.android"), live);
    expect(model.result.status).toBe("available");
    if (model.result.status !== "available") throw Error("expected ready batch");
    expect(model.result.value.raw).toBe(.75);
    expect(model.result.calculation).toMatchObject({ numerator: { value: 3 }, denominator: { value: 4 } });
    expect(model.result.trend.current.map(point => point.value?.raw ?? null)).toEqual([null, .75]);
    expect(model.result.trend.current[0].calculation?.result).toBe(REGISTRATION_DIAGNOSTIC_LABEL);
    expect(model.result.trend.comparison![0].value).toBeNull();
    expect(model.result.trend.current[0].differenceDisplay).toBeNull();
  });

  test("其他非READY、脏主值、坏输入及非留存指标不取得诊断准入", () => {
    const source = fixture().series[0], point = source.points[0];
    const invalid = [
      ...(["PROCESSING", "NOT_MATURE", "FAILED"] as const).map(sourceStatus => ({ ...point, sourceStatus })),
      { ...point, value: .5 }, { ...point, state: "available" as const },
      ...[[3, 2], [-1, 2], [1.5, 2], [1, null], [1, Number.MAX_SAFE_INTEGER + 1]].map(values => ({ ...point, inputs: point.inputs.map((input, index) => ({ ...input, value: values[index] })) }))
    ];
    for (const bad of invalid) {
      expect(registrationCohortDiagnosticInputs(source.metric.id, bad)).toBeNull();
      expect(readableRegistrationCohortSeries({ ...source, points: [bad] }).points[0].inputs.every(input => input.value === null)).toBe(true);
      expect(liveCalculation(source, bad)?.numerator.value).toBeNull();
    }
    for (const id of ["M081", "M024", "M115.d1", "M020.web"]) expect(registrationCohortDiagnosticInputs(id, point)).toBeNull();
  });

  test("0/0诊断保留0而非正式零人数，READY零分母原行为不变", () => {
    const { live, series } = fixture(), source = series[0];
    source.points[0].inputs.forEach(input => { input.value = 0; });
    let cell = connectedCohortRows(live.query, live.state, "android")[0].cells[0];
    expect(cell).toMatchObject({ rate: null, count: null, base: null, diagnosticInputs: { count: 0, base: 0 } });
    Object.assign(source.points[0], { state: "zero_denominator", sourceStatus: "READY" });
    cell = connectedCohortRows(live.query, live.state, "android")[0].cells[0];
    expect(cell).toMatchObject({ rate: null, count: 0, base: 0 });
    expect(cell.diagnosticInputs).toBeUndefined();
  });

  test("单卡CSV当前/比较独立保留诊断inputs、空结果与核对状态", async () => {
    const { result, series } = fixture(), previous = structuredClone(result);
    previous.data.query.dateRange = ["2019-12-31", "2019-12-31"];
    previous.data.series[0].points[0].date = "2019-12-31";
    previous.data.series[0].points[0].inputs[1].value = 3;
    let blob: Blob | undefined;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const anchor = { href: "", download: "", click() {}, remove() {} };
    const url = spyOn(URL, "createObjectURL").mockImplementation(value => { blob = value as Blob; return "blob:fixture"; });
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => anchor, querySelector: () => null, body: { appendChild() {} } } });
    try {
      LiveSeriesExport({ series: series[0], result, comparison: previous }).props.onClick();
      const csv = await blob!.text();
      expect(csv).toContain(`"当前期","PH","${date}","1","2","","${REGISTRATION_DIAGNOSTIC_LABEL}"`);
      expect(csv).toContain(`"对比期","PH","2019-12-31","1","3","","${REGISTRATION_DIAGNOSTIC_LABEL}"`);
    } finally {
      url.mockRestore(); timer.mockRestore();
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else Reflect.deleteProperty(globalThis, "document");
    }
  });
});
