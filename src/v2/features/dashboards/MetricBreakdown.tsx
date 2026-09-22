import type { DashboardMetricCardModel } from "./dashboard-metric-card-model";
import { MetricReadingDialog } from "./MetricReadingDialog";
import "./metric-breakdown.css";
import { DataOriginBadge, DataOriginProvider } from "../../components/DataOrigin";

export type BreakdownValue = { status: "available"; raw: number; display: string; sample?: string; origin?: "pending" | "demo" }
  | { status: "unsupported" | "immature" | "no_record"; label: string; reason: string };
export interface MetricBreakdownGroup { id: string; title: string; note?: string; rows: { key: string; label: string; value: BreakdownValue }[] }
export interface MetricBreakdownModel { metric: DashboardMetricCardModel; context: string; unit: string; ratio: boolean; groups: MetricBreakdownGroup[]; sampleOnly?: boolean }

export function MetricBreakdown({ model, onClose }: { model: MetricBreakdownModel; onClose: () => void }) {
  const result = model.metric.result;
  return <MetricReadingDialog title={`${model.metric.metric.name} · 维度拆解`} onClose={onClose} content={<div className="metric-breakdown">
    <div className="metric-breakdown__summary">
      <p>{model.context}</p>
      {model.sampleOnly && <p>固定视觉样例 · 用于体验拆解交互，非业务数据</p>}
      <span>整体</span>
      {result.status === "available" ? <div><strong>{result.value.display}</strong><span>{result.value.unit}</span></div> : <div><strong className="metric-breakdown__status">{result.label}</strong><p>{result.message}</p></div>}
    </div>
    {model.groups.map(group => {
      const max = model.ratio ? 1 : Math.max(1, ...group.rows.map(row => row.value.status === "available" ? row.value.raw : 0));
      const missing = group.rows.filter(row => row.value.status !== "available");
      return <section className="metric-breakdown__group" key={group.id} aria-label={group.title}>
        <header><h3>{group.title}</h3><span>{model.ratio ? "0–100%" : `单位：${model.unit}`}</span></header>
        {missing.length === group.rows.length && <p className="metric-breakdown__notice">{missing.every(row => row.value.status === "immature") ? "观察窗口尚未结束，成熟后展示结果。" : "此维度暂无可用结果，以下保留各项状态。"}</p>}
        <ul>{group.rows.map(row => <li key={row.key}>
          <div className="metric-breakdown__row"><span>{row.label}{row.value.status === "available" && row.value.origin && <DataOriginProvider value={row.value.origin}><DataOriginBadge /></DataOriginProvider>}</span>
            {row.value.status === "available" ? <div className="metric-breakdown__track" aria-hidden="true"><div style={{ width: `${Math.min(100, Math.max(0, row.value.raw / max * 100))}%` }} /></div> : <span />}
            <span>{row.value.status === "available" ? <><b>{row.value.display}</b><small>{model.unit}</small></> : <b className="metric-breakdown__status">{row.value.label}</b>}</span></div>
          {row.value.status === "available" ? <>
            {row.value.sample && <p>{row.value.sample}</p>}
          </> : null}
        </li>)}</ul>
        {(group.note || missing.length > 0) && <details className="metric-breakdown__notes"><summary>数据说明</summary>{group.note && <p>{group.note}</p>}{[...new Set(missing.map(row => row.value.status !== "available" ? row.value.reason : ""))].map(reason => <p key={reason}>{reason}</p>)}</details>}
      </section>;
    })}
    <p className="metric-breakdown__boundary">各维度分别统计，不相加或推算交叉结果。{model.ratio ? "每项为该组自身的比率，不是占整体的份额。" : "跨客户端用户可能重复，不用端别之和替代整体人数。"}</p>
  </div>} />;
}
