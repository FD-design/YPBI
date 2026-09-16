import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardMetricStatusPresentation,
  dashboardTrendDomain,
  dashboardTrendPath,
  type DashboardMetricCardModel,
  type DashboardMetricTrendPoint
} from "./dashboard-metric-card-model.ts";

const metric = {
  id: "M016",
  name: "日活跃用户数",
  aggregationLabel: "7 个完整业务日日均",
  definitionLabel: "来自指标中心"
};

test("真实 0 仍是完整可用结果，不会被归入无记录", () => {
  const model: DashboardMetricCardModel = {
    metric,
    result: {
      status: "available",
      completeness: "complete",
      refresh: { status: "idle" },
      value: { raw: 0, display: "0", unit: "人" },
      comparison: null,
      trendKind: "line",
      trend: { current: [], comparison: null },
      validationLabel: "已验数",
      watermarkLabel: "数据完整至 2026-09-08"
    }
  };
  assert.deepEqual(dashboardMetricStatusPresentation(model), {
    label: "真实 0",
    description: "来源明确返回有效数值 0。",
    tone: "success"
  });
});

test("刷新失败保留旧结果与首次失败使用不同状态", () => {
  const stale: DashboardMetricCardModel = {
    metric,
    result: {
      status: "available",
      completeness: "complete",
      refresh: { status: "failed", source: "page", message: "网络暂时不可用", retryable: true },
      value: { raw: 10, display: "10", unit: "人" },
      comparison: null,
      trendKind: "line",
      trend: { current: [], comparison: null },
      validationLabel: "已验数",
      watermarkLabel: "旧结果完整至 2026-09-08"
    }
  };
  const failed: DashboardMetricCardModel = { metric, result: { status: "failed", contextLabel: "本次结果未确认", retryable: true } };
  assert.equal(dashboardMetricStatusPresentation(stale).label, "刷新失败，保留旧值");
  assert.equal(dashboardMetricStatusPresentation(failed).label, "单卡查询失败");
});

test("趋势缺失值会断开路径而不是连接或补 0", () => {
  const points: DashboardMetricTrendPoint[] = [
    { key: "1", label: "第 1 日", actualDate: "09-01", value: { raw: 10, display: "10 人", actualDate: "09-01" }, counterpart: null, differenceDisplay: null, state: "available", stateLabel: "可用" },
    { key: "2", label: "第 2 日", actualDate: "09-02", value: null, counterpart: null, differenceDisplay: null, state: "no_record", stateLabel: "无记录" },
    { key: "3", label: "第 3 日", actualDate: "09-03", value: { raw: 20, display: "20 人", actualDate: "09-03" }, counterpart: null, differenceDisplay: null, state: "available", stateLabel: "可用" }
  ];
  const domain = dashboardTrendDomain({ current: points, comparison: null });
  assert.deepEqual(domain, { min: 10, max: 20, spread: 10 });
  assert.equal(dashboardTrendPath(points, domain!), "M8.0,50.0 M232.0,10.0");
});

test("无有效趋势值时不生成伪造坐标域", () => {
  const points: DashboardMetricTrendPoint[] = [
    { key: "1", label: "第 1 日", actualDate: "09-01", value: null, counterpart: null, differenceDisplay: null, state: "no_record", stateLabel: "无记录" }
  ];
  assert.equal(dashboardTrendDomain({ current: points, comparison: null }), null);
});

