import { ReviewTools } from "../components/ReviewTools";
import { DataOriginBadge, DataOriginProvider } from "../components/DataOrigin";
import { DashboardHeader, DashboardSectionHeading } from "../features/dashboards/DashboardPresentation";
import { DashboardActions, DashboardQueryFields } from "../features/dashboards/DashboardToolbar";
import { Toast, useToast } from "../../components/ui/Toast";
import { MetricReadingDialog as DetailDialog } from "../features/dashboards/MetricReadingDialog";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { readPreviewQuery } from "./preview-query";
import { usePreviewQuery } from "./usePreviewQuery";
import { ArrowDown, ArrowUp, ArrowUpDown, Copy, Info, Maximize2, RefreshCw, Search, Star } from "lucide-react";
import { Pagination } from "../../components/ui/Pagination";
import { TabList } from "../../components/ui/TabList";
import { Button } from "../../components/ui/Button";
import { DateRangePicker } from "../../components/ui/DateRangePicker";
import { FloatingHint } from "../../components/ui/FloatingHint";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { FilterPopover } from "../../components/ui/FilterPopover";
import { ChangeValue } from "../../components/ui/ChangeValue";
import { DashboardMetricCard } from "../features/dashboards/DashboardMetricCard";
import { ComparisonDetails } from "../features/dashboards/ComparisonDetails";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { StatePanel } from "../components/StatePanel";
import { acquisitionViewHref, parseAcquisitionView, readAcquisitionView, resetAcquisitionPages, type AcquisitionViewState, type AcquisitionDetailReading, type AcquisitionDetailKey } from "./acquisition-view-state";
import { previewFavorites, setPreviewFavorite } from "./preview-favorites";
import { exportAcquisition, exportAcquisitionTrend, acquisitionDimensionWorkbook } from "./acquisition-export";
import { changeDirection } from "../../components/ui/change-presentation";
import { ACQUISITION_IDS, DEFAULT_ACQUISITION_FILTERS, DETAIL_METRICS, acquisitionRows, acquisitionRangeLabel, acquisitionDailyCards, acquisitionMetric, fixtureComparison, fixtureSupports, fixtureValue, type AcquisitionFilters } from "./acquisition-preview-model";
import "./acquisition-preview.css";
import { AcquisitionVisuals } from "./AcquisitionVisuals";
import { useLiveDashboard, liveExportMetadata, livePeriodStatus, livePointStateLabel } from "../features/dashboards/LiveDashboardContext";
import { downloadPreviewWorkbook } from "./preview-workbook";
import { CalculationEvidence } from "../features/dashboards/CalculationEvidence";
import { ChannelQuality, exportChannelQuality } from "./ChannelQuality";

