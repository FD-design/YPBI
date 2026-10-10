import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { LiveDashboardContext, liveMetricModel, type LiveDashboardReading, type LiveSeries } from "../features/dashboards/LiveDashboardContext";
import { connectedDimensionReading, connectedDimensionSeries } from "./connected-dimension-model";
import { paymentDimensionRows, paymentDimensionSheet, paymentDimensionSupported, paymentDimensionUnit } from "./payment-dimension-model";
import { DEMO_RANGE } from "./extended-board-model";

function series(id: string, value: number, unit = "元", date = "2020-01-01"): LiveSeries {
  const arppu = id.startsWith("M067");
  return { metric: { id, referenceMetricId: id.split(".")[0], name: id, unit, authorityVersion: "fixture", definition: "同范围独立真实结果", formula: arppu ? "同范围充值金额 ÷ 同范围付费用户数" : null, sourceNote: "隔离测试输入",
    inputs: arppu ? [{ key: "amount", name: "充值金额", unit: "元" }, { key: "users", name: "付费用户数", unit: "人" }] : [{ key: "value", name: "实际结果", unit }] },
    points: [{ date, value, state: "available", sourceStatus: "READY", inputs: arppu ? [{ key: "amount", value: value * 3 }, { key: "users", value: 3 }] : [{ key: "value", value }] }] };
}
function reading(): LiveDashboardReading {
  const query = { boardId: "5.10", pid: "PH", dateRange: ["2020-01-01", "2020-01-01"] as [string, string] };
  const data: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v1", query, queryId: "payment-dimension", fetchedAt: "2026-10-09T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"], series: [
    series("M058", 162.02), series("M058.new", 141.02), series("M059", 5, "人"), series("M059.new", 3, "人"), series("M067", 32.404, "元/人"), series("M067.new", 47.00666666666667, "元/人"),
    series("M065", 80), series("M066", 20), series("M064", 1, "%"), series("M058.nature", 138.02), series("M058.internal", 24)
  ] } };
  return { query, metricIds: data.data.series.map(item => item.metric.id), state: { status: "success", data, refreshing: false, refreshError: null }, platformName: "PH", canExport: true, retry() {}, controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}
function payload(live: LiveDashboardReading) {
  if (live.state.status !== "success") throw new Error("expected successful fixture");
  return live.state.data;
}

test("付费新老结构只读既有独立切片，主值详情与导出不串为总体", () => {
  const live = reading();
  for (const [id, value, unit] of [["M058", 141.02, "元"], ["M059", 3, "人"], ["M067", 47.00666666666667, "元/人"]] as const) {
    const rows = paymentDimensionRows(live, id, "新老用户");
    expect(rows.map(row => [row.name, row.value, row.seriesId])).toEqual([["新用户", value, id + ".new"], ["老用户", null, id + ".old"]]);
    expect(paymentDimensionUnit(live, id, "新老用户")).toBe(unit);
    const scoped = connectedDimensionReading(live, rows[0].seriesId);
    expect(payload(scoped).data.series.map(item => item.metric.id)).toEqual([id + ".new"]);
    const model = liveMetricModel({ metric: { id: rows[0].seriesId, name: "新用户", definitionLabel: "", aggregationLabel: "" }, result: { status: "no_values", contextLabel: "", retryable: false } }, scoped);
    expect(model.result.status === "available" && model.result.value.raw).toBe(value);
    const sheet = paymentDimensionSheet(live, id, "新老用户");
    expect(sheet.rows[3].slice(3, 7)).toEqual(["新用户", "2020-01-01", value, unit]);
    expect(sheet.rows[4][5]).toBeNull();
  }
  expect(paymentDimensionRows(live, "M067", "新老用户")[0].calculation).toMatchObject({ numerator: { value: 141.02, unit: "元" }, denominator: { value: 3, unit: "人" } });
});

test("商品只接既有VIP金币金额，渠道不冒用自然内部，付费率不冒用新增率", () => {
  const live = reading();
  expect(paymentDimensionRows(live, "M058", "商品").map(row => [row.seriesId, row.value])).toEqual([["M065", 80], ["M066", 20]]);
  for (const [id, group] of [["M058", "来源渠道"], ["M058", "客户端平台"], ["M058", "支付方式"], ["M058", "平台 × 新老用户"], ["M061", "新老用户"], ["M104", "新老用户"], ["M105", "新老用户"], ["M059", "商品"], ["M067", "商品"]]) {
    expect(paymentDimensionSupported(id, group)).toBe(false);
    expect(paymentDimensionRows(live, id, group)).toEqual([]);
    expect(JSON.stringify(paymentDimensionSheet(live, id, group))).toContain("待接入");
  }
});

