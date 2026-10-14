import { expect, test } from "bun:test";
import { dailyDashboardV2SuccessSchema, type DailyDashboardSuccess, type DailyReadingMetric } from "../../../contracts/daily-dashboard";
import { shiftDate } from "../../components/ui/date-range-model";
import { recordDailyDashboardEnvironment } from "../api/daily-dashboard-environment";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { DETAIL_COLUMNS } from "./operating-detail-columns";
import { operatingValueLabel } from "./operating-detail-snapshot";
import { operatingLiveColumns, operatingLiveColumnMetadataKey, operatingLiveRows, operatingLiveExportRows, operatingLiveCalculationRows, operatingLiveSummary, type OperatingResources } from "./operating-live-model";

const date = "2020-01-01", range: [string, string] = ["2019-12-25", date];
const failure = { status: "failure" as const, kind: "error" as const, code: "UPSTREAM_TIMEOUT", message: "读取失败" };

function resource(pid: string, unit = "元", value = 24, environment: "production" | "test" = "production") {
  const metric: DailyReadingMetric = { id: "M058", referenceMetricId: "M058", name: "总充值金额", unit, definition: `${pid}正式定义`, authorityVersion: "qa-v1", formula: null,
    sourceNote: `${pid}正式来源`, inputs: [{ key: "value", name: "总充值金额", unit }] };
  const result: DailyDashboardSuccess = { success: true, data: {
    schemaVersion: "day-dashboard/v2", query: { boardId: "5.2", pid, dateRange: range }, queryId: `same-query-${pid}`,
    fetchedAt: "2026-10-14T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"],
    series: [{ metric, points: Array.from({ length: 8 }, (_, i) => ({ date: shiftDate(range[0], i), state: "available" as const, sourceStatus: "READY" as const, value, inputs: [{ key: "value", value }] })),
      periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: range, dayCount: 8, state: "unsupported", values: [], reason: "本样例只验证逐日经营快照" } }]
  } };
  expect(dailyDashboardV2SuccessSchema.safeParse(result).success).toBe(true);
  recordDailyDashboardEnvironment(result, environment);
  return { status: "success" as const, data: result, refreshing: false, refreshError: null };
}