const DIMENSIONS = [{ value: "channel", label: "来源渠道" }, { value: "target", label: "下载目标" }, { value: "type", label: "获客类型" }];
function Action({ label, onClick, children, pressed }: { label: string; onClick: () => void; children: ReactNode; pressed?: boolean }) {
  return <FloatingHint content={label}><button type="button" className="ui-icon-button" aria-label={label} aria-pressed={pressed} onClick={onClick}>{children}</button></FloatingHint>;
}
export default function AcquisitionPreview() {
  const shared = readPreviewQuery(), defaults = readAcquisitionView("");
  const initial = useRef(parseAcquisitionView(new URLSearchParams(window.location.search).get("view") ?? "") ?? parseAcquisitionView(JSON.stringify(window.history.state?.acquisitionView) ?? "") ?? { ...defaults, filters: { ...defaults.filters, ...shared.range, comparison: shared.compared ? "previous" : "none" } });
  const [filters, setFilters] = useState<AcquisitionFilters>(initial.current.filters);
  const [applied, setApplied] = useState<AcquisitionFilters>(initial.current.filters);
  const [detail, setDetail] = useState(initial.current.detail);
  const [mixed, setMixed] = useState(initial.current.mixed), [recovered, setRecovered] = useState<string[]>([]);
  const [favorite, setFavorite] = useState(() => previewFavorites().includes("5.7"));
  const { notice, notify: setNotice } = useToast();
  const [dialog, setDialog] = useState<{ title: string; content: ReactNode } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [filterDensity, setFilterDensity] = useState("compact");
  useEffect(() => { const element = root.current; if (!element) return; const observer = new ResizeObserver(([entry]) => setFilterDensity(entry.contentRect.width < 940 ? "narrow" : entry.contentRect.width < 1160 ? "compact" : "wide")); observer.observe(element); return () => observer.disconnect(); }, []);
  const pending = JSON.stringify(filters) !== JSON.stringify(applied);
  const supported = fixtureSupports(applied), compared = applied.comparison !== "none";
  usePreviewQuery(applied, compared, supported);
  const cards = useMemo(() => acquisitionDailyCards(compared, mixed, recovered, applied), [compared, mixed, recovered, applied]);
  useEffect(() => { window.history.replaceState({ ...window.history.state, acquisitionView: { v: 2, filters: applied, detail, mixed } }, ""); }, [applied, detail, mixed]);
  useEffect(() => { const update = () => setFavorite(previewFavorites().includes("5.7")); window.addEventListener("storage", update); window.addEventListener("preview-favorites-change", update); return () => { window.removeEventListener("storage", update); window.removeEventListener("preview-favorites-change", update); }; }, []);
  const open = (title: string, content: ReactNode) => setDialog({ title, content });
  const reset = () => { setApplied(DEFAULT_ACQUISITION_FILTERS); setFilters(DEFAULT_ACQUISITION_FILTERS); setMixed(false); setRecovered([]); };
  const renderCards = (ids: readonly string[]) => <div className="acquisition-preview__grid">{cards.filter(item => ids.includes(item.model.metric.id)).map(({ model, note }) => <DashboardMetricCard key={model.metric.id} model={model} variant="detailed" note={note}
    tableExport={<PreviewExportControl name={`${model.metric.name}同口径数据表`} scope="当前指标的全部逐日结果、实际对比日期、差值与数据状态，不包含其他指标。" context={`${applied.start} 至 ${applied.end} · 大盘整体 · 全部来源渠道`} pending={pending || !supported} onDownloadPreview={() => exportAcquisitionTrend(model, applied)} />}
    analysisHref={`/analysis/metrics/${model.metric.id}`}
    onOpenAnalysis={() => open(`${model.metric.name} · 指标分析`, <><p>{model.metric.definitionLabel}</p><p>正式指标分析尚待查询与验数接入。当前可在卡片下方展开同口径数据表，逐日查看本演示快照。</p></>)}
    onOpenDefinition={() => open(model.metric.name, <><p>{model.metric.definitionLabel}</p>{model.result.status === "available" && model.result.calculation && <CalculationEvidence basis={model.result.calculation}/>}</>)}
    onOpenComparison={() => { if (model.result.status === "available" && model.result.comparison) open(`${model.metric.name} · 周期对比`, <ComparisonDetails comparison={model.result.comparison} onEmphasis={false} />); }}
    onOpenTrendPoint={(_, point) => open(`${model.metric.name} · 趋势详情`, <div className="ui-comparison-details"><div className="ui-comparison-details__row"><span>当前期</span><strong>{point.value?.display ?? "—"}</strong><small>{point.actualDate}</small></div>{point.counterpart && <div className="ui-comparison-details__row"><span>对比期</span><strong>{point.counterpart.display}</strong><small>{point.counterpart.actualDate}</small></div>}{point.differenceDisplay && <p>差值：<ChangeValue direction={point.value && point.counterpart ? changeDirection(point.value.raw - point.counterpart.raw) : null}>{point.differenceDisplay}</ChangeValue></p>}{point.state !== "available" && <p>{point.stateLabel}</p>}{point.calculation && <CalculationEvidence basis={point.calculation}/>}</div>)}
    onRetry={() => { setRecovered(current => [...current, model.metric.id]); setNotice("已恢复此卡的演示快照，其他卡片未刷新。"); }}
  />)}</div>;
  const scopeControl = (<MenuSelect label="业务范围" ariaLabel="业务范围" density="compact" value={filters.scope} onChange={scope => setFilters(current => ({ ...current, scope }))} groups={[{ label: "演示查询范围", options: [{ value: "all", label: "大盘整体" }, { value: "single", label: "单业务平台", meta: "六项指标的统一筛选能力待验数" }] }]} />);
  const channelControl = (<MenuSelect label="来源渠道" ariaLabel="来源渠道" density="compact" value={filters.channel} onChange={channel => setFilters(current => ({ ...current, channel }))} groups={[{ label: "整板筛选", options: [{ value: "all", label: "全部来源渠道" }, { value: "a", label: "推广渠道 A", meta: "独立演示快照尚未提供" }] }]} />);
  const comparisonControl = (<MenuSelect label="对比周期" ariaLabel="对比周期" density="compact" value={filters.comparison} onChange={comparison => setFilters(current => ({ ...current, comparison }))} groups={[{ label: "同口径比较", options: [{ value: "previous", label: "上一等长周期" }, { value: "month", label: "上月同期", meta: "演示快照尚未提供" }, { value: "year", label: "去年同期", meta: "演示快照尚未提供" }, { value: "none", label: "不对比" }] }]} />);
  return <div className="v2-page acquisition-preview" ref={root} data-page="acquisition-preview" data-preview-marker="ACQUISITION_PREVIEW_MARKER">
    <ReviewTools><div className="dashboard-workbench__preview-note"><span>开发环境体验 · 合成演示数据，非正式业务结果</span><div className="acquisition-preview__modes"><Button size="sm" variant={!mixed ? "primary" : "secondary"} onClick={() => { setMixed(false); setRecovered([]); }} aria-pressed={!mixed}>正常态</Button><Button size="sm" variant={mixed ? "primary" : "secondary"} onClick={() => { setMixed(true); setRecovered([]); }} aria-pressed={mixed}>组合异常态</Button></div></div></ReviewTools>
    <DashboardHeader className="acquisition-preview__head" title="获客与新增" breadcrumb="公共概览 / 用户生命周期" description="观察获客阶段转化、新增用户规模与首次体验质量，按来源渠道核对增长效果；注册转化只作趋势参考。">
      <div className="acquisition-preview__tools">
        <section className="acquisition-preview__filters" aria-label="看板工具栏">
      <DashboardQueryFields date={<DateRangePicker value={{ start: filters.start, end: filters.end }} onChange={range => setFilters(current => ({ ...current, ...range }))} maxDate="2026-09-08" today="2026-09-10" maxDays={366} />} scope={filterDensity !== "narrow" && scopeControl} filters={filterDensity === "wide" ? channelControl : <FilterPopover active={filters.channel !== "all" || (filterDensity === "narrow" && (filters.scope !== "all" || filters.comparison !== "none"))}>{filterDensity === "narrow" && scopeControl}{channelControl}{filterDensity === "narrow" && comparisonControl}</FilterPopover>} comparison={filterDensity !== "narrow" && comparisonControl} apply={<Button variant="primary" size="sm" onClick={() => { setApplied({ ...filters }); setDetail(resetAcquisitionPages); setNotice(""); }}>应用</Button>} />
        </section>
        <div className="acquisition-preview__actions" aria-label="看板操作">
      <DashboardActions favorite={<Action label={favorite ? "取消收藏" : "收藏看板"} pressed={favorite} onClick={() => { try { setPreviewFavorite("5.7", !favorite); setNotice(favorite ? "已取消本地收藏。" : "已收藏在当前浏览器，刷新后仍保留；正式账号收藏尚未接入。"); } catch { setNotice("浏览器未允许保存收藏，请检查本地存储权限后重试。", true); } }}><Star aria-hidden="true" fill={favorite ? "currentColor" : "none"} /></Action>} copyLink={<Action label="复制当前视图链接" onClick={async () => { if (pending) { setNotice("请先应用筛选条件，再复制当前视图。"); return; } const href = location.origin + acquisitionViewHref({ v: 2, filters: applied, detail, mixed }); try { await navigator.clipboard.writeText(href); setNotice("已复制当前体验视图，链接会还原筛选、明细页签及各区块的排序和搜索；仅在可访问此本地服务的浏览器使用。"); } catch { open("复制当前视图链接", <><p>浏览器未允许自动复制，请手动复制以下链接。</p><textarea aria-label="当前视图链接" readOnly value={href} style={{ width: "100%", minHeight: 120 }} onFocus={event => event.currentTarget.select()} /></>); } }}><Copy aria-hidden="true" /></Action>} refresh={<Action label="刷新演示快照" onClick={() => { setRecovered([]); setNotice("已重新载入固定演示快照，未请求正式业务数据。"); }}><RefreshCw aria-hidden="true" /></Action>} fullscreen={<Action label="切换全屏" onClick={async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.current?.requestFullscreen(); } catch { setNotice("当前浏览器不支持全屏，可收起左侧目录扩大阅读区域。"); } }}><Maximize2 aria-hidden="true" /></Action>} exportAction={<PreviewExportControl name="获客与新增" iconOnly scope="查询条件、九项指标摘要与逐日趋势、增长效果完整明细、首次激活质量、独立渠道结算和数据状态与限制。缺失与不支持项保留说明。" context={`${applied.start} 至 ${applied.end}；演示快照。`} pending={pending || !supported} onDownloadPreview={() => exportAcquisition(applied, mixed, recovered)} />} />
    </div>
      </div>
      {pending && <span className="acquisition-preview__pending" role="status">条件尚未应用</span>}
    </DashboardHeader>
    {notice && <Toast notice={notice} onClose={() => setNotice("")} />}
    {!supported ? <StatePanel kind="empty" title="此条件暂不可展示" description="演示支持截至 2026-09-08、最多 366 天的任意日期范围。业务范围请选择大盘整体、全部来源渠道，并使用上一等长周期或不对比。其他条件尚未提供演示快照。" action={{ label: "恢复默认体验", onClick: reset }} /> : <>
      <section aria-label="获客阶段与转化"><DashboardSectionHeading title="获客阶段与转化" guidanceKey="acquisition.stages" />{renderCards(ACQUISITION_IDS.slice(0, 6))}</section>
      <AcquisitionVisuals filters={applied} mixed={mixed} pending={pending} onOpen={open} onLocate={dimension => { setDetail(current => ({ ...current, tab: "growth" })); requestAnimationFrame(() => { const target = root.current?.querySelector<HTMLElement>(`[data-acquisition-section="${dimension}"]`); target?.scrollIntoView({ behavior: "smooth", block: "start" }); target?.focus({ preventScroll: true }); }); }}/>
      <AcquisitionDetails filters={applied} comparisonEnabled={compared} mixed={mixed} open={open} detail={detail} update={patch => setDetail(current => ({ ...current, ...patch }))} onExport={scope => exportAcquisition(applied, mixed, recovered, scope)} pending={pending} />
      <section aria-label="首次激活质量"><DashboardSectionHeading title="首次激活质量" guidanceKey="acquisition.activation" />{renderCards(ACQUISITION_IDS.slice(6))}</section>
    </>}
    {dialog && <DetailDialog {...dialog} onClose={() => setDialog(null)} />}
  </div>;
}

