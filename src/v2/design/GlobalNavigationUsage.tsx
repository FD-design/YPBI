import { useRef, type ReactNode } from "react";
import { Chart } from "../../components/Chart";
import { Button } from "../../components/ui/Button";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { TrendRange, useTrendRange } from "../../components/ui/TrendRange";
import { CHART_PALETTE } from "../../theme/tokens";
import { DataOriginProvider } from "../components/DataOrigin";
import { StatePanel } from "../components/StatePanel";
import { CalculationEvidence } from "../features/dashboards/CalculationEvidence";
import { MetricSummary } from "../features/dashboards/MetricSummary";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { changeDirection } from "../../components/ui/change-presentation";
import type { DashboardMetricComparison } from "../features/dashboards/dashboard-metric-card-model";
import { demoDates, demoRangeLabel } from "./extended-board-model";
import { downloadPreviewWorkbook } from "./preview-workbook";
import { GLOBAL_NAVIGATION_MARKER, NAVIGATION_MEASURES, navigationBasis, navigationFormat, navigationReading, navigationSheets, type NavigationMeasure, type NavigationReading, type NavigationSnapshot, type NavigationView } from "./global-navigation-usage-model";
import "./global-navigation-usage.css";

type Props = { snapshot: NavigationSnapshot; state: NavigationView; pending: boolean; onChange: (state: NavigationView) => void; onRetry: (id: string) => void; onOpen: (title: string, content: ReactNode) => void };
const columns = <><th>点击用户数</th><th>点击次数</th><th>同范围活跃用户数</th><th>渗透率</th><th>使用者人均点击次数</th></>;
function cells(row: NavigationReading) { return <><td>{navigationFormat("users", row.users)}</td><td>{navigationFormat("clicks", row.clicks)}</td><td>{navigationFormat("active", row.active)}</td><td>{navigationFormat("penetration", row.penetration)}</td><td>{navigationFormat("frequency", row.frequency)}</td></>; }
const sample = (row: NavigationReading, measure: NavigationMeasure) => measure === "frequency"
  ? `点击次数 ${navigationFormat("clicks", row.clicks)} 次 / 点击用户数 ${navigationFormat("users", row.users)} 人`
  : measure === "penetration" ? `点击用户数 ${navigationFormat("users", row.users)} 人 / 同范围活跃用户数 ${navigationFormat("active", row.active)} 人` : "";
const scopeLabel = "整体";
function comparison(row: NavigationReading, prior: NavigationReading | undefined, measure: NavigationMeasure, before: string): DashboardMetricComparison | null {
  if (!prior) return null;
  const current = row[measure], previous = prior[measure];
  if (current === null || previous === null) return { status: "unavailable", label: "较对比周期", detail: "两期同范围结果或计算基数未完整产出，暂不比较。" };
  const delta = (current - previous) * (measure === "penetration" ? 100 : 1), unit = measure === "penetration" ? "个百分点" : NAVIGATION_MEASURES.find(item => item.id === measure)!.unit;
  return { status: "available", label: "较对比周期", kind: measure === "penetration" ? "percentage_point" : "absolute", direction: changeDirection(delta), display: `${delta > 0 ? "+" : ""}${delta.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${unit}`, detail: `${before} · ${scopeLabel}`, rows: [{ label: "当前期", date: "所选周期", value: navigationFormat(measure, current) }, { label: "对比期", date: before, value: navigationFormat(measure, previous) }] };
}

