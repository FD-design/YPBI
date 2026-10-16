import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess, DailyPoint } from "../../../contracts/daily-dashboard";
import { Chart } from "../../components/Chart";
import { CompositionChart } from "../features/dashboards/CompositionChart";
import { LiveDashboardContext, type LiveDashboardReading, type LiveSeries } from "../features/dashboards/LiveDashboardContext";
import { IncomeComposition, NewOldPayment } from "./PaymentBreakdowns";
import { connectedPaymentSnapshot } from "./connected-payment-data";

const date = "2020-01-01", previousDate = "2019-12-31";
const range = { start: date, end: date };

function metric(id: string, value: number | null, day = date): LiveSeries {
  const users = id.startsWith("M059"), average = id.startsWith("M067"), unit = users ? "人" : average ? "元/人" : "元";
  const inputs = average ? [{ key: "amount", name: "充值金额", unit: "元" }, { key: "users", name: "付费用户数", unit: "人" }]
    : [{ key: "value", name: "实际结果", unit }];
  return { metric: { id, referenceMetricId: id.split(".")[0], name: id, unit, definition: "同日同PID同人群真实结果", authorityVersion: "composition-state-fixture",
    formula: average ? "充值金额 ÷ 付费用户数" : null, sourceNote: null, inputs },
    points: [{ date: day, value, state: value === null ? "no_value" : "available", sourceStatus: value === null ? "SOURCE_INCOMPLETE" : "READY",
      inputs: inputs.map((input, index) => ({ key: input.key, value: average ? index === 0 ? null : id.endsWith(".new") ? 3 : 5 : value })) }] };
}

function fixture(day = date) {
  const series = [metric("M058", null, day), metric("M058.new", null, day), metric("M059", 5, day), metric("M059.new", 3, day),
    metric("M067", null, day), metric("M067.new", null, day), metric("M065", null, day), metric("M066", 0, day)];
  const result: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v1", query: { boardId: "5.10", pid: "PH", dateRange: [day, day] },
    queryId: "composition-state", fetchedAt: "2026-10-16T02:13:58Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null,
    sourceApiIds: ["/api/admin/bi/v1/metrics"], series } };
  const live: LiveDashboardReading = { query: result.data.query, metricIds: series.map(item => item.metric.id),
    state: { status: "success", data: result, refreshing: false, refreshError: null }, platformName: "PH测试平台", canExport: false, retry() {},
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
  const point = (id: string) => series.find(item => item.metric.id === id)!.points[0];
  return { live, result, series, point };
}

function renderPayment(component: typeof NewOldPayment | typeof IncomeComposition, live: LiveDashboardReading | null, incomplete = false) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1440 } });
  try {
    return renderToStaticMarkup(React.createElement(LiveDashboardContext.Provider, { value: live }, React.createElement(component, { range, compared: Boolean(live?.comparison), incomplete, onOpen() {} })));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window");
  }
}

function compositionSection(html: string, title: string) {
  const section = html.match(new RegExp(`<section class="composition-chart" aria-label="${title}">([\\s\\S]*?)</section>`))?.[1];
  if (!section) throw new Error(`缺少构成区块：${title}`);
  return section;
}

