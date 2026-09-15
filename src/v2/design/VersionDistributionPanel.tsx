import { Search } from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { Chart } from "../../components/Chart";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import { FloatingHint } from "../../components/ui/FloatingHint";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { CHART_PALETTE } from "../../theme/tokens";
import { DataOriginProvider } from "../components/DataOrigin";
import { StatePanel } from "../components/StatePanel";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { demoPrevious, demoRangeLabel } from "./extended-board-model";
import { VERSION_CLIENTS, versionQueryKeys, versionQueryLabel } from "./version-performance-model";
import { versionDistributionByName, type VersionDistributionValue } from "./version-performance-fixtures";
import type { VersionAnalysisDisplay, VersionPerformancePreviewProps } from "./VersionPerformancePreview";
import type { WorkbookSheet } from "./preview-workbook";

const percentage = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(2)}%`;
const labelFor = (value: VersionDistributionValue, active: boolean) => {
  const number = active ? value.activeUsers : value.launches;
  return number === null ? value.stateLabel : `${number.toLocaleString("zh-CN")} ${active ? "人" : "次"}`;
};

export function VersionDistributionPanel({ range, compared, mixed, view, onChange, exportAction, sheets, analysis }: VersionPerformancePreviewProps & { sheets: WorkbookSheet[]; analysis: VersionAnalysisDisplay }) {
  const [search, setSearch] = useState("");
  const keys = versionQueryKeys(view);
  const rows = useMemo(() => versionDistributionByName(keys, range, mixed), [keys.join("|"), range.start, range.end, mixed]);
  const previous = demoPrevious(range);
  const previousRows = useMemo(() => compared ? versionDistributionByName(keys, previous, mixed) : [], [keys.join("|"), previous.start, previous.end, mixed, compared]);
  const filtered = rows.filter(row => row.name.toLowerCase().includes(search.trim().toLowerCase()));
  const chartRows = filtered.slice(0, 12);
  const active = view.distribution === "active_users";
  const grouped = analysis.mode === "groups";
  const clients = VERSION_CLIENTS.filter(client => analysis.clients.includes(client.id));
  const valueOf = (value: VersionDistributionValue) => active ? value.activeUsers : value.launches;
  const shareOf = (value: VersionDistributionValue) => active ? value.activeShare : value.launchShare;
  const height = Math.max(280, Math.min(580, chartRows.length * (grouped && active && clients.length > 1 ? 54 : 42) + 74));
  const summaryValueLabel = active ? "活跃人数" : "启动次数";
  const scope = versionQueryLabel(view);
  const context = active ? `${range.end} 日值 · ${scope}` : `${demoRangeLabel(range)} 累计 · ${scope}`;
  const hasChartData = chartRows.some(row => (grouped ? clients.map(client => row.byClient[client.id]) : [row.overall]).some(value => valueOf(value) !== null));
  const cell = (value: VersionDistributionValue) => <>
    {valueOf(value) === null ? <span className="version-performance__distribution-share">{labelFor(value, active)}</span> : <strong>{labelFor(value, active)}</strong>}
    {valueOf(value) !== null && <span className="version-performance__distribution-share">{percentage(shareOf(value))}</span>}
    {value.state === "partial" && <span className="version-performance__distribution-state">{value.stateLabel}</span>}
  </>;
  const description = active
    ? "版本使用率 = 该版本活跃人数 ÷ 同范围全部版本的独立日活人数。分端列使用各自客户端分母；总体跨端去重，各端及各版本人数不可相加。"
    : "启动占比 = 该版本启动次数 ÷ 同范围全部版本启动次数。分端列使用各自客户端分母；隐藏客户端不重算占比。";
  const series = grouped ? clients.map(client => ({
    name: client.label, values: chartRows.map(row => valueOf(row.byClient[client.id])), color: CHART_PALETTE[client.id === "android" ? 0 : 1]
  })) : [{ name: "总体", values: chartRows.map(row => valueOf(row.overall)), color: CHART_PALETTE[0] }];
  const detailRows: ReactElement[] = [{ label: "当前期", range, rows }, ...(compared ? [{ label: "上一等长周期", range: previous, rows: previousRows }] : [])].flatMap(period => period.rows.flatMap(row => [
    { label: "总体", value: row.overall, keys: row.keys },
    ...VERSION_CLIENTS.map(client => ({ label: client.label, value: row.byClient[client.id], keys: row.clients[client.id] }))
  ].map(item => <tr key={`${period.label}:${row.name}:${item.label}`}>
    <td>{period.label}</td><td>{demoRangeLabel(period.range)}</td><td>{row.name}</td><td>{item.label}</td><td>{labelFor(item.value, false)}</td><td>{percentage(item.value.launchShare)}</td>
    <td>{labelFor(item.value, true)}</td><td>{item.value.activeDenominator?.toLocaleString("zh-CN") ?? "—"}</td><td>{percentage(item.value.activeShare)}</td>
    <td>{item.value.dataDate}</td><td>{item.value.stateLabel}</td>
  </tr>)));
  return <DataOriginProvider value="demo"><DashboardPanel title="版本分布" guidanceKey="version.distribution" chartKind="version-distribution" note={`${context} · 未知版本单列`} tools={<SegmentedControl label="版本分布指标" value={view.distribution} onChange={distribution => onChange({ ...view, distribution: distribution as typeof view.distribution })} options={[{ value: "active_users", label: "活跃人数" }, { value: "launches", label: "启动次数" }]} />}>
    {(rows.length > 8 || search) && <label className="version-performance__distribution-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索分布版本" placeholder="搜索版本" value={search} onChange={event => setSearch(event.target.value)} /></label>}
    <div className="version-performance__distribution-layout" style={{ "--version-distribution-height": `${height}px` } as CSSProperties}>
      <div className="version-performance__distribution-chart">
        {hasChartData ? <Chart theme="v13" ariaLabel={`${grouped ? "分端" : "总体"}${summaryValueLabel}版本分布`} style={{ height }} option={{
          animation: false,
          grid: { left: 12, right: 70, top: 24, bottom: 35, containLabel: true },
          tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (params: { dataIndex: number }[]) => {
            const row = chartRows[params[0]?.dataIndex ?? 0];
            return `${row.name}<br/>总体：${labelFor(row.overall, active)} · ${percentage(shareOf(row.overall))}${grouped ? clients.map(client => `<br/>${client.label}：${labelFor(row.byClient[client.id], active)} · 同端占比 ${percentage(shareOf(row.byClient[client.id]))}`).join("") : ""}`;
          } },
          xAxis: { type: "value", min: 0, splitNumber: 3, axisLabel: { hideOverlap: true, formatter: (value: number) => value.toLocaleString("zh-CN") } },
          yAxis: { type: "category", inverse: true, data: chartRows.map(row => row.name), axisLabel: { width: 94, overflow: "truncate" } },
          series: series.map((item, index) => ({
            name: item.name, type: "bar", stack: grouped && !active ? "launches" : undefined, data: item.values, barMaxWidth: 20,
            itemStyle: { color: item.color },
            label: { show: true, position: "right", fontSize: 12, formatter: (params: { dataIndex: number; value: number | null }) => {
              if (grouped && !active && series.slice(index + 1).some(item => item.values[params.dataIndex] !== null)) return "";
              const value = grouped && !active && clients.length === 2 ? chartRows[params.dataIndex].overall.launches ?? params.value : params.value;
              return value === null || value === undefined ? "" : value.toLocaleString("zh-CN");
            } }
          }))
        }} /> : <StatePanel compact kind="empty" title={filtered.length ? "当前范围暂无可绘制结果" : "没有匹配的版本"} description="结果未返回或尚未产出时保留状态，不补 0。" />}
        {grouped && <div className="version-performance__distribution-legend">{clients.map(client => <span key={client.id}><i style={{ background: CHART_PALETTE[client.id === "android" ? 0 : 1] }} />{client.label}</span>)}</div>}
      </div>
      <div className="version-performance__distribution-summary">
        <PaginatedTable label="版本分布摘要" compact columnCount={grouped ? clients.length + 1 : 3} resetKey={`${keys.join()}:${search}:${view.distribution}:${analysis.mode}`} head={<tr>
          <th>版本</th>
          {grouped ? clients.map(client => <th key={client.id}><FloatingHint content={description}><span tabIndex={0}>{client.label}<small>{summaryValueLabel} / {active ? "使用率" : "占比"}</small></span></FloatingHint></th>) : <><th><FloatingHint content={description}><span tabIndex={0}>{summaryValueLabel}</span></FloatingHint></th><th><FloatingHint content={description}><span tabIndex={0}>{active ? "版本使用率" : "启动占比"}</span></FloatingHint></th></>}
        </tr>} rows={filtered.map(row => <tr key={row.name}>
          <td>{row.name}</td>{grouped ? clients.map(client => <td key={client.id}>{cell(row.byClient[client.id])}</td>) : <><td>{labelFor(row.overall, active)}{row.overall.state === "partial" && <span className="version-performance__distribution-state">{row.overall.stateLabel}</span>}</td><td>{percentage(shareOf(row.overall))}</td></>}
        </tr>)} />
      </div>
    </div>
    <p className="version-performance__distribution-note">{grouped && active ? "两端人数并列对照，总体跨端去重，不按柱长相加。" : "每个版本一行，未知版本单列。"}{filtered.length > 12 ? ` 图示前 12 个版本；表格与导出保留全部 ${filtered.length} 个版本。` : ""}</p>
    <ChartDataTable title="版本分布同口径数据表" exportAction={exportAction("版本分布", [sheets[0]])}>
      <p className="dashboard-table-context">{context}。{description} 完整表与导出保留两端，不受图例显隐影响。</p>
      <PaginatedTable label="版本分布完整结果" compact columnCount={11} resetKey={`${keys.join()}:${range.start}:${range.end}:${mixed}:${compared}`} head={<tr><th>期别</th><th>统计区间</th><th>版本</th><th>客户端</th><th>启动次数</th><th>启动占比</th><th>活跃人数</th><th>同范围日活人数</th><th>版本使用率</th><th>数据日期</th><th>状态</th></tr>} rows={detailRows} />
    </ChartDataTable>
  </DashboardPanel></DataOriginProvider>;
}