function AcquisitionDetails({ filters, comparisonEnabled, mixed, open, detail, update, onExport, pending }: { filters: AcquisitionFilters; comparisonEnabled: boolean; mixed: boolean; open: (title: string, content: ReactNode) => void; detail: AcquisitionViewState["detail"]; update: (patch: Partial<AcquisitionViewState["detail"]>) => void; onExport: (scope: "growth" | "settlement") => void; pending: boolean }) {
  const section = (key: AcquisitionDetailKey) => <AcquisitionDetailSection key={key} dimension={key} filters={filters} comparisonEnabled={comparisonEnabled} mixed={mixed} open={open} detail={detail.sections[key]} update={patch => update({ sections: { ...detail.sections, [key]: { ...detail.sections[key], ...patch } } })} onExport={onExport} pending={pending} />;
  return <section className="acquisition-preview__details" aria-label="获客明细">
    <DashboardSectionHeading title="获客明细" guidanceKey="acquisition.detail" />
    <TabList label="明细用途" value={detail.tab} items={[{ id: "growth", label: "增长效果" }, { id: "settlement", label: "渠道结算" }]} idPrefix="acquisition" panelId="acquisition-detail-panel" onChange={tab => update({ tab: tab as "growth" | "settlement" })} />
    <div id="acquisition-detail-panel" className="acquisition-preview__detail-stack" role="tabpanel" aria-labelledby={`acquisition-${detail.tab}`}>
      {detail.tab === "settlement" ? section("settlement") : <>{section("channel")}{section("target")}{section("type")}</>}
    </div>
  </section>;
}