test("柱状趋势坐标域包含 0，避免截断基线放大波动", () => {
  const points: DashboardMetricTrendPoint[] = [
    { key: "1", label: "第 1 日", actualDate: "09-01", value: { raw: 98, display: "98 人", actualDate: "09-01" }, counterpart: { raw: 96, display: "96 人", actualDate: "08-25" }, differenceDisplay: "+2 人", state: "available", stateLabel: "可用" },
    { key: "2", label: "第 2 日", actualDate: "09-02", value: { raw: 102, display: "102 人", actualDate: "09-02" }, counterpart: { raw: 100, display: "100 人", actualDate: "08-26" }, differenceDisplay: "+2 人", state: "available", stateLabel: "可用" }
  ];
  const comparison: DashboardMetricTrendPoint[] = [
    { key: "1", label: "第 1 日", actualDate: "08-25", value: { raw: 96, display: "96 人", actualDate: "08-25" }, counterpart: { raw: 98, display: "98 人", actualDate: "09-01" }, differenceDisplay: "+2 人", state: "available", stateLabel: "可用" },
    { key: "2", label: "第 2 日", actualDate: "08-26", value: { raw: 100, display: "100 人", actualDate: "08-26" }, counterpart: { raw: 102, display: "102 人", actualDate: "09-02" }, differenceDisplay: "+2 人", state: "available", stateLabel: "可用" }
  ];

  assert.deepEqual(dashboardTrendDomain({ current: points, comparison }, true), { min: 0, max: 102, spread: 102 });
  assert.deepEqual(dashboardTrendDomain({ current: points, comparison }), { min: 96, max: 102, spread: 6 });
});

test("当前期与对比期保持两条独立非等长序列", () => {
  const current: DashboardMetricTrendPoint[] = [
    { key: "c1", label: "第 1 日", actualDate: "09-01", value: { raw: 10, display: "10 人", actualDate: "09-01" }, counterpart: null, differenceDisplay: null, state: "available", stateLabel: "可用" },
    { key: "c2", label: "第 2 日", actualDate: "09-02", value: { raw: 20, display: "20 人", actualDate: "09-02" }, counterpart: null, differenceDisplay: null, state: "available", stateLabel: "可用" }
  ];
  const comparison: DashboardMetricTrendPoint[] = [
    { key: "p1", label: "第 1 日", actualDate: "08-20", value: { raw: 8, display: "8 人", actualDate: "08-20" }, counterpart: null, differenceDisplay: null, state: "available", stateLabel: "可用" },
    { key: "p2", label: "第 2 日", actualDate: "08-21", value: { raw: 12, display: "12 人", actualDate: "08-21" }, counterpart: null, differenceDisplay: null, state: "available", stateLabel: "可用" },
    { key: "p3", label: "第 3 日", actualDate: "08-22", value: { raw: 16, display: "16 人", actualDate: "08-22" }, counterpart: null, differenceDisplay: null, state: "available", stateLabel: "可用" }
  ];

  assert.equal(current.length, 2);
  assert.equal(comparison.length, 3);
  assert.equal(dashboardTrendPath(current, { min: 0, spread: 20 }).split(" ").length, 2);
  assert.equal(dashboardTrendPath(comparison, { min: 0, spread: 20 }).split(" ").length, 3);
  assert.equal(comparison[2].value?.actualDate, "08-22");
});

test("比率趋势使用真实波动范围，常量序列只在零跨度时建立安全域", () => {
  const ratioPoints: DashboardMetricTrendPoint[] = [
    { key: "r1", label: "第 1 日", actualDate: "09-01", value: { raw: 0.76, display: "76.0 %", actualDate: "09-01" }, counterpart: null, differenceDisplay: null, state: "available", stateLabel: "可用" },
    { key: "r2", label: "第 2 日", actualDate: "09-02", value: { raw: 0.79, display: "79.0 %", actualDate: "09-02" }, counterpart: null, differenceDisplay: null, state: "available", stateLabel: "可用" }
  ];
  const ratioDomain = dashboardTrendDomain({ current: ratioPoints, comparison: null });
  assert.ok(ratioDomain);
  assert.ok(Math.abs(ratioDomain.spread - 0.03) < 1e-12);

  const constant = ratioPoints.map((point) => ({ ...point, value: point.value ? { ...point.value, raw: 0.78 } : null }));
  const constantDomain = dashboardTrendDomain({ current: constant, comparison: null });
  assert.ok(constantDomain && constantDomain.spread > 0);
  assert.ok(constantDomain.min < 0.78 && constantDomain.max > 0.78);
});
