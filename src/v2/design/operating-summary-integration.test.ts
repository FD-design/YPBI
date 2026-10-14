import { expect, test } from "bun:test";
import type { DailyDashboardSuccess, DailyPoint } from "../../../contracts/daily-dashboard";
import { recordDailyDashboardEnvironment } from "../api/daily-dashboard-environment";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { DETAIL_COLUMNS, summaryColumn } from "./operating-detail-columns";
import { operatingLiveRows, operatingLiveSummary, operatingLiveColumnSummary, operatingLiveCalculationRows, type OperatingResources } from "./operating-live-model";
import { operatingDetailBreakdown } from "./operating-detail-snapshot";

const date = "2020-01-01", range: [string, string] = ["2019-12-25", date];
const ids = ["M016", "M081", "M020", "M058", "M016.android"];
function resource(pid: string, active: number, watching: number, amount: number) {
  const payload: DailyDashboardSuccess = { success: true, data: {
    schemaVersion: "day-dashboard/v2", query: { boardId: "5.2", pid, dateRange: range }, queryId: `qa-${pid}`, fetchedAt: "2026-10-14T00:00:00Z",
    timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"],
    series: ids.map(id => {
      const ratio = ["M081", "M020"].includes(id), unit = ratio ? "%" : id === "M058" ? "元" : "人";
      const definitions = ratio ? [{ key: "numerator", name: id === "M020" ? "D1回访人数" : "观影人数", unit: "人" }, { key: "denominator", name: id === "M020" ? "注册批次人数" : "日活人数", unit: "人" }]
        : [{ key: "value", name: id === "M058" ? "充值金额" : "日活人数", unit }];
      const value = ratio ? watching / active : id === "M058" ? amount : active;
      const inputs = ratio ? [{ key: "numerator", value: watching }, { key: "denominator", value: active }] : [{ key: "value", value }];
      return { metric: { id, name: id, unit, referenceMetricId: id.split(".")[0], authorityVersion: "qa-v1", definition: "隔离验收样例", formula: ratio ? "分子 ÷ 分母" : null, sourceNote: null, inputs: definitions },
        points: [{ date, state: "available", sourceStatus: "READY", value, inputs }],
        periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: range, dayCount: 8, state: "unsupported", values: [], reason: null } };
    })
  } };
  recordDailyDashboardEnvironment(payload, "production");
  return { status: "success" as const, data: payload, refreshing: false, refreshError: null };
}
function setup() {
  const resources: OperatingResources = { PH: resource("PH", 2, 1, 162.02), TT: resource("TT", 100, 90, 24) };
  const live: LiveDashboardReading = { query: { boardId: "5.2", pid: "PH", dateRange: [date, date] }, metricIds: ids, state: resources.PH,
    dataEnvironment: "production", platforms: [{ pid: "PH", name: "Pornhub" }, { pid: "TT", name: "TikTok" }], platformName: "Pornhub", retry() {}, canExport: false,
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
  return { live, resources };
}
function metric(live: LiveDashboardReading, resources: OperatingResources, id: string) {
  return operatingLiveSummary(live, resources, operatingLiveRows(live, resources), "all").find(model => model.metric.id === id)!;
}

test("经营全部平台使用每个PID同日来源，人数、金额及同群比例与明细一致", () => {
  const { live, resources } = setup();
  expect(metric(live, resources, "M016").result).toMatchObject({ status: "available", value: { raw: 102, unit: "人" } });
  const watching = metric(live, resources, "M081").result;
  expect(watching.status).toBe("available");
  if (watching.status === "available") expect(watching.value.raw).toBeCloseTo(91 / 102, 12);
  expect(watching.calculation).toMatchObject({ numerator: { value: 91 }, denominator: { value: 102 } });
  const amount = metric(live, resources, "M058").result;
  expect(amount.status === "available" && amount.value.raw).toBeCloseTo(186.02, 8);
  expect(amount.status === "available" && amount.value.unit).toBe("元");
  expect(operatingLiveRows(live, resources)).toHaveLength(2);
});

test("全部平台维度详情复用分组来源，不借用总体或差额", () => {
  const { live, resources } = setup(), rows = operatingLiveRows(live, resources), overall = metric(live, resources, "M016");
  const detail = operatingDetailBreakdown(overall, rows, "all", date, column => operatingLiveColumnSummary(live, resources, rows, column));
  const android = detail.groups.flatMap(group => group.rows).find(row => row.label === "Android");
  expect(android?.value).toMatchObject({ status: "available", raw: 102, origin: "pending" });
  expect(detail.context).toContain("未跨PID去重");
});

test("错环境、错日期及失败平台不补0且保留覆盖范围", () => {
  for (const kind of ["environment", "date", "failure"] as const) {
    const { live, resources } = setup();
    if (kind === "failure") resources.TT = { status: "failure", kind: "error", code: "INVALID_V2_RESPONSE", message: "响应格式异常", requestId: "qa-failed" };
    else if (resources.TT.status === "success") {
      if (kind === "environment") recordDailyDashboardEnvironment(resources.TT.data, "test");
      else resources.TT.data.data.query.dateRange = ["2019-12-24", "2019-12-31"];
    }
    const model = metric(live, resources, "M016");
    expect(model.result).toMatchObject({ status: "available", completeness: "partial", value: { raw: 2 } });
    expect(model.metric.aggregationLabel).toContain("覆盖1/2平台");
    expect(operatingLiveRows(live, resources)[1].values[DETAIL_COLUMNS.indexOf(summaryColumn("M016"))].current).toBeNull();
  }
});

test("D1不完整的诊断人数不进入摘要，但其他可用指标继续合计", () => {
  const { live, resources } = setup();
  if (resources.TT.status !== "success") throw Error("fixture");
  const point = resources.TT.data.data.series.find(series => series.metric.id === "M020")!.points[0];
  Object.assign(point, { state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null } satisfies Partial<DailyPoint>);
  expect(metric(live, resources, "M020").result).toMatchObject({ status: "available", completeness: "partial", value: { raw: .5 }, calculation: { numerator: { value: 1 }, denominator: { value: 2 } } });
  expect(metric(live, resources, "M016").result).toMatchObject({ status: "available", value: { raw: 102 } });
});

test("全部平台导出保留合计输入、93列逐平台明细与未去重范围", () => {
  const { live, resources } = setup(), rows = operatingLiveRows(live, resources), models = operatingLiveSummary(live, resources, rows, "all");
  const exported = operatingLiveCalculationRows(rows, DETAIL_COLUMNS, models);
  const summary = exported.filter(row => row[3] === "M081:platform-sum");
  expect(summary.map(row => row[8])).toEqual([91, 102]);
  expect(summary.every(row => String(row[1]).includes("未跨PID去重"))).toBe(true);
  expect(exported.every(row => row.length === exported[0].length)).toBe(true);
  expect(rows.every(row => row.values.length === 93)).toBe(true);
});

for (const [id, unit] of [["M058", "元"], ["M067", "元/人"]] as const) test(`全部平台${id}总体未就绪而切片可用时保留正式${unit}，不回退演示单位`, () => {
  const { live, resources } = setup();
  live.metricIds = [...live.metricIds, `${id}.new`, id];
  for (const resource of Object.values(resources)) if (resource.status === "success") {
    const source = structuredClone(resource.data.data.series.find(series => series.metric.id === "M058")!);
    source.metric = { ...source.metric, id, referenceMetricId: id, unit, inputs: id === "M067" ? [{ key: "amount", name: "充值金额", unit: "元" }, { key: "paying", name: "付费人数", unit: "人" }] : source.metric.inputs };
    source.points = [{ date, state: "no_value", sourceStatus: "PROCESSING", value: null, inputs: source.metric.inputs.map(input => ({ key: input.key, value: null })) }];
    resource.data.data.series = resource.data.data.series.filter(series => series.metric.id !== id);
    resource.data.data.series.push(source, { ...structuredClone(source), metric: { ...source.metric, id: `${id}.new` }, points: [{ date, state: "available", sourceStatus: "READY", value: 100,
      inputs: source.metric.inputs.map((input, index) => ({ key: input.key, value: index === 1 ? 1 : 100 })) }] });
  }
  const rows = operatingLiveRows(live, resources), overall = metric(live, resources, id);
  expect(overall.result.status).not.toBe("available");
  const detail = operatingDetailBreakdown(overall, rows, "all", date, column => operatingLiveColumnSummary(live, resources, rows, column));
  expect(detail.unit).toBe(unit);
  expect(detail.groups.flatMap(group => group.rows).find(row => row.label === "新用户")?.value).toMatchObject({ status: "available", raw: id === "M067" ? 100 : 200 });
  expect(detail.unit).not.toContain("USD");
});
