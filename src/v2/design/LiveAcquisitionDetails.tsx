import type { ReactNode } from "react";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { ACQUISITION_GROUP_LIMIT, acquisitionGroupInputs, acquisitionGroupValue, type AcquisitionLiveGroupRow, type AcquisitionGroupModel } from "./live-acquisition-groups";

export function LiveAcquisitionMetricHint({ row, id }: { row: AcquisitionLiveGroupRow; id: string }) {
  const periods = [{ label: "当前期", reading: row.current[id] }, ...(row.previous ? [{ label: "对比期", reading: row.previous[id] }] : [])];
  return <>{periods.map(({ label, reading }) => `${label}：${acquisitionGroupValue(reading.metric, reading.summary.value)} · ${reading.summary.state}\n${reading.summary.date}`).join("\n")}{"\n点击查看汇总和逐日依据"}</>;
}

export function LiveAcquisitionMetricDetails({ row, id, exportAction }: { row: AcquisitionLiveGroupRow; id: string; exportAction?: ReactNode }) {
  const periods = [{ label: "当前期", reading: row.current[id] }, ...(row.previous ? [{ label: "对比期", reading: row.previous[id] }] : [])];
  return <div className="channel-quality__reading"><p>{row.current[id].metric.definition}</p><div className="channel-quality__reading-summary">{periods.map(({ label, reading }) => <section key={label}><span>{label}</span><strong>{acquisitionGroupValue(reading.metric, reading.summary.value)}</strong><small>{reading.summary.date}</small><span>{reading.summary.state} · {reading.summary.freshness}</span><small>{acquisitionGroupInputs(reading.summary)}</small><small>规则版本：{reading.summary.ruleVersion ?? "未返回"}</small><small>数据至：{reading.summary.watermark ?? "未返回"}</small></section>)}</div><p className="channel-quality__scope">区间值直接读取同一查询的后端汇总；逐日结果单独保留，不累加人数、IP 或比率。{ACQUISITION_GROUP_LIMIT}</p>
    <PaginatedTable label="分组指标逐日依据" columnCount={7} head={<tr><th>周期</th><th>业务日期</th><th>结果</th><th>实际输入</th><th>状态</th><th>规则版本</th><th>数据至</th></tr>} rows={periods.flatMap(({ label, reading }) => reading.points.map(point => <tr key={`${label}-${point.date}`}><td>{label}</td><td>{point.date}</td><td>{acquisitionGroupValue(reading.metric, point.value)}</td><td>{acquisitionGroupInputs(point)}</td><td>{point.state} · {point.freshness}</td><td>{point.ruleVersion ?? "未返回"}</td><td>{point.watermark ?? "未返回"}</td></tr>))} />{exportAction}</div>;
}

export function LiveAcquisitionAllDetails({ model, rows = model.rows, exportAction }: { model: AcquisitionGroupModel; rows?: AcquisitionLiveGroupRow[]; exportAction?: ReactNode }) {
  return <div className="channel-quality__reading"><p>{model.unavailableReason ?? ACQUISITION_GROUP_LIMIT}</p><PaginatedTable label="渠道质量全部结果" columnCount={8} head={<tr><th>分组</th><th>指标</th><th>周期</th><th>日期区间</th><th>结果</th><th>实际输入</th><th>状态</th><th>规则版本</th></tr>} rows={rows.flatMap(row => model.ids.flatMap(id => [{ label: "当前期", reading: row.current[id] }, ...(row.previous ? [{ label: "对比期", reading: row.previous[id] }] : [])].map(({ label, reading }) => <tr key={JSON.stringify([row.key, id, label])}><td>{row.name}</td><td>{reading.metric.name}</td><td>{label}</td><td>{reading.summary.date}</td><td>{acquisitionGroupValue(reading.metric, reading.summary.value)}</td><td>{acquisitionGroupInputs(reading.summary)}</td><td>{reading.summary.state} · {reading.summary.freshness}</td><td>{reading.summary.ruleVersion ?? "未返回"}</td></tr>)))} />{exportAction}</div>;
}