function reading(state: OperatingResources[string] = failure): LiveDashboardReading {
  return { query: { boardId: "5.2", pid: "PH", dateRange: [date, date] }, metricIds: ["M058", "M020.natural"], state, dataEnvironment: "production",
    platformName: "Pornhub", platforms: [{ pid: "PH", name: "Pornhub" }, { pid: "TT", name: "TikTok" }], retry() {}, canExport: true,
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}

const amountIndex = DETAIL_COLUMNS.findIndex(column => column.metric.id === "M058" && !column.slice);

for (const environment of ["production", "test"] as const) for (const primary of [failure, { status: "loading" as const }]) {
  test(`${environment}环境${primary.status}页头继续隔离异环境经营元数据、数值、摘要及导出`, () => {
    const live = { ...reading(primary), dataEnvironment: environment }, otherEnvironment = environment === "production" ? "test" : "production";
    const resources = { PH: primary, TT: resource("TT", "元", 24, otherEnvironment) };
    const columns = operatingLiveColumns(live, resources), rows = operatingLiveRows(live, resources), exported = operatingLiveExportRows(rows, columns, date);
    expect([columns[amountIndex].unit, ...(["current", "previousDay", "previousWeek"] as const).map(period => rows[1].values[amountIndex][period]),
      ...[0, 3, 6].map(offset => exported[2][3 + amountIndex * 9 + offset])]).toEqual(["", null, null, null, null, null, null]);
    expect(operatingLiveSummary(live, resources, rows, "all").find(model => model.metric.id === "M058")!.result.status).not.toBe("available");
    expect(operatingLiveSummary(live, resources, rows, "TT").find(model => model.metric.id === "M058")!.result.status).not.toBe("available");
    expect(operatingLiveCalculationRows(rows, columns).filter(row => row[0] === "TT" && row[3] === "M058:overall").every(row => row[8] === null)).toBe(true);
  });
  test(`${environment}环境${primary.status}页头保留其他合法平台的单位、数值及导出`, () => {
    const live = { ...reading(primary), dataEnvironment: environment }, resources = { PH: primary, TT: resource("TT", "元", 0, environment) };
    const columns = operatingLiveColumns(live, resources), rows = operatingLiveRows(live, resources), exported = operatingLiveExportRows(rows, columns, date);
    expect(columns[amountIndex].unit).toBe("元");
    expect(rows[1].values[amountIndex]).toMatchObject({ current: 0, previousDay: 0, previousWeek: 0 });
    expect(exported[2][3 + amountIndex * 9]).toBe(0);
    expect(operatingLiveSummary(live, resources, rows, "all").find(model => model.metric.id === "M058")!.result).toMatchObject({ status: "available", completeness: "partial", value: { raw: 0, unit: "元" } });
  });
}

test("已确认环境优先于页头旧来源，页头回退元数据同样遵守环境", () => {
  const primary = resource("PH", "USD", 5, "test"), live = reading(primary), resources = { PH: primary, TT: resource("TT", "元", 0) };
  const columns = operatingLiveColumns(live, resources), rows = operatingLiveRows(live, resources);
  expect(columns[amountIndex].unit).toBe("元");
  expect(rows.map(row => row.values[amountIndex].current)).toEqual([null, 0]);
  expect(operatingLiveSummary(live, resources, rows, "all").find(model => model.metric.id === "M058")!.result).toMatchObject({ status: "available", value: { raw: 0, unit: "元" } });
  expect(operatingLiveColumns(live)[amountIndex].unit).toBe("");
});

for (const mismatch of ["pid", "date", "unconfirmed_environment"] as const) test(`${mismatch}经营资源不进入已确认范围的列元数据、数值和导出`, () => {
  const source = resource(mismatch === "pid" ? "PH" : "TT"), live = reading(failure);
  if (mismatch === "date") source.data.data.query.dateRange = ["2019-12-24", "2019-12-31"];
  if (mismatch === "unconfirmed_environment") source.data = structuredClone(source.data);
  const resources = { PH: failure, TT: source }, columns = operatingLiveColumns(live, resources), rows = operatingLiveRows(live, resources);
  expect(columns[amountIndex].unit).toBe("");
  expect(rows[1].values[amountIndex].current).toBeNull();
  expect(operatingLiveExportRows(rows, columns, date)[2][3 + amountIndex * 9]).toBeNull();
});

test("未提供显式环境时保持原来源环境推导及未确认行为", () => {
  const source = resource("PH"), live = reading(source);
  delete live.dataEnvironment;
  const mismatched = { PH: source, TT: resource("TT", "USD", 5, "test") };
  expect(operatingLiveColumns(live, mismatched)[amountIndex].unit).toBe("元");
  expect(operatingLiveRows(live, mismatched)[1].values[amountIndex].current).toBeNull();
  live.state = failure;
  expect(operatingLiveColumns(live, { PH: failure, TT: mismatched.TT })[amountIndex].unit).toBe("USD");
});

for (const primary of [failure, { status: "loading" as const }]) test(`${primary.status}页头不清空经营成功平台的金额单位`, () => {
  const live = reading(primary), resources = { PH: primary, TT: resource("TT") };
  const columns = operatingLiveColumns(live, resources), rows = operatingLiveRows(live, resources), exported = operatingLiveExportRows(rows, columns, date);
  expect(columns[amountIndex]).toMatchObject({ unit: "元", metric: { definition: "TT正式定义 TT正式来源" } });
  expect(rows[1].values[amountIndex]).toMatchObject({ current: 24, evidence: { current: { state: "available", unit: "元" } } });
  expect(operatingValueLabel(rows[1].values[amountIndex], columns[amountIndex], "current", true)).toBe("24 元");
  expect(exported[0][3 + amountIndex * 9]).toBe("总充值金额｜当日（元）");
  expect(exported[2][3 + amountIndex * 9]).toBe(24);
  expect(exported[1][3 + amountIndex * 9]).toBeNull();
});

test("没有合法来源的金额单位保持空，不回退USD且不产生数值", () => {
  const live = reading(), resources = { PH: failure, TT: failure };
  const columns = operatingLiveColumns(live, resources), rows = operatingLiveRows(live, resources), exported = operatingLiveExportRows(rows, columns, date);
  expect(columns[amountIndex].unit).toBe("");
  expect(rows.every(row => row.values[amountIndex].current === null)).toBe(true);
  expect(exported[0][3 + amountIndex * 9]).not.toContain("USD");
});

test("单位冲突关闭整列数值，保留原单位计算输入，选择单PID恢复自身结果", () => {
  const resources = { PH: resource("PH", "元", 0), TT: resource("TT", "USD", 5) }, live = reading(resources.PH);
  const columns = operatingLiveColumns(live, resources), rows = operatingLiveRows(live, resources), exported = operatingLiveExportRows(rows, columns, date);
  expect(columns[amountIndex].unit).toBe("");
  expect(rows.map(row => row.values[amountIndex].current)).toEqual([null, null]);
  expect(rows.map(row => row.values[amountIndex].evidence!.current.unit)).toEqual(["元", "USD"]);
  expect(rows.map(row => operatingValueLabel(row.values[amountIndex], columns[amountIndex]))).toEqual(["单位不一致", "单位不一致"]);
  expect(exported.slice(1).every(row => row[3 + amountIndex * 9] === null && String(row[4 + amountIndex * 9]).includes("单位不一致"))).toBe(true);
  const inputs = operatingLiveCalculationRows(rows, columns).filter(row => row[3] === "M058:overall" && row[4] === "当日");
  expect(inputs.map(row => [row[8], row[9]])).toEqual([[0, "元"], [5, "USD"]]);
  expect(operatingLiveSummary(live, resources, rows, "all").find(model => model.metric.id === "M058")!.result).toMatchObject({ status: "no_values", label: "汇总口径不一致" });
  for (const [pid, unit, value] of [["PH", "元", 0], ["TT", "USD", 5]] as const) {
    const selectedColumns = operatingLiveColumns(live, resources, pid), selectedRows = operatingLiveRows(live, resources, pid).filter(row => row.pid === pid);
    const selectedExport = operatingLiveExportRows(selectedRows, selectedColumns, date);
    expect(selectedColumns[amountIndex].unit).toBe(unit);
    expect(selectedRows[0].values[amountIndex].current).toBe(value);
    expect(selectedExport[0][3 + amountIndex * 9]).toContain(`（${unit}）`);
    expect(selectedExport[1][3 + amountIndex * 9]).toBe(value);
  }
});

test("经营资源迟到与同queryId刷新更新列元数据，纯刷新状态保持元数据键", () => {
  const live = reading({ status: "loading" }), first = { PH: { status: "loading" as const }, TT: resource("TT", "元", 0) };
  const before = operatingLiveColumns(live, { PH: first.PH, TT: { status: "loading" } });
  const loaded = operatingLiveColumns(live, first);
  expect(before[amountIndex].unit).toBe("");
  expect(loaded[amountIndex].unit).toBe("元");
  expect(operatingLiveRows(live, first)[1].values[amountIndex].current).toBe(0);
  const second = { ...first, TT: resource("TT", "人民币元", 7) };
  expect(second.TT.data.data.queryId).toBe(first.TT.data.data.queryId);
  expect(operatingLiveColumns(live, second)[amountIndex].unit).toBe("人民币元");
  const stale = { ...second, TT: { ...second.TT, refreshError: { code: "TIMEOUT", message: "刷新失败" } } };
  expect(operatingLiveColumnMetadataKey(live, stale)).toBe(operatingLiveColumnMetadataKey(live, second));
  expect(operatingLiveRows(live, stale)[1].values[amountIndex]).toMatchObject({ current: 7, evidence: { current: { stale: true, unit: "人民币元" } } });
});

test("过期经营快照不提供单位或数值，未选择的平台单位不干扰单PID", () => {
  const resources = { PH: resource("PH", "元"), TT: resource("TT", "USD") }, live = reading(resources.PH);
  resources.PH.data.data.query.dateRange = ["2019-12-24", "2019-12-31"];
  expect(operatingLiveColumns(live, resources)[amountIndex].unit).toBe("USD");
  expect(operatingLiveRows(live, resources)[0].values[amountIndex].current).toBeNull();
  expect(operatingLiveColumns(live, resources, "TT")[amountIndex].unit).toBe("USD");
});

test("合法单位投影保留非READY的空值和D1诊断输入，不产生正式结果", () => {
  const result = resource("TT");
  const series = result.data.data.series[0];
  series.points.forEach(point => Object.assign(point, { value: null, state: "no_value", sourceStatus: "PROCESSING", inputs: [{ key: "value", value: null }] }));
  result.data.data.series.push({ ...series, metric: { ...series.metric, id: "M020.natural", referenceMetricId: "M020", unit: "%", formula: "回访人数 ÷ 注册人数",
    inputs: [{ key: "retained", name: "回访人数", unit: "人" }, { key: "registered", name: "注册人数", unit: "人" }] },
    points: series.points.map(point => ({ ...point, sourceStatus: "SOURCE_INCOMPLETE", inputs: [{ key: "retained", value: 1 }, { key: "registered", value: 2 }] })) });
  const live = reading(), resources = { PH: failure, TT: result }, columns = operatingLiveColumns(live, resources), rows = operatingLiveRows(live, resources);
  expect(columns[amountIndex].unit).toBe("元");
  expect(rows[1].values[amountIndex]).toMatchObject({ current: null, evidence: { current: { label: "计算中", inputs: [{ value: null }] } } });
  const retentionIndex = columns.findIndex(column => column.metric.id === "M020" && column.slice === "自然新增");
  expect(rows[1].values[retentionIndex]).toMatchObject({ current: null, evidence: { current: { inputs: [{ value: 1 }, { value: 2 }], referenceRatio: { value: .5 } } } });
  const exported = operatingLiveExportRows(rows, columns, date);
  expect(exported[2][3 + retentionIndex * 9]).toBeNull();
  expect(exported[2][3 + amountIndex * 9]).toBeNull();
});
