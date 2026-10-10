import { expect, test } from "bun:test";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import type { LiveDashboardReading, LiveSeries } from "../features/dashboards/LiveDashboardContext";
import { REGISTRATION_DIAGNOSTIC_LABEL } from "../features/dashboards/registration-cohort";
import { DIAGNOSTIC_INPUTS_LABEL } from "../features/dashboards/diagnostic-inputs";
import { DETAIL_COLUMNS, detailColumnKey } from "./operating-detail-columns";
import { OPERATING_LIVE_IDS, operatingLiveCalculationRows, operatingLiveColumns, operatingLiveExportRows, operatingLiveRows } from "./operating-live-model";

const IDS = ["M020", "M020.android", "M020.ios", "M020.natural", "M020.internal", "M021", "M022", "M023", "M115.d1", "M036", "M006", "M007", "M061", "M064", "M114"];
function reading(): LiveDashboardReading {
  const query = { boardId: "5.2", pid: "PH", dateRange: ["2019-12-25", "2020-01-01"] as [string, string] };
  const series: LiveSeries[] = IDS.map(id => ({ metric: { id, name: id, referenceMetricId: id.split(".")[0], authorityVersion: "fixture", unit: id === "M115.d1" ? "人" : "%", definition: "真实同注册批次", formula: "回访人数 ÷ 注册人数", sourceNote: "来源不完整",
    inputs: [{ key: "retainedUserCount", name: "回访人数", unit: "人" }, { key: "registeredUserCount", name: "注册人数", unit: "人" }] },
    points: ["2019-12-25", "2019-12-31", "2020-01-01"].map(date => ({ date, value: null, state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", inputs: [{ key: "retainedUserCount", value: 84 }, { key: "registeredUserCount", value: 105 }] })) }));
  const data: DailyDashboardSuccess = { success: true, data: { query, schemaVersion: "day-dashboard/v1", queryId: "isolated-diagnostics", fetchedAt: "2026-10-10T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"], series } };
  return { query, metricIds: IDS, state: { status: "success", data, refreshing: false, refreshError: null }, platformName: "PH", canExport: true, retry() {},
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}
function payload(live: LiveDashboardReading) { if (live.state.status !== "success") throw new Error("fixture"); return live.state.data; }
function selected(live: LiveDashboardReading, id = "M020.android") { return payload(live).data.series.find(series => series.metric.id === id)!; }
function value(live: LiveDashboardReading, id = "M020.android") {
  const index = DETAIL_COLUMNS.findIndex(column => OPERATING_LIVE_IDS[detailColumnKey(column)] === id);
  return operatingLiveRows(live, { PH: live.state })[0].values[index];
}

test("经营四D1及总体D1/D3/D7/D30只在evidence保留诊断输入，结果与人数不恢复", () => {
  const live = reading();
  for (const id of IDS.filter(id => /^M02/.test(id))) {
    const entry = value(live, id);
    expect([entry.current, entry.previousDay, entry.previousWeek]).toEqual([null, null, null]);
    for (const period of ["current", "previousDay", "previousWeek"] as const) {
      expect(entry.evidence?.[period].label).toBe(REGISTRATION_DIAGNOSTIC_LABEL);
      expect(entry.evidence?.[period].inputs.map(input => input.value)).toEqual([84, 105]);
    }
  }
  expect(value(live, "M115.d1").current).toBeNull();
  expect(value(live, "M115.d1").evidence?.current.inputs.map(input => input.value)).toEqual([null, null]);
  expect(value(live, "M036").current).toBeNull();
  expect(value(live, "M036").evidence?.current.inputs.map(input => input.value)).toEqual([84, 105]);
});

test("经营已映射泛比例保留合法核对输入，注册转化允许分子大于分母但不产生正式比率", () => {
  const live = reading();
  for (const id of ["M006", "M007", "M061", "M064", "M114", "M036"]) {
    const entry = value(live, id);
    expect(entry.current).toBeNull(); expect(entry.evidence?.current.label).toBe(DIAGNOSTIC_INPUTS_LABEL);
    expect(entry.evidence?.current.inputs.map(input => input.value)).toEqual([84, 105]);
  }
  for (const id of ["M006", "M007"]) {
    selected(live, id).points.forEach(point => { point.inputs[0].value = 160; });
    expect(value(live, id)).toMatchObject({ current: null, evidence: { current: { label: DIAGNOSTIC_INPUTS_LABEL, inputs: [{ value: 160 }, { value: 105 }] } } });
  }
  selected(live, "M061").points.forEach(point => { point.inputs[0].key = "wrong"; });
  expect(value(live, "M061").evidence?.current.inputs.map(input => input.value)).toEqual([null, null]);
});

test("诊断零输入保留0/0但不生成0%，其他非READY和脏结果不扩展", () => {
  const zero = reading(); selected(zero).points.forEach(point => point.inputs.forEach(input => { input.value = 0; }));
  expect(value(zero)).toMatchObject({ current: null, evidence: { current: { label: REGISTRATION_DIAGNOSTIC_LABEL, inputs: [{ value: 0 }, { value: 0 }] } } });
  for (const status of ["PROCESSING", "NOT_MATURE", "FAILED"] as const) {
    const live = reading(); selected(live).points.forEach(point => { point.sourceStatus = status; });
    expect(value(live).current).toBeNull(); expect(value(live).evidence?.current.inputs.map(input => input.value)).toEqual([null, null]);
    expect(value(live).evidence?.current.label).not.toBe(REGISTRATION_DIAGNOSTIC_LABEL);
  }
  const dirty = reading(); selected(dirty).points.forEach(point => { point.value = .8; point.state = "available"; });
  expect(value(dirty).current).toBeNull(); expect(value(dirty).evidence?.current.inputs.map(input => input.value)).toEqual([null, null]);
  expect(value(dirty).evidence?.current.state).toBe("no_value");
});

test("异常输入不进入经营核对，READY结果及零分母维持原行为", () => {
  for (const inputs of [[106, 105], [1.5, 105], [-1, 105], [1, Number.MAX_SAFE_INTEGER + 1], [NaN, 105], [null, 105]]) {
    const live = reading(); selected(live).points.forEach(point => point.inputs.forEach((input, index) => { input.value = inputs[index]; }));
    expect(value(live).evidence?.current.inputs.map(input => input.value)).toEqual([null, null]);
    expect(value(live).evidence?.current.label).not.toBe(REGISTRATION_DIAGNOSTIC_LABEL);
  }
  const ready = reading(); selected(ready).points.forEach(point => { point.value = .8; point.state = "available"; point.sourceStatus = "READY"; });
  expect(value(ready).current).toBe(.8); expect(value(ready).evidence?.current.inputs.map(input => input.value)).toEqual([84, 105]);
  selected(ready).points.forEach(point => { point.value = null; point.state = "zero_denominator"; point.inputs.forEach(input => { input.value = 0; }); });
  expect(value(ready)).toMatchObject({ current: null, evidence: { current: { label: "分母为0", inputs: [{ value: 0 }, { value: 0 }] } } });
});

test("经营宽表/计算导出与evidence同标签且不把核对输入当正式结果", () => {
  const live = reading(), rows = operatingLiveRows(live, { PH: live.state }), columns = operatingLiveColumns(live);
  const wide = operatingLiveExportRows(rows, columns, "2020-01-01");
  const index = DETAIL_COLUMNS.findIndex(column => OPERATING_LIVE_IDS[detailColumnKey(column)] === "M020.android");
  expect(wide[1].slice(3 + index * 9, 3 + index * 9 + 3)).toEqual([null, "待验数 · " + REGISTRATION_DIAGNOSTIC_LABEL, "2026-10-10T00:00:00Z"]);
  const inputs = operatingLiveCalculationRows(rows, columns).filter(row => row[3] === "M020:Android" && row[4] === "当日");
  expect(inputs.map(row => row[8])).toEqual([84, 105]); expect(inputs.every(row => row[10] === "待验数 · " + REGISTRATION_DIAGNOSTIC_LABEL)).toBe(true);
  payload(live).data.query = { ...live.query, pid: "OTHER" };
  expect(value(live).current).toBeNull(); expect(value(live).evidence?.current.inputs).toEqual([]);
});

test("通用逐指标整板导出保留合法诊断输入并隔离其他非READY", async () => {
  await import("echarts/core");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://localhost/dashboards/public?board=5.2") } });
  try {
    const { connectedBoardMetricSheet } = await import("./ConnectedBoard");
    const live = reading(), series = selected(live);
    expect(connectedBoardMetricSheet(series, payload(live), "当前期").rows[1].slice(1, 5)).toEqual([null, 84, 105, REGISTRATION_DIAGNOSTIC_LABEL]);
    expect(connectedBoardMetricSheet(series, payload(live), "对比期", true).rows[1].at(-1)).toBe("上次查询结果");
    for (const sourceStatus of ["PROCESSING", "NOT_MATURE", "FAILED"] as const) {
      series.points[0].sourceStatus = sourceStatus;
      expect(connectedBoardMetricSheet(series, payload(live), "当前期").rows[1].slice(1, 4)).toEqual([null, null, null]);
    }
    series.points[0].sourceStatus = "SOURCE_INCOMPLETE"; series.points[0].state = "available"; series.points[0].value = .8;
    expect(connectedBoardMetricSheet(series, payload(live), "当前期").rows[1].slice(1, 4)).toEqual([null, null, null]);
    expect(connectedBoardMetricSheet(selected(live, "M115.d1"), payload(live), "当前期").rows[1].slice(1, 4)).toEqual([null, null, null]);
    series.points[0].sourceStatus = "READY";
    expect(connectedBoardMetricSheet(series, payload(live), "当前期").rows[1].slice(1, 5)).toEqual([.8, 84, 105, "已返回"]);
    for (const id of ["M006", "M007", "M061", "M064", "M114", "M036"]) {
      const ratio = selected(live, id);
      if (id === "M006" || id === "M007") ratio.points[0].inputs[0].value = 160;
      expect(connectedBoardMetricSheet(ratio, payload(live), "当前期").rows[1].slice(1, 5)).toEqual([null, id === "M006" || id === "M007" ? 160 : 84, 105, DIAGNOSTIC_INPUTS_LABEL]);
      ratio.points[0].sourceStatus = "PROCESSING";
      expect(connectedBoardMetricSheet(ratio, payload(live), "当前期").rows[1].slice(1, 4)).toEqual([null, null, null]);
    }
  } finally { if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window"); }
});
