import { Info, Search } from "lucide-react";
import { useMemo, type ReactElement } from "react";
import { Chart } from "../../components/Chart";
import { ChangeValue } from "../../components/ui/ChangeValue";
import { changeDirection } from "../../components/ui/change-presentation";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import { FloatingHint } from "../../components/ui/FloatingHint";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { PaginatedLegend } from "../../components/ui/PaginatedLegend";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { PivotTable, type PivotCell } from "../../components/ui/PivotTable";
import type { DateRangeValue } from "../../components/ui/date-range-model";
import { CHART_PALETTE } from "../../theme/tokens";
import { DataOriginProvider } from "../components/DataOrigin";
import { StatePanel } from "../components/StatePanel";
import { DashboardPanel, DashboardSectionHeading } from "../features/dashboards/DashboardPresentation";
import { AnalysisScopeControls, useAnalysisGroupVisibility, type AnalysisDisplayMode } from "../features/dashboards/AnalysisScopeControls";
import { CalculationEvidence, type CalculationBasis } from "../features/dashboards/CalculationEvidence";
import type { WorkbookSheet } from "./preview-workbook";
import { demoPrevious, demoRangeLabel } from "./extended-board-model";
import {
  VERSION_CLIENTS, VERSION_METRICS, focusVersionGroup, type VersionClient, type VersionClientScope,
  type VersionMetricId, type VersionPerformanceView, versionMetric, versionMetricAudienceScope,
  versionMetricInputs, versionOption, versionQueryKeys, versionQueryLabel, versionsForClient
} from "./version-performance-model";
import {
  displayVersionMetric, versionDisplayGroups, versionMetricSummary, versionScopeMetricPoints,
  versionScopeMetricSummary, versionPerformanceSheets, versionRetentionRows
} from "./version-performance-fixtures";
import { VersionDistributionPanel } from "./VersionDistributionPanel";
import "./version-performance-preview.css";
import "./version-core-client.css";

type ExportAction = (name: string, sheets: WorkbookSheet[], iconOnly?: boolean) => ReactElement;

export interface VersionPerformancePreviewProps {
  range: DateRangeValue;
  compared: boolean;
  mixed: boolean;
  view: VersionPerformanceView;
  onChange: (view: VersionPerformanceView) => void;
  exportAction: ExportAction;
}

export interface VersionAnalysisDisplay {
  mode: AnalysisDisplayMode;
  clients: VersionClient[];
  setClients: (values: string[]) => void;
  restoreAll: () => void;
  isAll: boolean;
}

