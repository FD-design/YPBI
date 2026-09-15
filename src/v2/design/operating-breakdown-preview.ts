import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import type { MetricBreakdownModel, BreakdownValue } from "../features/dashboards/MetricBreakdown";
import { summaryColumn } from "./operating-detail-columns";

const clients = { id: "platform", title: "按客户端平台", slices: ["Android", "iOS"], note: "分别统计各客户端，不将差额归入其他平台。" };
const users = { id: "user-stage", title: "按新老用户", slices: ["新用户", "老用户"], note: "按数据日的账号注册身份划分。" };
const acquisition = { id: "acquisition", title: "按获客类型", slices: ["自然新增", "内部导量"], note: "按注册时归因查看；所列类型不一定覆盖全部来源。" };
export const OPERATING_BREAKDOWNS: Record<string, typeof clients[]> = {
  M016: [users, clients], M026: [users, clients], M081: [users, clients],
  M008: [clients, acquisition],
  M020: [{ ...clients, title: "按注册时客户端", note: "按注册时客户端分组；次日返访允许跨客户端。" }, { ...acquisition, title: "按注册时获客类型" }],
  M058: [{ id: "new-users", title: "新用户范围", slices: ["新用户"], note: "只统计注册当日充值。" }, { ...acquisition, title: "新用户充值按获客类型", note: "自然新增与内部导量是新用户的来源切片，不能与新用户值相加。" }],
  ...Object.fromEntries(["M059", "M061", "M067", "M111"].map(id=>[id,[{ id: "new-users", title: "新用户范围", slices: ["新用户"], note: id === "M061" ? `引用${summaryColumn("M064").metric.name}：${summaryColumn("M064").metric.definition}` : "仅查看本表已登记的新用户视图；不推算老用户结果。" }]]))
};
export function operatingDimensionLabel(id: string) {
  return `${id === "M020" ? "注册时：" : ""}${(OPERATING_BREAKDOWNS[id] ?? []).map(group => group.id === "user-stage" ? "新/老用户" : group.slices.join("/")).join(" · ")}`;
}
export function operatingBreakdownModel(metric: DashboardMetricCardModel, context: string, read: (slice: string) => BreakdownValue): MetricBreakdownModel {
  const column = summaryColumn(metric.metric.id);
  return { metric, context, ratio: column.kind === "ratio", unit: column.unit,
    groups: (OPERATING_BREAKDOWNS[metric.metric.id] ?? []).map(group => ({ ...group, rows: group.slices.map(slice => ({ key: slice, label: slice, value: read(slice) })) })) };
}

/** Explicit, isolated visual examples. Never used as business-query fallback. */
export function galleryBreakdown(metric: DashboardMetricCardModel): MetricBreakdownModel {
  const id = metric.metric.id, column = summaryColumn(id), ratio = column.kind === "ratio";
  const facts: Record<string, Record<string, number[]>> = {
    M016: { "新用户": [50], "老用户": [110], Android: [100], iOS: [60] },
    M008: { Android: [30], iOS: [20], "自然新增": [25], "内部导量": [15] },
    M026: { "新用户": [36], "老用户": [90], Android: [80], iOS: [46] },
    M081: { "新用户": [36,50], "老用户": [90,110], Android: [80,100], iOS: [46,60] },
    M020: { Android: [12,30], iOS: [8,20], "自然新增": [10,25], "内部导量": [6,15] },
    M058: { "新用户": [1000], "自然新增": [500], "内部导量": [250] }, M059: { "新用户": [10] },
    M061: { "新用户": [10,50] }, M067: { "新用户": [100] }, M111: { "新用户": [20,50] }
  };
  const overall: Record<string, number> = { M016: 160, M008: 50, M026: 126, M081: 126 / 160, M020: .4, M058: 6400, M059: 32, M061: .2, M067: 200, M111: .5 };
  const model = { ...metric, metric: { ...metric.metric, aggregationLabel: "2026-09-07 · 当日值" }, result: { status: "available" as const, completeness: "complete" as const, refresh: { status: "idle" as const },
    value: { raw: overall[id], display: ratio ? (overall[id]*100).toFixed(2) : String(overall[id]), unit: column.unit },
    comparison: null, trendKind: "line" as const, trend: { current: [], comparison: null }, validationLabel: "固定视觉样例", watermarkLabel: "样例数据日 2026-09-07" } };
  return { ...operatingBreakdownModel(model, "数据日 2026-09-07 · 固定整体样例", slice => {
    const [numerator, denominator] = facts[id][slice];
    const raw = ratio ? numerator / denominator : numerator;
    return { status: "available", raw, display: ratio ? (raw*100).toFixed(2) : String(raw),
      sample: ratio ? `${id === "M020" ? "次日返访" : id === "M061" ? "付费" : id === "M111" ? "广告点击" : "观影"} ${numerator} 人 / ${["M020", "M061"].includes(id) ? "注册" : "活跃"} ${denominator} 人` : undefined };
  }), sampleOnly: true };
}