export function GlobalNavigationUsage({ snapshot, state, pending, onChange, onRetry, onOpen }: Props) {
  const current = snapshot.periods[0], previous = snapshot.periods[1], detail = useRef<HTMLDivElement>(null);
  const rows = current.summary, selected = rows.find(row => row.tabId === state.selected);
  const prior = selected ? navigationReading(previous, selected.tabId) : undefined;
  const metric = NAVIGATION_MEASURES.find(item => item.id === state.measure)!;
  const dates = demoDates(current.range), zoom = useTrendRange(dates), visibleDates = dates.slice(zoom.start, zoom.end + 1);
  const previousDates = previous ? demoDates(previous.range) : [];
  const daily = new Map(current.daily.map(row => [`${row.tabId}|${row.date}`, row]));
  const before = new Map(previous?.daily.map(row => [`${row.tabId}|${row.date}`, row]) ?? []);
  const at = (date: string, comparison = false) => (comparison ? before : daily).get(`${state.selected}|${date}`);
  const hasTrend = dates.some((date, index) => at(date)?.[state.measure] != null || at(previousDates[index], true)?.[state.measure] != null);
  const exported = navigationSheets(snapshot.periods);
  const exportAction = <PreviewExportControl name="全局导航" scope="导出全部Tab的整体结果、完整逐日明细和已启用的对比期，不受导航选择或日期缩放裁剪。" context={`隔离演示数据 · ${scopeLabel} · 正式Tab目录、身份分母与查询待验数`} pending={pending} onDownloadPreview={() => downloadPreviewWorkbook("全局导航", [{ name: "00_导出说明", rows: [["数据来源", "隔离合成导航点击事实，不代表正式业务名单或数据接入"], ["当前范围", scopeLabel], ["指标引用", "M052；点击次数、点击用户、活跃用户为计算输入，不创建新指标ID"], ["渗透率", "点击用户数 ÷ 同范围活跃用户数 × 100%"], ["使用者人均点击次数", "点击次数 ÷ 点击用户数；零分母为空值"], ["周期规则", "人数在各自范围去重；各Tab用户可重叠，整体人数独立读取"], ["边界", "不含默认首页自动进入，不含导航广告、视频分类Tab或用户明细"]] }, ...exported])} />;
  const select = (id: string) => { onChange({ ...state, selected: id }); requestAnimationFrame(() => detail.current?.scrollIntoView({ block: "start" })); };
  const showPoint = (date: string) => onOpen(`导航趋势读数 · ${date}`, <><p>{selected?.name} · {scopeLabel}</p>{[{ label: "当前期", date, row: at(date) }, ...(previous ? [{ label: "对比期", date: previousDates[dates.indexOf(date)], row: at(previousDates[dates.indexOf(date)], true) }] : [])].map(period => <section key={period.label}><h3>{period.label} · {period.date}</h3><p>{metric.name} {navigationFormat(state.measure, period.row?.[state.measure] ?? null)} {state.measure === "penetration" ? "" : metric.unit} · {period.row?.status ?? "未产出"}</p>{period.row && <><p>{sample(period.row, state.measure)}</p>{navigationBasis(period.row, state.measure, `${selected?.name} · ${scopeLabel} · ${period.date}`) && <CalculationEvidence basis={navigationBasis(period.row, state.measure, `${selected?.name} · ${scopeLabel} · ${period.date}`)} />}</>}</section>)}</>);
  return <DataOriginProvider value="demo"><DashboardPanel title="全局导航" guidanceKey="function.navigation" className="global-navigation-usage" note={`${demoRangeLabel(current.range)} · 各底部Tab独立统计 · 正式目录与同口径分母待验数`}>
    <div data-preview={GLOBAL_NAVIGATION_MARKER}>
      <div className="global-navigation-usage__toolbar"><p className="dashboard-table-context">{scopeLabel} · 全部底部Tab</p>{exportAction}</div>
      <PaginatedTable label="全局导航使用结果" tableClassName="global-navigation-usage__table" columnCount={previous ? 9 : 8} head={<tr><th>导航</th>{columns}{previous && <th>渗透率变化（百分点）</th>}<th>状态</th><th>详情</th></tr>} rows={rows.map(row => {
        const previousRow = navigationReading(previous, row.tabId), delta = row.penetration !== null && previousRow?.penetration != null ? (row.penetration - previousRow.penetration) * 100 : null;
        return <tr key={row.tabId} data-navigation-id={row.tabId} className={state.selected === row.tabId ? "is-selected" : ""}><th scope="row"><Button variant="ghost" size="sm" aria-pressed={state.selected === row.tabId} onClick={() => select(row.tabId)}>{row.name}</Button></th>{cells(row)}{previous && <td>{delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`}</td>}<td>{row.status}</td><td>{row.status === "查询失败" ? <Button size="sm" onClick={() => onRetry(row.tabId)}>重试</Button> : <button type="button" onClick={() => select(row.tabId)}>查看趋势</button>}</td></tr>;
      })}/>
      <details className="global-navigation-usage__rules"><summary>计算口径</summary><p>渗透率 = 点击用户数 ÷ 同范围活跃用户数；使用者人均点击次数 = 点击次数 ÷ 点击用户数。人数按所选范围去重，人均不平均日值，分母为0显示“—”。各Tab用户可重叠，不合计渗透率。默认首页自动进入不计点击。</p></details>
      <div ref={detail} className="global-navigation-usage__detail">
        {!selected ? <StatePanel compact kind="empty" title="选择一个导航查看趋势" description="点击导航行，查看整体周期数值、使用变化和逐日明细。" /> : <>
          <div className="global-navigation-usage__detail-head"><h3>{selected.name} · 使用趋势</h3><SegmentedControl label="导航趋势指标" value={state.measure} onChange={measure => onChange({ ...state, measure: measure as NavigationMeasure })} options={NAVIGATION_MEASURES.map(item => ({ value: item.id, label: item.name }))}/></div>
          <div className="global-navigation-usage__summary" aria-label="所选导航周期摘要"><MetricSummary horizontal title={metric.name} context={`${demoRangeLabel(current.range)} · ${scopeLabel}`} value={navigationFormat(state.measure, selected[state.measure]).replace(/%$/, "")} unit={selected[state.measure] === null ? undefined : metric.unit} comparison={comparison(selected, prior, state.measure, previous ? demoRangeLabel(previous.range) : "")} note={<><span>{sample(selected, state.measure)}</span><span>{selected.status === "完整" && selected[state.measure] === null ? state.measure === "frequency" ? "点击用户基数为0，人均不可计算" : "活跃用户基数为0，渗透率不可计算" : selected.status}</span></>} supplementary={navigationBasis(selected, state.measure, `${selected.name} · ${scopeLabel} · ${demoRangeLabel(current.range)}`) ? <CalculationEvidence compact basis={navigationBasis(selected, state.measure, `${selected.name} · ${scopeLabel} · ${demoRangeLabel(current.range)}`)} /> : undefined}/></div>
          {hasTrend ? <><Chart theme="v13" ariaLabel="所选导航使用趋势" style={{ height: 280 }} onClick={params => { const date = visibleDates[(params as { dataIndex: number }).dataIndex]; if (date) showPoint(date); }} option={{ animation: false, grid: { left: 62, right: 24, top: 30, bottom: 35 }, tooltip: { trigger: "axis", formatter: (params: { dataIndex: number }[]) => {
            const index = zoom.start + (params[0]?.dataIndex ?? 0);
            return [{ label: "当前期", date: dates[index], row: at(dates[index]) }, ...(previous ? [{ label: "对比期", date: previousDates[index], row: at(previousDates[index], true) }] : [])].map(p => `${scopeLabel} · ${p.label} ${p.date}<br/>${metric.name} ${navigationFormat(state.measure, p.row?.[state.measure] ?? null)} · ${p.row?.status ?? "未产出"}${p.row && sample(p.row, state.measure) ? `<br/>${sample(p.row, state.measure)}` : ""}`).join("<br/><br/>");
          } }, xAxis: { type: "category", data: visibleDates, axisLabel: { hideOverlap: true, formatter: (date: string) => date.slice(5) } }, yAxis: { type: "value", name: metric.unit, min: 0, axisLabel: { formatter: (value: number) => state.measure === "penetration" ? `${(value * 100).toFixed(0)}%` : value.toLocaleString("zh-CN") } }, series: [{ name: "当前期", type: "line", connectNulls: false, showSymbol: visibleDates.length <= 7, data: visibleDates.map(date => at(date)?.[state.measure] ?? null), itemStyle: { color: CHART_PALETTE[0] } }, ...(previous ? [{ name: "对比期", type: "line", connectNulls: false, showSymbol: false, data: previousDates.slice(zoom.start, zoom.end + 1).map(date => at(date, true)?.[state.measure] ?? null), lineStyle: { type: "dashed" }, itemStyle: { color: CHART_PALETTE[0] } }] : [])] }}/><TrendRange dates={dates} values={dates.map(date => at(date)?.[state.measure] ?? null)} {...zoom} onChange={zoom.setRange}/></> : <StatePanel compact kind={selected.status === "查询失败" ? "error" : "empty"} title={selected.status === "完整" ? "当前范围没有可计算的趋势" : selected.status} description={selected.status === "完整" ? "计算分母为0；原始人数与次数仍保留，不将比例或人均填为0。" : "完整明细保留原状态，待结果就绪后重试。"} action={selected.status === "查询失败" ? { label: "重试", onClick: () => onRetry(selected.tabId) } : undefined} />}
          {previous && <p className="dashboard-table-context">实线：当前期；虚线：对比期 {demoRangeLabel(previous.range)}</p>}
          <ChartDataTable title="导航完整逐日数据" exportAction={exportAction}><p className="dashboard-table-context">保留所选Tab当前与对比周期的整体结果、计算基数及状态；覆盖完整日期。</p><PaginatedTable label="导航逐日计算输入" columnCount={8} head={<tr><th>周期</th><th>实际日期</th>{columns}<th>状态</th></tr>} rows={snapshot.periods.flatMap(p => p.daily.filter(row => row.tabId === state.selected).map(row => <tr key={`${p.label}|${row.date}`}><td>{p.label}</td><td>{row.date}</td>{cells(row)}<td>{row.status}</td></tr>))}/></ChartDataTable>
        </>}
      </div>
    </div>
  </DashboardPanel></DataOriginProvider>;
}