function listItem(html: string, label: string) {
  const item = [...html.matchAll(/<button[^>]*role="listitem"[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes(`>${label}</span>`));
  if (!item) throw new Error(`缺少分类：${label}`);
  return item;
}

function elements(node: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
  return [node as React.ReactElement<Record<string, unknown>>, ...elements(node.props.children)];
}

function compositionTree(props: React.ComponentProps<typeof CompositionChart>) {
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H;
  internals.H = { useState: (initial: unknown) => [initial, () => {}] };
  try { return CompositionChart(props); } finally { internals.H = previous; }
}

describe("付费构成沿用同次真实来源状态", () => {
  test("快照分别返回金额、人数和ARPPU的实际状态，不把来源不完整改为未产出", () => {
    const { live } = fixture();
    expect(connectedPaymentSnapshot(live)).toEqual({ amount: null, users: 5, arppu: null, states: { amount: "来源不完整", users: "已返回", arppu: "来源不完整" } });
    expect(connectedPaymentSnapshot(live, "stage", "new")).toEqual({ amount: null, users: 3, arppu: null, states: { amount: "来源不完整", users: "已返回", arppu: "来源不完整" } });
    expect(connectedPaymentSnapshot(live, "stage", "old")).toMatchObject({ amount: null, users: null, arppu: null, states: { amount: "切片待接入", users: "切片待接入", arppu: "切片待接入" } });
  });

  test("快照区分加工、传输、成熟、空记录和缺字段，真实0仍为已返回", () => {
    const { live, point } = fixture(), target = point("M058");
    const states: { sourceStatus?: DailyPoint["sourceStatus"]; state: DailyPoint["state"]; label: string }[] = [
      { sourceStatus: "SOURCE_INCOMPLETE", state: "no_value", label: "来源不完整" },
      { sourceStatus: "PROCESSING", state: "no_value", label: "计算中" },
      { sourceStatus: "NOT_MATURE", state: "immature", label: "待成熟" },
      { sourceStatus: "FAILED", state: "source_failure", label: "加工失败" },
      { state: "source_failure", label: "读取失败" }, { state: "no_record", label: "当日未返回记录" },
      { state: "invalid_value", label: "数据异常" }, { state: "no_value", label: "字段未返回" }
    ];
    for (const state of states) {
      Object.assign(target, { value: null, state: state.state, sourceStatus: state.sourceStatus });
      expect(connectedPaymentSnapshot(live)).toMatchObject({ amount: null, users: 5, states: { amount: state.label, users: "已返回" } });
    }
    Object.assign(target, { value: 0, state: "available", sourceStatus: "READY" });
    expect(connectedPaymentSnapshot(live)).toMatchObject({ amount: 0, states: { amount: "已返回" } });
    target.date = previousDate;
    expect(connectedPaymentSnapshot(live).amount).toBeNull();
    expect(connectedPaymentSnapshot(live).states.amount).toBe("当日未返回记录");
    live.state = { status: "loading" };
    expect(connectedPaymentSnapshot(live).states.amount).toBe("读取中");
    live.state = { status: "failure", kind: "error", code: "UPSTREAM_TIMEOUT", message: "读取失败" };
    expect(connectedPaymentSnapshot(live).states.amount).toBe("读取失败");
  });

  test("当前与对比使用各自日期状态，错PID结果不流入当前快照", () => {
    const current = fixture(), prior = fixture(previousDate);
    Object.assign(prior.point("M058"), { state: "source_failure", sourceStatus: "FAILED" });
    Object.assign(prior.point("M058.new"), { state: "no_value", sourceStatus: "PROCESSING" });
    current.live.comparison = { label: "上一期", query: prior.live.query, state: prior.live.state };
    expect(connectedPaymentSnapshot(current.live).states.amount).toBe("来源不完整");
    expect(connectedPaymentSnapshot(current.live, undefined, undefined, previousDate, true).states.amount).toBe("加工失败");
    expect(connectedPaymentSnapshot(current.live, "stage", "new", previousDate, true).states.amount).toBe("计算中");
    expect(connectedPaymentSnapshot(current.live, undefined, undefined, date, true).amount).toBeNull();
    Object.assign(current.point("M058"), { value: 123, state: "available", sourceStatus: "READY" });
    current.result.data.query = { ...current.result.data.query, pid: "OTHER" };
    expect(connectedPaymentSnapshot(current.live).amount).toBeNull();
  });

  test("真实新老构成显示各分类和对比期状态，覆盖不足时不画环图或计算占比", () => {
    const current = fixture(), prior = fixture(previousDate);
    Object.assign(prior.point("M058.new"), { state: "source_failure", sourceStatus: "FAILED" });
    current.live.comparison = { label: "上一期", query: prior.live.query, state: prior.live.state };
    let section = compositionSection(renderPayment(NewOldPayment, current.live), "充值金额构成");
    expect(listItem(section, "新用户")).toContain("<b>来源不完整</b>");
    expect(listItem(section, "新用户")).toContain("对比期 加工失败");
    expect(listItem(section, "老用户")).toContain("<b>切片待接入</b>");
    expect(section).toContain('class="composition-chart__state" role="status">总充值金额：来源不完整；');
    expect(section).not.toContain("未产出");
    expect(section).not.toContain('class="composition-chart__center"');
    expect(section).not.toContain("占比 100.00%");
    for (const id of ["M058", "M058.new"]) Object.assign(current.point(id), { value: 100, state: "available", sourceStatus: "READY" });
    section = compositionSection(renderPayment(NewOldPayment, current.live), "充值金额构成");
    expect(listItem(section, "新用户")).toContain("100.00 元");
    expect(listItem(section, "老用户")).toContain("切片待接入");
    expect(section).not.toContain("占比 100.00%");
    expect(section).not.toContain('class="composition-chart__center"');
    for (const id of ["M058", "M058.new"]) Object.assign(current.point(id), { value: 0 });
    expect(listItem(compositionSection(renderPayment(NewOldPayment, current.live), "充值金额构成"), "新用户")).toContain("0.00 元");
  });

  test("商品真实区显示VIP空记录和金币真实0，分端演示保留独立状态与USD", () => {
    const { live, point } = fixture();
    Object.assign(point("M065"), { state: "no_record", sourceStatus: undefined });
    const html = renderPayment(IncomeComposition, live), product = compositionSection(html, "商品收入构成"), client = compositionSection(html, "分端收入构成");
    expect(listItem(product, "VIP")).toContain("<b>当日未返回记录</b>");
    expect(listItem(product, "金币")).toContain("<b>0.00 元</b>");
    expect(product).toContain('class="composition-chart__state" role="status">总充值金额：来源不完整；');
    expect(product).not.toContain("未产出");
    expect(product).not.toContain('class="composition-chart__center"');
    expect(client).toContain("USD");
    expect(client).toContain("合成演示数据");
    expect(client).not.toContain("来源不完整");
    expect(client).not.toContain("当日未返回记录");
    for (const id of ["M058", "M065", "M066"]) Object.assign(point(id), { value: 0, state: "available", sourceStatus: "READY" });
    const zero = compositionSection(renderPayment(IncomeComposition, live), "商品收入构成");
    expect(zero).toContain("总体为0，不计算占比");
    expect(zero).not.toContain("NaN");
    expect(zero).not.toContain("Infinity");
  });

  test("共享构成图的提示、列表和点击详情保持同一个来源状态", () => {
    let opened: { title: string; content: React.ReactNode } | undefined;
    const props: React.ComponentProps<typeof CompositionChart> = { title: "真实构成", totalLabel: "总充值金额", total: null, totalState: "来源不完整", scope: `${date} · PH`, unit: "元", complete: false,
      items: [{ id: "new", label: "新用户", color: "#2563eb", value: null, state: "来源不完整", comparison: null, comparisonState: "加工失败" },
        { id: "old", label: "老用户", color: "#f59e0b", value: null, state: "切片待接入" }], onOpen: (title, content) => { opened = { title, content }; } };
    const tree = compositionTree(props), nodes = elements(tree), chart = nodes.find(node => node.type === Chart)!;
    const option = chart.props.option as { tooltip: { formatter: (params: { dataIndex: number }) => string }; series: { type: string }[] };
    expect(option.series[0].type).toBe("bar");
    expect(option.tooltip.formatter({ dataIndex: 0 })).toContain("来源不完整");
    expect(option.tooltip.formatter({ dataIndex: 1 })).toContain("切片待接入");
    (chart.props.onClick as (params: { dataIndex: number }) => void)({ dataIndex: 0 });
    expect(opened?.title).toBe("真实构成 · 新用户");
    expect(renderToStaticMarkup(opened!.content)).toContain("来源不完整");
    expect(renderToStaticMarkup(opened!.content)).not.toContain("未产出");
    const button = nodes.find(node => node.type === "button" && elements(node.props.children as React.ReactNode).some(child => child.type === "b" && child.props.children === "切片待接入"))!;
    (button.props.onClick as () => void)();
    expect(opened?.title).toBe("真实构成 · 老用户");
    expect(renderToStaticMarkup(opened!.content)).toContain("切片待接入");
    const html = renderToStaticMarkup(React.createElement(CompositionChart, props));
    expect(html).toContain('class="composition-chart__state" role="status">总充值金额：来源不完整；');
    expect(html).toContain("对比期 加工失败");
    expect(html).not.toContain("未产出");
  });

  test("共享组件未传状态时沿用未产出，演示缺分类不继承真实来源状态", () => {
    const html = renderToStaticMarkup(<CompositionChart title="原构成" totalLabel="总体" total={null} scope="演示范围" unit="USD" complete={false}
      items={[{ id: "vip", label: "VIP", color: "#2563eb", value: null, comparison: null }]} onOpen={() => {}} />);
    expect(html).toContain("<b>未产出</b>");
    expect(html).toContain("对比期 未产出");
    const demo = compositionSection(renderPayment(IncomeComposition, null, true), "商品收入构成");
    expect(listItem(demo, "VIP")).toContain("<b>未产出</b>");
    expect(demo).toContain("USD");
    expect(demo).not.toContain("来源不完整");
  });
});