const percentage = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(2)}%`;
const clientLabel = (client: VersionClientScope) => client === "overall" ? "总体" : VERSION_CLIENTS.find(item => item.id === client)!.label;
const clientColor = (client: VersionClientScope) => CHART_PALETTE[client === "ios" ? 1 : 0];
const focusedClient = (view: VersionPerformanceView): VersionClientScope => view.display === "overall" ? "overall" : view.focusClient ?? "overall";
const clearVersionFocus = (view: VersionPerformanceView): VersionPerformanceView => {
  const { versionGroup: _group, focusClient: _client, ...rest } = view;
  return { ...rest, versionRange: "all", client: "overall", comparison: "none", audience: "overall" };
};

function aggregationLabel(id: VersionMetricId) {
  const kind = versionMetric(id).kind;
  return kind === "count" ? "所选范围累计" : kind === "daily_count" ? "所选结束日日值" : kind === "retention" ? "成熟 D0 批次加权" : "所选范围按输入加权";
}

function comparisonText(id: VersionMetricId, current: number | null, baseline: number | null) {
  if (current === null || baseline === null) return null;
  const ratio = versionMetric(id).unit === "%";
  if (!ratio && baseline === 0) return null;
  const delta = current - baseline;
  return { direction: changeDirection(delta), text: ratio
    ? `${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta * 100).toFixed(2)} 个百分点`
    : `${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta / baseline * 100).toFixed(1)}%` };
}

type VersionMetricSummaryValue = ReturnType<typeof versionMetricSummary>;

function MetricResult({ id, summary, unavailable }: { id: VersionMetricId; summary: VersionMetricSummaryValue; unavailable?: boolean }) {
  return <span className={`version-core-client__result${summary.value === null ? " is-unavailable" : ""}`} title={unavailable ? "该端无此版本" : summary.stateLabel}>
    {displayVersionMetric(id, summary.value)}{(unavailable || summary.state !== "available") && <small>{unavailable ? "该端无此版本" : summary.stateLabel}</small>}
  </span>;
}

function VersionControls({ view, onChange, exportAction, sheets, analysis }: Pick<VersionPerformancePreviewProps, "view" | "onChange" | "exportAction"> & { sheets: WorkbookSheet[]; analysis: VersionAnalysisDisplay }) {
  const selected = versionOption(view.version)!;
  const groups = versionDisplayGroups();
  const value = view.versionRange === "all" ? "all" : view.versionGroup === undefined ? view.version : `group:${view.versionGroup}`;
  const exactGroups = VERSION_CLIENTS.map(client => ({ label: `${client.label} 精确版本`, options: versionsForClient(client.id).map(item => ({ value: item.key, label: item.label })) }));
  return <AnalysisScopeControls label="版本分析范围" groupDisplay={{
    mode: analysis.mode,
    onModeChange: display => onChange({ ...view, display, focusClient: "overall", audience: "overall" }),
    clientOptions: VERSION_CLIENTS.map(client => ({ value: client.id, label: client.label })),
    selectedClients: analysis.clients,
    onClientsChange: values => { analysis.setClients(values); if (view.focusClient && view.focusClient !== "overall" && !values.includes(view.focusClient)) onChange({ ...view, focusClient: "overall" }); },
    onRestoreAll: analysis.restoreAll,
    canRestoreAll: !analysis.isAll
  }} tools={exportAction("版本表现", sheets, true)} note={`${versionQueryLabel(view)} · ${analysis.mode === "overall" ? "独立总体" : `显示 ${analysis.clients.map(clientLabel).join(" / ")}`}。`}>
    <MenuSelect label="版本条件" ariaLabel="版本条件" value={value} density="compact" searchable={groups.length + exactGroups.reduce((count, group) => count + group.options.length, 1) > 8} onChange={value => {
      if (value === "all") return onChange(clearVersionFocus(view));
      if (value.startsWith("group:")) return onChange(focusVersionGroup(view, value.slice(6), "overall"));
      const { versionGroup: _group, focusClient: _client, ...rest } = view;
      onChange({ ...rest, version: value, versionRange: "focused", comparison: "none", client: "overall", audience: "overall" });
    }} groups={[{ label: "版本范围", options: [{ value: "all", label: "全部 Android / iOS 版本" }, ...groups.map(group => ({ value: `group:${group.name}`, label: group.name }))] }, ...exactGroups]} />
    {view.versionRange === "focused" && view.versionGroup === undefined && <MenuSelect label="对比版本" ariaLabel="对比版本" value={view.comparison} density="compact" searchable={false} onChange={comparison => onChange({ ...view, comparison })} groups={[{ label: `${clientLabel(selected.client)} 版本`, options: [{ value: "none", label: "不对比" }, ...versionsForClient(selected.client).filter(item => item.key !== view.version).map(item => ({ value: item.key, label: item.label }))] }]} />}
    {view.versionRange === "focused" && <button type="button" className="version-core-client__reset" onClick={() => onChange(clearVersionFocus(view))}>恢复全部版本</button>}
  </AnalysisScopeControls>;
}

function CorePanel({ range, compared, mixed, view, onChange, exportAction, sheets, analysis }: VersionPerformancePreviewProps & { sheets: WorkbookSheet[]; analysis: VersionAnalysisDisplay }) {
  const previous = demoPrevious(range);
  const allGroups = versionDisplayGroups();
  const search = view.search.trim().toLocaleLowerCase("zh-CN");
  const groups = allGroups.filter(group => !search || group.name.toLocaleLowerCase("zh-CN").includes(search));
  const metric = versionMetric(view.metric);
  const keys = versionQueryKeys(view);
  const client = focusedClient(view);
  const scope = { client, audience: "overall" as const };
  const scopeLabel = `${versionQueryLabel(view)} · ${clientLabel(client)}`;
  const summaries = new Map(VERSION_METRICS.map(metric => [metric.id, versionScopeMetricSummary(keys, metric.id, range, mixed, scope)]));
  const baselines = new Map(VERSION_METRICS.map(metric => [metric.id, versionScopeMetricSummary(keys, metric.id, previous, mixed, scope)]));
  const columns: VersionClientScope[] = analysis.mode === "overall" ? ["overall"] : analysis.clients;
  const rows = groups.map(group => ({ ...group, summaries: columns.map(client => versionScopeMetricSummary(group.keys, metric.id, range, mixed, { client, audience: "overall" })) }));
  const byName = new Map(rows.map(row => [row.name, row]));
  const selectedCell = view.versionRange === "focused" && view.versionGroup !== undefined && columns.includes(client) ? { rowKey: view.versionGroup, columnIndex: columns.indexOf(client) } : null;
  const canSelectCell = ({ rowKey, columnIndex }: PivotCell) => byName.get(rowKey)?.summaries[columnIndex]?.value != null;
  const selectCell = ({ rowKey, columnIndex }: PivotCell) => onChange(focusVersionGroup(view, rowKey, columns[columnIndex]));
  const current = summaries.get(metric.id)!;
  const inputs = versionMetricInputs(metric.id);
  const calculation: CalculationBasis = { formula: metric.definition, scope: `${scopeLabel} · ${demoRangeLabel(range)} · ${current.stateLabel}`, numerator: { name: inputs.numerator, value: current.numerator, unit: "" }, denominator: { name: inputs.denominator, value: current.denominator, unit: "" }, result: displayVersionMetric(metric.id, current.value), percentage: metric.unit === "%" };
  const detailColumns = [0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const detailRows = sheets[1].rows.slice(1);
  return <DataOriginProvider value="demo"><DashboardPanel title="核心表现" guidanceKey="version.core" chartKind="version-core-performance" note={`${scopeLabel} · ${demoRangeLabel(range)}`}>
    <div className="version-performance__metric-grid">
      {VERSION_METRICS.map(metric => {
        const summary = summaries.get(metric.id)!;
        const baseline = compared ? baselines.get(metric.id)! : null;
        const unmatchedRetention = Boolean(baseline && metric.kind === "retention" && (summary.state !== "available" || baseline.state !== "available"));
        const comparison = baseline && !unmatchedRetention ? comparisonText(metric.id, summary.value, baseline.value) : null;
        return <FloatingHint key={metric.id} className="version-performance__metric-hint" content={<><strong>{metric.name}</strong><br />{metric.definition}<br /><small>{metric.attribution}</small></>}>
          <button type="button" className={`version-performance__metric${view.metric === metric.id ? " is-selected" : ""}`} aria-pressed={view.metric === metric.id} onClick={() => onChange({ ...view, metric: metric.id })}>
            <span>{metric.name}<Info aria-hidden="true" /></span><strong>{displayVersionMetric(metric.id, summary.value)}</strong>
            <small>{metric.id === "M020" ? "固定注册批次" : metric.id === "M024" ? "固定存量批次" : `${clientLabel(client)} · 当前版本范围`}</small>
            <small>{summary.state === "available" ? aggregationLabel(metric.id) : summary.stateLabel}</small>
            {comparison && <small>较上一等长周期 <ChangeValue direction={comparison.direction}>{comparison.text}</ChangeValue></small>}
            {compared && unmatchedRetention && <small>两期成熟批次覆盖不同，暂不比较</small>}
          </button>
        </FloatingHint>;
      })}
      <article className="version-performance__metric is-proposal" aria-label="整体活跃次日回访待支持"><span>整体活跃次日回访率 <b>待登记</b></span><strong>—</strong><small>D0 拟按首次登录活跃版本冻结；当前不生成数值</small></article>
    </div>
    <section className="version-core-client__comparison" aria-labelledby="version-core-comparison-title">
      <header><div><h3 id="version-core-comparison-title">版本 × {analysis.mode === "overall" ? "总体" : "客户端"}</h3><p>当前指标：{metric.name}。点击可用结果后，摘要与趋势聚焦该版本和客户端；完整比较表保留。</p></div>
        {metric.unit === "%" ? <CalculationEvidence basis={calculation} compact /> : <FloatingHint content={<>{metric.definition}<br />{scopeLabel} · {current.stateLabel}</>}><span className="version-core-client__input">{inputs.numerator}：{current.numerator?.toLocaleString("zh-CN") ?? "—"}</span></FloatingHint>}
      </header>
      <div className="version-performance__matrix-tools"><label className="ui-search version-performance__matrix-search"><Search aria-hidden="true" /><span className="sr-only">搜索版本</span><input type="search" aria-label="搜索版本" value={view.search} placeholder="搜索版本" onChange={event => onChange({ ...view, search: event.target.value.slice(0, 120) })} /></label><span>显示 {rows.length}/{allGroups.length} 个版本 · 每页最多 50 行</span></div>
      <div className="version-core-client__table"><PivotTable label="版本核心表现客户端比较表" rowHeading="版本" columns={columns.map(clientLabel)} rows={rows.map(row => ({ key: row.name, label: row.name, values: row.summaries.map((summary, index) => <MetricResult key={columns[index]} id={metric.id} summary={summary} unavailable={columns[index] !== "overall" && row.clients[columns[index] as VersionClient].length === 0} />) }))} resetKey={`${view.search}:${view.metric}:${analysis.mode}:${columns.join()}:${range.start}:${range.end}:${mixed}`} selectedCell={selectedCell} canSelectCell={canSelectCell} onSelectCell={selectCell} /></div>
      <p className="version-performance__matrix-boundary">{versionMetricAudienceScope(view.metric)} 同名版本按展示组读取独立结果，保留 Android / iOS 原版本实体；人数去重，比率按兼容输入加权。</p>
    </section>
    <ChartDataTable title="版本核心表现同口径数据表" exportAction={exportAction("版本核心表现", [sheets[1], sheets[3]])}>
      <p className="dashboard-table-context">完整保留每个版本的总体、Android / iOS 九项指标、计算输入和状态；注册 D1 与存量复访使用各自固定批次。</p>
      <PaginatedTable label="版本核心表现完整结果" compact columnCount={detailColumns.length} resetKey={`${range.start}:${range.end}:${mixed}:${compared}`} head={<tr>{detailColumns.map(index => <th key={index}>{sheets[1].rows[0][index]}</th>)}</tr>} rows={detailRows.map((row, index) => <tr key={index}>{detailColumns.map(column => <td key={column}>{typeof row[column] === "number" ? row[column].toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : row[column] ?? "—"}</td>)}</tr>)} />
    </ChartDataTable>
  </DashboardPanel></DataOriginProvider>;
}

function TrendPanel({ range, compared, mixed, view, onChange, exportAction, sheets, analysis }: VersionPerformancePreviewProps & { sheets: WorkbookSheet[]; analysis: VersionAnalysisDisplay }) {
  const metric = versionMetric(view.metric);
  const keys = versionQueryKeys(view);
  const previousRange = demoPrevious(range);
  const client = focusedClient(view);
  const clients: VersionClientScope[] = analysis.mode === "overall" ? ["overall"] : client === "overall" ? analysis.clients : analysis.clients.filter(item => item === client);
  const descriptor = (client: VersionClientScope) => ({ id: client, label: clientLabel(client), color: clientColor(client), keys, client });
  const descriptors = clients.map(descriptor);
  const comparison = view.versionRange === "focused" && view.comparison !== "none" ? versionOption(view.comparison)! : null;
  const visible = [...descriptors, ...(comparison ? [{ id: `comparison:${comparison.key}`, label: `${comparison.label} · 对比版本`, color: CHART_PALETTE[2], keys: [comparison.key], client: comparison.client }] : [])];
  const plotted = visible.flatMap(item => [
    { ...item, name: item.label, points: versionScopeMetricPoints(item.keys, metric.id, range, mixed, { client: item.client, audience: "overall" }), dashed: false },
    ...(compared ? [{ ...item, name: `${item.label} · 上一等长周期`, points: versionScopeMetricPoints(item.keys, metric.id, previousRange, mixed, { client: item.client, audience: "overall" }), dashed: true }] : [])
  ]);
  const axisPoints = plotted.find(item => item.points.length)?.points ?? [];
  const hasPlot = plotted.some(item => item.points.some(point => point.value !== null));
  const plotValue = (value: number | null) => value === null ? null : metric.unit === "%" ? value * 100 : value;
  const detailColumns = [0, 1, 2, 6, 7, 8, 9, 10, 11, 12];
  const detailRows = sheets[2].rows.slice(1).filter(row => row[3] === metric.name);
  const retentionKeys = [...new Set([...keys, ...(comparison ? [comparison.key] : [])])];
  const retention = versionRetentionRows(retentionKeys, range, mixed);
  return <DataOriginProvider value="demo"><DashboardPanel id="version-performance-trend" title="变化趋势" guidanceKey="version.trend" chartKind="version-metric-trend" note={`${versionQueryLabel(view)} · ${clients.map(clientLabel).join(" / ")} · ${metric.name}；${versionMetricAudienceScope(metric.id)} ${metric.attribution}`} tools={<MenuSelect label="趋势指标" ariaLabel="版本变化趋势指标" value={view.metric} density="compact" searchable={false} onChange={id => onChange({ ...view, metric: id as VersionMetricId })} groups={[{ label: "启动、活跃、播放、观影与留存", options: VERSION_METRICS.map(item => ({ value: item.id, label: item.name })) }]} />}>
    {analysis.mode === "groups" && <div className="version-performance__group-summary" role="region" aria-label={`${metric.name}分组摘要`}>{visible.map(item => { const summary = versionScopeMetricSummary(item.keys, metric.id, range, mixed, { client: item.client, audience: "overall" }); return <section key={item.id}><span><i aria-hidden="true" style={{ backgroundColor: item.color }} />{item.label}</span><strong>{displayVersionMetric(metric.id, summary.value)}</strong><small>{summary.stateLabel}</small></section>; })}</div>}
    {!hasPlot ? <StatePanel compact kind="empty" title="当前变化趋势暂无结果" description="当前版本范围没有可展示结果；未产出和未成熟保持缺失状态。" /> : <Chart theme="v13" ariaLabel={`${versionQueryLabel(view)}${metric.name}${analysis.mode === "overall" ? "总体" : "分组对比"}变化趋势`} style={{ height: 330 }} option={{
      animation: false, grid: { left: 54, right: 24, top: 24, bottom: analysis.mode === "overall" || compared || comparison ? 62 : 28, containLabel: true },
      tooltip: { trigger: "axis", formatter: (params: { seriesIndex: number; dataIndex: number }[]) => { const index = params[0]?.dataIndex ?? 0; return [axisPoints[index]?.date ?? "数据详情", ...params.map(param => { const item = plotted[param.seriesIndex]; const point = item.points[index]; return `${item.name}：${displayVersionMetric(metric.id, point?.value ?? null)}${point?.date && point.date !== axisPoints[index]?.date ? ` · ${point.date}` : ""}${point?.state !== "available" ? ` · ${point?.stateLabel ?? "无结果"}` : ""}`; })].join("<br/>"); } },
      legend: { show: analysis.mode === "overall" || compared || Boolean(comparison), bottom: 0, left: "center", selectedMode: false, data: plotted.filter(item => analysis.mode === "overall" || item.dashed || item.id.startsWith("comparison:")).map(item => item.name) },
      xAxis: { type: "category", boundaryGap: false, data: axisPoints.map(point => point.date.slice(5)), axisLabel: { hideOverlap: true, showMinLabel: true, showMaxLabel: true } },
      yAxis: { type: "value", scale: metric.unit !== "次" && metric.unit !== "人", min: metric.unit === "%" ? undefined : 0, axisLabel: { formatter: (value: number) => `${value.toLocaleString("zh-CN", { maximumFractionDigits: 6 })}${metric.unit === "%" ? "%" : ""}` } },
      series: plotted.map(item => ({ name: item.name, type: "line", data: item.points.map(point => plotValue(point.value)), connectNulls: false, showSymbol: axisPoints.length <= 31 && !item.dashed, symbolSize: 6, lineStyle: { width: item.dashed ? 1.5 : 2, type: item.dashed ? "dashed" : "solid", color: item.color }, itemStyle: { color: item.color } }))
    }} />}
    {analysis.mode === "groups" && <PaginatedLegend label={`${metric.name}客户端`} items={VERSION_CLIENTS.map(item => ({ id: item.id, label: item.label, color: clientColor(item.id), selected: clients.includes(item.id) }))} onToggle={id => { analysis.setClients(clients.includes(id as VersionClient) ? analysis.clients.filter(client => client !== id) : [...analysis.clients, id]); if (view.focusClient && view.focusClient !== "overall") onChange({ ...view, focusClient: "overall" }); }} />}
    <ChartDataTable title={`${metric.name}版本趋势同口径数据表`} exportAction={exportAction(`${metric.name}版本趋势`, [sheets[2], sheets[3]])}>
      <p className="dashboard-table-context">保留当前版本范围的独立总体、全部客户端、精确对比版本及逐日计算输入；显隐不裁剪完整表。注册 D1 与存量复访使用各自固定批次。</p>
      <PaginatedTable label={`${metric.name}版本趋势完整结果`} compact columnCount={detailColumns.length} resetKey={`${view.metric}:${keys.join()}:${range.start}:${range.end}:${mixed}:${compared}`} head={<tr>{detailColumns.map(index => <th key={index}>{sheets[2].rows[0][index]}</th>)}</tr>} rows={detailRows.map((row, index) => <tr key={index}>{detailColumns.map(column => <td key={column}>{typeof row[column] === "number" ? row[column].toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : row[column] ?? "—"}</td>)}</tr>)} />
      <p className="dashboard-table-context">M020 按注册版本冻结；M024 仅含注册满 2 天的存量用户并按 D0 首次登录活跃版本冻结。D1 升级或跨端仍计入原 D0 分组。</p>
      <PaginatedTable label="D1留存与复访批次核对" compact columnCount={8} resetKey={`${retentionKeys.join()}:${range.start}:${range.end}:${mixed}`} head={<tr><th>D0日期</th><th>客户端与版本</th><th>首日注册基数</th><th>注册D1</th><th>首日存量基数</th><th>存量复访D1</th><th>整体活跃D1</th><th>状态</th></tr>} rows={retention.map(row => <tr key={`${row.key}:${row.date}`}><td>{row.date}</td><td>{row.label}</td><td>{row.registeredBase?.toLocaleString("zh-CN") ?? "—"}</td><td>{percentage(row.registeredRate)}</td><td>{row.existingBase?.toLocaleString("zh-CN") ?? "—"}</td><td>{percentage(row.existingRate)}</td><td>{row.overallState}</td><td>{row.registeredState === row.existingState ? row.registeredState : `${row.registeredState} / ${row.existingState}`}</td></tr>)} />
    </ChartDataTable>
  </DashboardPanel></DataOriginProvider>;
}

export function VersionPerformancePreview(props: VersionPerformancePreviewProps) {
  const { range, compared, mixed, view, onChange, exportAction } = props;
  const sheets = useMemo(() => versionPerformanceSheets(view, range, mixed, compared), [view, range, mixed, compared]);
  const visibility = useAnalysisGroupVisibility(VERSION_CLIENTS.map(item => item.id), ["overall"], "version-clients");
  const analysis: VersionAnalysisDisplay = { mode: view.display, clients: visibility.clients as VersionClient[], setClients: visibility.setClients, restoreAll: visibility.restoreAll, isAll: visibility.isAll };
  return <section className="version-performance" aria-labelledby="version-performance-heading">
    <DashboardSectionHeading id="version-performance-heading" title="版本表现" />
    <VersionControls view={view} onChange={onChange} exportAction={exportAction} sheets={sheets} analysis={analysis} />
    <p className="version-performance__date">已应用日期 {demoRangeLabel(range)} · 演示数据，版本统计尚未接入。</p>
    <div className="version-performance__panel"><VersionDistributionPanel {...props} sheets={sheets} analysis={analysis} /><CorePanel {...props} sheets={sheets} analysis={analysis} /><TrendPanel {...props} sheets={sheets} analysis={analysis} /></div>
  </section>;
}

export default VersionPerformancePreview;