function AcquisitionDetailSection({ dimension, filters, comparisonEnabled, mixed, open, detail, update, onExport, pending }: { dimension: AcquisitionDetailKey; filters: AcquisitionFilters; comparisonEnabled: boolean; mixed: boolean; open: (title: string, content: ReactNode) => void; detail: AcquisitionDetailReading; update: (patch: Partial<AcquisitionDetailReading>) => void; onExport: (scope: "growth" | "settlement") => void; pending: boolean }) {
  const { search, showChange, page, sort } = detail;
  const live=useLiveDashboard(), connected=Boolean(live&&dimension==="type");
  if(connected)comparisonEnabled=Boolean(live?.comparison);
  const readingRange=connected?{start:live!.query.dateRange[0],end:live!.query.dateRange[1]}:filters;
  const baselineRange=connected&&live!.comparison?{start:live!.comparison.query.dateRange[0],end:live!.comparison.query.dateRange[1]}:undefined;
  const setSearch = (search: string) => update({ search: search.slice(0, 120), page: 0 }), setShowChange = (showChange: string) => update({ showChange }), setPage = (page: number) => update({ page }), setSort = (sort: typeof detail.sort) => update({ sort, page: 0 });
  const settlement = dimension === "settlement";
  const channelQuality = dimension === "channel";
  const label = settlement ? "渠道结算（扣后）" : DIMENSIONS.find(item => item.value === dimension)!.label;
  const ids = settlement ? ["M011"] : DETAIL_METRICS[dimension];
  const sortId = ids.includes(sort.id) ? sort.id : ids[0];
  const source: ReturnType<typeof acquisitionRows> = connected ? [{name:"自然新增",id:"M008.nature"},{name:"内部导量",id:"M008.internal"}].map(group=>{
    const read=(before=false)=>{const resource=before?live!.comparison?.state:live!.state,series=resource?.status==="success"&&resource.data?.data.query.pid===live!.query.pid?resource.data.data.series.find(s=>s.metric.id===group.id):undefined;return series?.points.length&&series.points.every(point=>point.state==="available")?series.points.reduce((sum,point)=>sum+point.value!,0):null;};
    return{name:group.name,values:{M008:read()},baseline:{M008:read(true)},state:read()===null?(live!.state.status==="failure"?"读取失败":"本期部分日期未返回"):"待验数"};
  }) : acquisitionRows(settlement ? "settlement" : dimension, filters);
  const exportType=()=>{
    if(!live||!live.canExport||pending||live.controls.dirty||live.state.status!=="success")return;
    const periods=[{label:"当前",result:live.state.data},...(live.comparison?.state.status==="success"&&live.comparison.state.data?[{label:"对比",result:live.comparison.state.data}]:[])];
    downloadPreviewWorkbook("获客类型",[{name:"数据说明",rows:liveExportMetadata(live)},{name:"获客类型",rows:[["周期","日期","平台","获客类型","新增人数","状态","查询时间","刷新状态"],...periods.flatMap(period=>period.result.data.series.filter(s=>["M008.nature","M008.internal"].includes(s.metric.id)).flatMap(s=>s.points.map(p=>[period.label,p.date,live.query.pid,s.metric.name,p.value,livePointStateLabel(p),period.result.data.fetchedAt,livePeriodStatus(live,period.label==="对比")])))]}], "pending");
  };
  const rows = source.filter(row => row.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a, b) => ((a.values[sortId] ?? -Infinity) - (b.values[sortId] ?? -Infinity)) * (sort.descending ? -1 : 1));
  const pageCount = Math.max(1, Math.ceil(rows.length / 50)), currentPage = Math.min(page, pageCount - 1);
  const showSearch = channelQuality || settlement || source.length > 8 || search.length > 0;
  const compactControls = !showSearch;
  const controls = (comparisonEnabled || showSearch) && <div className="acquisition-preview__table-controls">
    {comparisonEnabled && <MenuSelect label="变化参考" ariaLabel={`${label}变化参考`} density="compact" value={showChange} onChange={setShowChange} groups={[{ label: "表内辅助比较", options: [{ value: "none", label: "不显示变化" }, { value: "previous", label: "较对比周期" }] }]} />}
    {showSearch && <label className="acquisition-preview__search ui-search"><Search aria-hidden="true" /><input aria-label={`搜索${label}`} placeholder={`搜索${settlement ? "结算渠道" : label}`} value={search} onChange={event => setSearch(event.target.value)} /></label>}
  </div>;
  return <DataOriginProvider value={connected?"pending":"demo"}><section className="v2-table-surface ui-result-table acquisition-preview__detail-block" data-acquisition-section={dimension} aria-label={`${label}明细`} tabIndex={-1}>
    <header><div><div className="acquisition-preview__detail-title">{channelQuality ? <DashboardSectionHeading title={label} guidanceKey="acquisition.channel-quality" /> : <h3>{label}</h3>}<DataOriginBadge/></div><small className="acquisition-preview__table-context">数据区间 {acquisitionRangeLabel(readingRange)}</small></div><div className="acquisition-preview__detail-actions">{compactControls && controls}<PreviewExportControl name={channelQuality ? "渠道质量" : label} scope={settlement ? "全部结算渠道的扣后新增结果，独立于增长口径。" : channelQuality ? "全部渠道的四个指标组与逐日计算输入，不受指标组、搜索及分页限制。" : `全部${label}结果、当前值、基准及状态，不受搜索、分页与变化显隐限制。`} context={acquisitionRangeLabel(readingRange) + (connected?" · 待验数":" · 合成演示数据")} dataOrigin={connected?"live":"demo"} pending={pending||Boolean(connected&&(!live!.canExport||live!.controls.dirty||live!.state.status!=="success"))} onDownloadPreview={()=>connected?exportType():channelQuality?exportChannelQuality(filters,mixed):settlement?onExport("settlement"):downloadPreviewWorkbook(label,acquisitionDimensionWorkbook(filters,dimension as "target"|"type"))} /></div></header>
    {!compactControls && controls}
      {channelQuality ? <ChannelQuality filters={filters} mixed={mixed} pending={pending} detail={detail} update={update} open={open} /> : <>
      <p className="acquisition-preview__section-note">{settlement ? "扣后新增仅用于渠道结算核对，不用于增长、转化或留存分母。" : dimension === "target" ? "下载目标不是客户端平台；当前维度不展示不兼容的注册转化率。" : dimension === "type" ? "获客类型只展示新增用户数，不把新老用户作为整板筛选。" : "包含未归类渠道与去重诊断；注册转化仅供趋势参考。"}</p>
      <div className="v2-table-scroll ui-result-table__viewport" tabIndex={0} role="region" aria-label={`${label}完整明细`}><table className={`acquisition-preview__table${dimension === "type" ? " acquisition-preview__type-values" : ""}`}><thead><tr><th>{settlement ? "结算渠道" : label}</th>{ids.map(id => <th key={id} className="is-number" aria-sort={sortId === id ? sort.descending ? "descending" : "ascending" : "none"}><div className="acquisition-preview__column"><FloatingHint content={acquisitionMetric(id).definition} pinOnClick><button type="button" aria-label={`查看${acquisitionMetric(id).name}说明`} onClick={() => open(acquisitionMetric(id).name, <p>{acquisitionMetric(id).definition}</p>)}>{acquisitionMetric(id).name}<Info aria-hidden="true" /></button></FloatingHint><button type="button" aria-label={`排序${acquisitionMetric(id).name}`} onClick={() => setSort({ id, descending: sortId === id ? !sort.descending : true })}>{sortId === id ? sort.descending ? <ArrowDown /> : <ArrowUp /> : <ArrowUpDown />}</button></div></th>)}<th>状态</th></tr></thead>
        <tbody>{rows.slice(currentPage * 50, currentPage * 50 + 50).map(row => <tr key={row.name}><td>{row.name}</td>{ids.map(id => { const value = mixed && row.name === "未归类" && id === "M099" ? null : row.values[id] ?? null; const comparison = fixtureComparison(id, value, row.baseline[id] ?? null, readingRange, baselineRange); const detail = (onEmphasis: boolean) => comparisonEnabled ? <ComparisonDetails comparison={comparison} onEmphasis={onEmphasis} /> : <div className="ui-comparison-details__row"><strong>{fixtureValue(id, value)}</strong><small>{acquisitionRangeLabel(readingRange)} · {connected?"待验数":"演示数据"}</small></div>; return <td key={id} className="is-number"><FloatingHint content={detail(true)}><button type="button" className="acquisition-preview__value" aria-label={`${row.name} · ${acquisitionMetric(id).name}详情`} onClick={() => open(`${row.name} · ${acquisitionMetric(id).name}`, detail(false))}>{fixtureValue(id, value, false)}</button></FloatingHint>{comparisonEnabled && showChange !== "none" && <div className="ui-metric-comparison"><ChangeValue direction={comparison.status === "available" ? comparison.direction : null}>{comparison.status === "available" ? comparison.display : "不可比"}</ChangeValue></div>}</td>; })}<td>{mixed && row.name === "未归类" && ids.includes("M099") ? "部分" : row.state}</td></tr>)}{rows.length === 0 && <tr><td colSpan={ids.length + 2}>没有匹配的维度结果</td></tr>}</tbody>
      </table></div>
      <Pagination label={`${label}分页`} total={rows.length} page={currentPage} pageSize={50} onPage={setPage} />
      </>}
  </section></DataOriginProvider>;
}
