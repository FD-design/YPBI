import { useState, type ReactElement } from "react";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { DataOriginProvider } from "../components/DataOrigin";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { ProductLink } from "../app/router";
import { WATCHING_OUTCOMES, summarizeWatchingOutcomes, type WatchingOutcomeRow, type WatchingWindow } from "./watching-retention-diagnosis-model";
import "./watching-retention-diagnosis.css";

export function WatchingRetentionDiagnosis({ rows, previous, window, onWindow, exportAction, href }: {
  rows: WatchingOutcomeRow[]; previous?: WatchingOutcomeRow[]; window: WatchingWindow;
  onWindow: (window: WatchingWindow) => void; exportAction: ReactElement; href: (board: string) => string;
}) {
  const summary = summarizeWatchingOutcomes(rows), baseline = previous ? summarizeWatchingOutcomes(previous) : null;
  const [selected, setSelected] = useState(0);
  const comparable = baseline && summary.complete === rows.length && baseline.complete === previous!.length && summary.rates && baseline.rates;
  const format = (value: number) => value.toLocaleString("zh-CN");
  return <DataOriginProvider value="demo"><DashboardPanel title="观影后用户去向" note={`首次有效观看日期 ${rows[0]?.date ?? "—"} 至 ${rows.at(-1)?.date ?? "—"} · ${summary.complete}/${rows.length} 批可用 · 未成熟或待加工批次不计入汇总`} tools={<SegmentedControl label="观影后观察周期" value={String(window)} onChange={value => onWindow(Number(value) as WatchingWindow)} options={[{ value: "1", label: "次日" }, { value: "3", label: "第3日" }, { value: "7", label: "第7日" }]} />}>
    <div className="watching-diagnosis">
      {summary.rates ? <>
        <div className="watching-diagnosis__bar" role="img" aria-label={WATCHING_OUTCOMES.map((label, i) => `${label} ${(summary.rates![i] * 100).toFixed(2)}%`).join("，")}>
          {summary.rates.map((rate, i) => <span key={i} className={`watching-diagnosis__segment is-${i}`} style={{ width: `${rate * 100}%` }} />)}
        </div>
        <div className="watching-diagnosis__outcomes" role="group" aria-label="用户去向分析">
          {WATCHING_OUTCOMES.map((label, i) => <button type="button" key={label} className={`watching-diagnosis__outcome is-${i}`} aria-pressed={selected === i} onClick={() => setSelected(i)}>
            <span><i aria-hidden="true" />{label}</span><strong>{(summary.rates![i] * 100).toFixed(2)}<small>%</small></strong><span>{format(summary.counts[i])} / {format(summary.base)} 人</span>
            {baseline && <small>{comparable ? `较对比期 ${((summary.rates![i] - baseline.rates![i]) * 100).toFixed(2)} 个百分点` : "观察覆盖不同，暂不比较"}</small>}
          </button>)}
        </div>
        <div className="watching-diagnosis__next" aria-live="polite">
          <strong>{selected === 0 ? "先检查渠道和首日体验" : selected === 1 ? "再检查内容承接、播放和付费门槛" : "继续观察后续留存"}</strong>
          <p>{selected === 0 ? "用户未回访，先对照来源渠道质量和首次启动体验，确认流量变化或体验异常。" : selected === 1 ? "用户已经回访，但观看未达到有效标准；可能没看，也可能只看了一小段，不能直接判断为内容差。" : "这一组与同周期有效观影留存使用相同用户批次和有效标准。"}</p>
          <nav aria-label="继续诊断">{(selected === 0 ? [["5.7", "渠道质量"], ["5.15", "启动与版本表现"]] : selected === 1 ? [["5.13", "内容发现与互动"], ["5.12", "播放与观看质量"], ["5.10", "会员与付费经营"]] : []).map(([board, label]) => <ProductLink key={board} href={href(board)}>{label}</ProductLink>)}</nav>
          {selected !== 2 && <small>跳转保留可支持的日期与业务平台；目标看板不自动限定为本区用户批次。相关变化用于排查，不直接判定原因。</small>}
        </div>
      </> : <div className="watching-diagnosis__empty"><strong>{summary.complete > 0 ? "当前完整批次用户基数为0，比例不可计算" : "当前范围暂无可汇总的用户批次"}</strong><p>{summary.complete > 0 ? "首次有效观看用户数及三类去向人数均为 0；完整空批次与未成熟、缺失分别记录。" : "请选择观察期已结束且结果完整的首次有效观看日期；未成熟和缺失不记为 0。"}</p></div>}
    </div>
    <ChartDataTable title="观影后用户去向同口径数据表" exportAction={exportAction}>
      <p className="dashboard-table-context">同一首次有效观看用户批次，三类互斥且合计等于基数。再次有效观看率＝再次有效观看人数 ÷ 首次有效观看用户数；与对应周期的有效观影留存一致。下表为独立演示数据，不由真实日活或注册留存拼算。</p>
      <PaginatedTable label="观影后用户去向明细" resetKey={JSON.stringify([rows, window])} columnCount={8} head={<tr><th>首次有效观看日期</th><th>首次有效观看用户数</th>{WATCHING_OUTCOMES.map(label => <th key={label}>{label}</th>)}<th>再次有效观看率</th><th>观察窗口结束</th><th>状态</th></tr>} rows={rows.map(row => <tr key={row.date}><td>{row.date}</td><td>{format(row.base)}</td>{[0, 1, 2].map(i => <td key={i}>{row.counts ? format(row.counts[i]) : "—"}</td>)}<td>{row.counts && row.base > 0 ? (row.counts[2] / row.base * 100).toFixed(2) + "%" : "—"}</td><td>{row.availableAt}</td><td>{row.status}</td></tr>)} />
    </ChartDataTable>
  </DashboardPanel></DataOriginProvider>;
}
