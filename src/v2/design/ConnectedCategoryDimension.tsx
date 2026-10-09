import { useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Chart } from "../../components/Chart";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import { Button } from "../../components/ui/Button";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { PivotTable } from "../../components/ui/PivotTable";
import { CHART_PALETTE } from "../../theme/tokens";
import { DataOriginProvider } from "../components/DataOrigin";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { missingCalculation } from "../features/dashboards/CalculationEvidence";
import { LiveSeriesDetails, LiveSeriesExport } from "../features/dashboards/ConnectedMetricCard";
import { LiveDashboardContext, liveDailyReferenceRows, liveExportMetadata, livePeriodStatus, liveValue, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { demoMetric, type ExtendedBoard } from "./extended-board-model";
import { orderBoardRows, type BoardSortOrder } from "./content-discovery-analysis-model";
import { HORIZONTAL_BAR_GRID, horizontalBarEndLabel } from "./horizontal-bar-reading";
import { connectedDimensionReading, type ConnectedDimensionRow } from "./connected-dimension-model";
import { PreviewMetricCard, type OpenPreviewReading } from "./PreviewMetricCard";
import { downloadPreviewWorkbook, type WorkbookSheet } from "./preview-workbook";

export interface ConnectedCategorySource {
  rows: (live: LiveDashboardReading, id: string, group: string) => ConnectedDimensionRow[];
  supported: (id: string, group: string) => boolean;
  sheet: (live: LiveDashboardReading, id: string, group: string) => WorkbookSheet;
  unit: (live: LiveDashboardReading, id: string, group: string) => string;
  guidanceKey: string;
  inlineInputs?: boolean;
  cross?: (group: string) => { rows: { key: string; label: string }[]; columns: string[] } | undefined;
}
type SelectProps = { label: string; value: string; onChange: (value: string) => void; values: { value: string; label: string }[] };
export function ConnectedCategoryDimension({ spec, live, pending, open, onSelectionChange, source, renderSelect }: {
  spec: ExtendedBoard["dimensions"][number]; live: LiveDashboardReading; pending: boolean; open: OpenPreviewReading;
  onSelectionChange?: (value: { id: string; group: string; order: BoardSortOrder }) => void;
  source: ConnectedCategorySource;
  renderSelect?: (props: SelectProps) => ReactNode;
}) {
  const [id, setId] = useState(spec.ids[0]), [group, setGroup] = useState(spec.groups[0]);
  const [search, setSearch] = useState(""), [order, setOrder] = useState<BoardSortOrder>("position");
  const metric = demoMetric(id), unit = source.unit(live, id, group), compared = Boolean(live.comparison);
  const rows = orderBoardRows(source.rows(live, id, group), order, row => row.value ?? -Infinity);
  const filtered = rows.filter(row => `${row.name} ${row.key}`.toLowerCase().includes(search.trim().toLowerCase()));
  const inputs = unit === "%" || unit.includes("/人") ? rows.find(row => row.calculation)?.calculation ?? missingCalculation(metric.definition, live.query.dateRange.join(" 至 "), "待接入", unit === "%") : undefined;
  const cross = source.cross?.(group);
  const format = (value: number | null) => `${liveValue(value, unit)}${value === null ? "" : unit}`;
  const difference = (row: ConnectedDimensionRow) => row.value === null || row.baseline === null ? "—" : `${liveValue(row.value - row.baseline, unit)}${unit === "%" ? " 个百分点" : unit}`;
  const inputValue = (value: { value: number | null; unit: string } | undefined) => value?.value == null ? "—" : `${liveValue(value.value, value.unit)} ${value.unit}`;
  const status = (row: ConnectedDimensionRow) => `${row.state}${row.freshness ? ` · ${row.freshness}` : ""}`;
  const select = (props: SelectProps) => renderSelect ? renderSelect(props) : <MenuSelect label={props.label} ariaLabel={props.label} value={props.value} density="compact" onChange={props.onChange} groups={[{ label: props.label, options: props.values }]} />;
  const notify = (next: { id?: string; group?: string; order?: BoardSortOrder }) => onSelectionChange?.({ id, group, order, ...next });
  const exported = <PreviewExportControl name={spec.title} dataOrigin="live" scope="当前指标与分组的完整逐日结果、计算输入及状态。" context={`${live.platformName} · ${live.query.dateRange.join(" 至 ")}`} pending={pending || live.controls.dirty || !live.canExport || live.state.status !== "success"} onDownloadPreview={() => downloadPreviewWorkbook(spec.title, [
    { name: "00_导出说明", rows: liveExportMetadata(live) }, source.sheet(live, id, group)
  ], "pending")} />;
  const point = (row: ConnectedDimensionRow) => {
    const original: DashboardMetricCardModel = {
      metric: { id: row.seriesId, name: `${metric.name} · ${row.name}`, definitionLabel: metric.definition, aggregationLabel: live.query.dateRange.join(" 至 ") },
      result: { status: "no_values", label: "待接入", contextLabel: "真实后台查询", retryable: false }
    };
    const selected = connectedDimensionReading(live, row.seriesId);
    const current = selected.state.status === "success" ? selected.state.data : null;
    const previous = selected.comparison?.state.status === "success" ? selected.comparison.state.data : null;
    const metricExport = row.series && current && live.canExport && !live.controls.dirty
      ? <LiveSeriesExport series={row.series} result={current} comparison={previous} comparisonStatus={livePeriodStatus(selected, true)}
        dayReferences={liveDailyReferenceRows(selected, [row.seriesId])} stale={Boolean(selected.state.status === "success" && selected.state.refreshError || selected.comparison?.state.status === "success" && selected.comparison.state.refreshError)} />
      : <Button disabled>导出未就绪</Button>;
    open(`${spec.title} · ${row.name}`, <DataOriginProvider value="pending">
      <p>{metric.name} · {row.name} · 主值 {live.query.dateRange[1]}</p><p>当前值 {format(row.value)} · {status(row)}</p>
      {compared && <p>对比 {live.comparison!.query.dateRange[1]} · {format(row.baseline)} · {row.baselineState}；差值 {difference(row)}</p>}
      <LiveDashboardContext.Provider value={selected}><PreviewMetricCard model={original} open={open} retry={selected.retry} exportAction={metricExport} /></LiveDashboardContext.Provider>
      {row.series && current && <details><summary>来源记录与计算输入</summary><LiveSeriesDetails series={row.series} result={current} />{row.baselineSeries && previous && <LiveSeriesDetails series={row.baselineSeries} result={previous} />}</details>}
    </DataOriginProvider>);
  };
  return <DataOriginProvider value="pending"><DashboardPanel title={spec.title} guidanceKey={source.guidanceKey} note={`${metric.name} · ${live.query.dateRange.join(" 至 ")} · 主值 ${live.query.dateRange[1]}`} tools={<>
    <div className="board-control-group"><span>指标</span>{select({label:`${spec.title}指标`, value:id, onChange:value => { setId(value); notify({ id: value }); }, values:spec.ids.map(value => ({ value, label: demoMetric(value).name }))})}</div>
    <div className="board-dimension-controls"><span>比较维度</span><MenuSelect label="比较维度" ariaLabel={`${spec.title}分组`} value={group} density="compact" onChange={value => { setGroup(value); notify({ group: value }); }} groups={[{ label: "比较维度", options: spec.groups.map(value => ({ value, label: value })) }]} /></div>
    <div className="board-control-group board-control-group--secondary"><span>排序</span>{select({label:`${spec.title}排序`, value:order, onChange:value => { setOrder(value as BoardSortOrder); notify({ order: value as BoardSortOrder }); }, values:[{ value: "position", label: "按业务顺序" }, { value: "desc", label: "按当前值降序" }]})}</div>
    {cross && exported}
  </>}>
    {!source.supported(id, group) && <p className="dashboard-table-context" role="status">{metric.name} · {group}真实分组待接入</p>}
    {cross ? <PivotTable label={`${spec.title}二维交叉表`} rowHeading={group} columns={cross.columns} rows={cross.rows.map(row => ({ ...row, values: cross.columns.map(() => "待接入") }))} /> : <>
    <div className="board-preview__category-scroll" aria-label={`${spec.title}全部分类图`}><Chart theme="v13" ariaLabel={`${spec.title}分类比较`} style={{ height: Math.max(260, rows.length * (compared ? 46 : 32) + 60) }} onClick={params => { const row = rows[(params as { dataIndex: number }).dataIndex]; if (row) point(row); }} option={{
      grid: HORIZONTAL_BAR_GRID, tooltip: { trigger: "axis", formatter: (params: { dataIndex: number }[]) => { const row = rows[params[0]?.dataIndex]; return row ? `${row.name}<br/>当前 ${live.query.dateRange[1]} · ${format(row.value)} · ${status(row)}${compared ? `<br/>对比 ${live.comparison!.query.dateRange[1]} · ${format(row.baseline)} · ${row.baselineState}<br/>差值 ${difference(row)}` : ""}` : ""; } },
      xAxis: { type: "value", axisLabel: { hideOverlap: true, formatter: (value: number) => unit === "%" ? format(value) : liveValue(value, unit) } },
      yAxis: { type: "category", inverse: true, data: rows.map(row => row.name), axisLabel: { width: 132, overflow: "truncate" } },
      series: [{ name: "当前期", type: "bar", data: rows.map(row => row.value), label: horizontalBarEndLabel(format), barMaxWidth: 16, itemStyle: { color: CHART_PALETTE[0] } }, ...(compared ? [{ name: "对比期", type: "bar", data: rows.map(row => row.baseline), barMaxWidth: 16, itemStyle: { color: CHART_PALETTE[1] } }] : [])]
    }} /></div>
    {source.inlineInputs && inputs && <section className="board-analysis__inline-table" aria-label={`${spec.title}计算输入`}><p><b>{metric.name}</b> · {inputs.formula}</p><div className="ui-result-table__viewport" tabIndex={0} role="region" aria-label={`${spec.title}计算输入表`}><table><thead><tr><th>{group}</th><th>{inputs.numerator.name}</th><th>{inputs.denominator.name}</th><th>结果</th><th>状态</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}><td>{row.name}</td><td>{inputValue(row.calculation?.numerator)}</td><td>{inputValue(row.calculation?.denominator)}</td><td>{format(row.value)}</td><td>{status(row)}</td></tr>)}</tbody></table></div></section>}
    <ChartDataTable title={`${spec.title}同口径数据表`} exportAction={exported}><p className="dashboard-table-context">主值 {live.query.dateRange[1]}{compared && ` · 对比 ${live.comparison!.query.dateRange[1]}`} · {metric.name}{inputs && ` · ${inputs.formula}`}</p><label className="topic-preview__search ui-search"><Search /><input aria-label={`搜索${spec.title}`} value={search} placeholder="搜索名称或标识" onChange={event => setSearch(event.target.value.slice(0, 120))} /></label>
      <PaginatedTable label={`${spec.title}完整结果`} resetKey={JSON.stringify([id, group, search, order, live.query])} columnCount={(compared ? 7 : 5) + (inputs ? compared ? 4 : 2 : 0)} head={<tr><th>名称 / 标识</th><th>位置</th>{inputs && <><th>{inputs.numerator.name}</th><th>{inputs.denominator.name}</th></>}<th>当前值</th>{compared && <>{inputs && <><th>对比分子</th><th>对比分母</th></>}<th>对比值</th><th>差值{unit === "%" ? "（百分点）" : ""}</th></>}<th>状态</th><th>详情</th></tr>} rows={filtered.map(row => <tr key={row.key}><td>{row.name}<small className="topic-preview__content-id">{row.key}</small></td><td>{row.position}</td>{inputs && <><td>{inputValue(row.calculation?.numerator)}</td><td>{inputValue(row.calculation?.denominator)}</td></>}<td>{format(row.value)}</td>{compared && <>{inputs && <><td>{inputValue(row.baselineCalculation?.numerator)}</td><td>{inputValue(row.baselineCalculation?.denominator)}</td></>}<td>{format(row.baseline)}</td><td>{difference(row)}</td></>}<td>{status(row)}{compared && `；对比${row.baselineState}`}</td><td><button type="button" onClick={() => point(row)}>查看趋势</button></td></tr>)} />
    </ChartDataTable>
    </>}
  </DashboardPanel></DataOriginProvider>;
}