test("缺失末日、非READY、零与零分母不被演示或历史值补齐", () => {
  const live = reading(), point = payload(live).data.series.find(item => item.metric.id === "M058.new")!.points[0];
  point.value = 0; point.inputs[0].value = 0;
  expect(paymentDimensionRows(live, "M058", "新老用户")[0].value).toBe(0);
  for (const sourceStatus of ["PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"] as const) {
    point.sourceStatus = sourceStatus;
    expect(paymentDimensionRows(live, "M058", "新老用户")[0].value).toBeNull();
    expect(paymentDimensionSheet(live, "M058", "新老用户").rows[3][5]).toBeNull();
  }
  point.sourceStatus = "READY"; point.date = "2019-12-31";
  expect(paymentDimensionRows(live, "M058", "新老用户")[0]).toMatchObject({ value: null, state: "当日未返回" });
  const ratio = payload(live).data.series.find(item => item.metric.id === "M067.new")!.points[0];
  ratio.value = null; ratio.state = "zero_denominator"; ratio.inputs[1].value = 0;
  expect(paymentDimensionRows(live, "M067", "新老用户")[0]).toMatchObject({ value: null, state: "分母为0", calculation: { denominator: { value: 0 } } });
});

test("分组主值不跨日汇总，比较失败/刷新与错范围保留边界", () => {
  const live = reading(), data = payload(live);
  const prior = reading(), before = payload(prior);
  before.data.query = { ...before.data.query, dateRange: ["2019-12-31", "2019-12-31"] };
  before.data.series.forEach(item => { item.points[0].date = "2019-12-31"; item.points[0].value = 1; });
  live.comparison = { label: "上一期", query: before.data.query, state: prior.state };
  expect(paymentDimensionRows(live, "M058", "新老用户")[0]).toMatchObject({ value: 141.02, baseline: 1 });
  expect(paymentDimensionSheet(live, "M058", "新老用户").rows.map(row => row[4])).toContain("2019-12-31");
  live.comparison.state = { status: "failure", kind: "error", code: "FAILED", message: "失败" };
  expect(paymentDimensionRows(live, "M058", "新老用户")[0]).toMatchObject({ value: 141.02, baseline: null, baselineState: "读取失败" });
  if (live.state.status === "success") live.state.refreshError = { code: "FAILED", message: "失败" };
  expect(paymentDimensionRows(live, "M058", "新老用户")[0].freshness).toContain("保留上次查询结果");
  for (const query of [{ ...live.query, pid: "other" }, { ...live.query, boardId: "5.11" }, { ...live.query, dateRange: ["2020-01-02", "2020-01-02"] as [string, string] }]) {
    data.data.query = query;
    expect(paymentDimensionRows(live, "M058", "新老用户")[0].value).toBeNull();
    expect(connectedDimensionSeries(live, "M058.new")).toBeUndefined();
  }
});

test("既有付费维度入口与详情使用真实分支，保留原控制且不重建新老面板", async () => {
  await import("echarts/core");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://localhost/dashboards/public?board=5.10") } });
  try {
    const { BoardDimension } = await import("./ExtendedBoardPreview");
    const { PreviewMetricCard } = await import("./PreviewMetricCard");
    const live = reading();
    const render = (group: string) => renderToStaticMarkup(createElement(LiveDashboardContext.Provider, { value: live }, createElement(BoardDimension, {
      spec: { title: "付费结构", ids: ["M058"], groups: [group] }, view: { range: DEMO_RANGE, compared: false, mixed: false }, pending: false, open() {}
    })));
    const stage = render("新老用户");
    expect(stage).toContain("待验数"); expect(stage).toContain("主值 2020-01-01");
    expect(stage).toContain("付费结构分类比较"); expect(stage).toContain("查看同口径数据表");
    expect(stage).not.toContain("新老用户付费表现"); expect(stage).not.toContain("USD"); expect(stage).not.toContain("演示数据");
    const selected = connectedDimensionReading(live, "M058.new");
    const detail = renderToStaticMarkup(createElement(LiveDashboardContext.Provider, { value: selected }, createElement(PreviewMetricCard, {
      model: { metric: { id: "M058.new", name: "总充值金额 · 新用户", definitionLabel: "同范围独立真实结果", aggregationLabel: "PH" }, result: { status: "no_values", contextLabel: "真实查询", retryable: false } },
      open() {}, retry() {}, exportAction: createElement("button", null, "导出")
    })));
    expect(detail).toContain("141.02"); expect(detail).not.toContain("162.02"); expect(detail).toContain("总充值金额 · 新用户"); expect(detail).not.toContain("USD");
    expect(render("来源渠道")).toContain("真实分组待接入");
    const cross = render("平台 × 新老用户");
    expect(cross).toContain("付费结构二维交叉表"); expect(cross).not.toContain("付费结构分类比较");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});
