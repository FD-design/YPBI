import { ReviewTools } from "../components/ReviewTools";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { readPreviewQuery } from "./preview-query";
import { usePreviewQuery } from "./usePreviewQuery";
import { Copy, Maximize2, RefreshCw, Search, Star } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { DateRangePicker, type DateRangeValue } from "../../components/ui/DateRangePicker";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { FloatingHint } from "../../components/ui/FloatingHint";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import { FilterPopover } from "../../components/ui/FilterPopover";
import { DashboardHeader, DashboardPanel as Panel, DashboardSectionHeading } from "../features/dashboards/DashboardPresentation";
import { topicLabels, retentionDayLabel } from "./topic-preview-labels";
import { Toast, useToast } from "../../components/ui/Toast";
import { Chart } from "../../components/Chart";
import { DashboardActions, DashboardQueryFields } from "../features/dashboards/DashboardToolbar";
import { PreviewMetricCard } from "./PreviewMetricCard";
import { MetricReadingDialog } from "../features/dashboards/MetricReadingDialog";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { ProductLink } from "../app/router";
import { previewFavorites, setPreviewFavorite } from "./preview-favorites";
import { downloadPreviewWorkbook, type WorkbookSheet } from "./preview-workbook";
import { DEFAULT_TOPIC_VIEW, DEFAULT_TOPIC_READING, DEFAULT_TOPIC_SCOPE, parseTopicView, topicHref, type TopicView, type TopicReading, type TopicScope } from "./topic-preview-view";
import { RETENTION_WINDOWS, previousRange, END, MIN, REGISTER_IDS, WATCH_RETENTION_IDS, contentRows, TOPIC_PREVIEW_MARKER, cohortRows, monthCard, rangeLabel, structureRows, topicDailyCard, topicMetric, topicValue, contentValue, contentBaseline, topicUnit, type CohortRow, type StructureRow } from "./topic-preview-fixtures";
import { cohortExport, metricRows, rankingExport, structureExport, topicMetadata, topicLimits } from "./topic-preview-export";
import "./topic-previews.css";

import { CHART_PALETTE } from "../../theme/tokens";
import { RetentionMatrix } from "../features/dashboards/RetentionMatrix";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { shiftDate } from "../../components/ui/date-range-model";
import { GroupedTrend } from "../features/dashboards/GroupedTrend";
import { structureDaily } from "./topic-preview-fixtures";
import { structureDetailExport } from "./topic-preview-export";
import { useLiveDashboard, LiveDashboardContext } from "../features/dashboards/LiveDashboardContext";
import { DataOriginProvider } from "../components/DataOrigin";
import { ConnectedCohorts, useCohortReading } from "./ConnectedCohorts";
import { ConnectedStructureContent, liveStructureIds } from "./ConnectedStructure";
import { WatchingRetentionDiagnosis } from "./WatchingRetentionDiagnosis";
import { WatchDurationOverview } from "./WatchDurationOverview";
import { demoWatchingOutcomes, watchingOutcomesSheet } from "./watching-retention-diagnosis-model";
import { TopicScopeAnalysis } from "./TopicScopeAnalysis";
import { topicScopeExport, topicUsesLiveScopes } from "./topic-scope-model";
import { HORIZONTAL_BAR_GRID, horizontalBarEndLabel } from "./horizontal-bar-reading";
const TopicContext = createContext(true);
type Open = (title: string, content: ReactNode) => void;
function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[] }) {
  return <MenuSelect label={label} ariaLabel={label} value={value} onChange={onChange} density="compact" groups={[{ label, options }]} />;
}
function Export({ name, sheets, view, pending = false, iconOnly = false }: { name: string; sheets: WorkbookSheet[]; view: TopicView; pending?: boolean; iconOnly?: boolean }) {
  const registered = useContext(TopicContext);
  return <PreviewExportControl name={name} scope="当前区域完整聚合结果，包括实际日期、指标定义版本和数据状态；分页、搜索与图形窗口不裁剪导出。" context="固定合成演示数据 · 正式查询未接入" pending={pending} iconOnly={iconOnly} onDownloadPreview={() => downloadPreviewWorkbook(name, [topicMetadata(view, registered), ...sheets, topicLimits()])} />;
}
function DateField({ label, value, onChange, quick=false }: { label: string; value: DateRangeValue; onChange: (range: DateRangeValue) => void; quick?:boolean }) {
  const picker=useRef<HTMLDivElement>(null);
  const live=useLiveDashboard(),end=live?.query.dateRange[1]??END,today=live?new Date(Date.now()+8*3600000).toISOString().slice(0,10):"2026-09-10";
  const selected=value.end===end&&value.start===shiftDate(end,-6)?"7":value.end===end&&value.start===shiftDate(end,-29)?"30":"custom";
  return <div className="topic-preview__date" role="group" aria-label={label}><span>{label}</span>{quick&&<SegmentedControl label={label+"范围"} value={selected} options={[{value:"7",label:"近7日"},{value:"30",label:"近30日"},{value:"custom",label:"自定义"}]} onChange={next=>{if(next==="custom")picker.current?.querySelector<HTMLButtonElement>("button")?.click();else onChange({start:shiftDate(end,1-Number(next)),end});}}/>}<div ref={picker}><DateRangePicker value={value} onChange={onChange} today={today} maxDate={live?today:END} minDate={live?undefined:MIN} maxDays={live?366:180} /></div></div>;
}
function Card({ model, view, pending, open, retry, compact = false }: { model: DashboardMetricCardModel; view: TopicView; pending: boolean; open: Open; retry: () => void; compact?: boolean }) {
  return <PreviewMetricCard model={model} open={open} retry={retry} compact={compact} exportAction={<Export name={model.metric.name + "同口径数据表"} sheets={[{ name: "01_同口径数据表", rows: metricRows([model]) }]} view={view} pending={pending || model.result.status !== "available"} />} />;
}

function CohortMatrix({ title, rows, view, pending, open, sheetName }: { title: string; rows: CohortRow[]; view: TopicView; pending: boolean; open: Open; sheetName: string }) {
  const live = useLiveDashboard();
  if (live && rows[0]?.cells.some(cell => cell.id === "M020")) return <ConnectedCohorts title={title} live={live} range={view.cohort} pending={pending} open={open} />;
  const ids = rows[0]?.cells.map(cell => cell.id) ?? [];
  const copy = topicLabels(ids.includes("M020"));
  return <Panel title={title} note={copy.date + " " + rangeLabel(view.cohort) + " · 大盘整体 · 观察期未结束的用户不计入汇总"}>
    <RetentionMatrix title={title} rows={rows} columns={ids.map(id => ({id,name:topicMetric(id).name,label:retentionDayLabel(RETENTION_WINDOWS[id]),definition:topicMetric(id).definition}))} dateLabel={copy.date} baseLabel={copy.people} onOpen={open} resetKey={JSON.stringify(view.cohort)} tools={<Export name={title} view={view} pending={pending} sheets={[{name:sheetName,rows:cohortExport(rows,copy.date,copy.people)}]} />} />
  </Panel>;
}
function Structure({ title, id, setId, dimension, setDimension, rows, view, pending, active, open, scope, onScope }: { title: string; id: string; setId: (id: string) => void; dimension: string; setDimension: (dimension: string) => void; rows: StructureRow[]; view: TopicView; pending: boolean; active: boolean; open: Open; scope: TopicScope; onScope: (scope: TopicScope) => void }) {
  const live=useLiveDashboard(),audienceMode=["platform","users","cross"].includes(dimension),connected=audienceMode?topicUsesLiveScopes(live,id):Boolean(liveStructureIds(live,id,dimension));
  const exported = <Export name={title} view={view} pending={pending} sheets={[{ name: active ? "02_活跃结构" : "02_消费结构", rows: [...structureExport(rows, id, view.compared),[],...structureDetailExport(dimension,id,view)] }]} />;
  const context = `${topicMetric(id).name} · ${rangeLabel(view.active)}`;
  const table = <PaginatedTable label={`${title}完整明细`} tableClassName="topic-preview__structure-table" columnCount={view.compared ? 4 : 2} resetKey={JSON.stringify([dimension, id, view.active])} head={<tr><th>维度值</th><th>{topicMetric(id).name}</th>{view.compared && <><th>对比值</th><th>差值{topicUnit(id) === "%" ? "（百分点）" : ""}</th></>}</tr>} rows={rows.map(row => <tr key={row.label}><td>{row.label}</td><td>{topicValue(id, row.current)}</td>{view.compared && <><td>{topicValue(id, row.previous)}</td><td>{topicValue(id, row.current - row.previous, false)}</td></>}</tr>)} />;
  return <DataOriginProvider value={connected?"pending":"demo"}><Panel className="topic-preview__structure" title={title} note={connected?`${topicMetric(id).name} · ${live!.query.dateRange.join(" 至 ")} · ${live!.platformName}`:context} tools={<>
    {!active && <SegmentedControl label={`${title}维度`} value={audienceMode?"platform":dimension} onChange={setDimension} options={[{ value: "platform", label: "客户端与新老用户" }, { value: "acquisition", label: "获客类型" }, { value: "channel", label: "来源渠道" }]} />}
    {!active && <Select label="消费结构指标" value={id} onChange={setId} options={["M026", "M101", "M102", "M081", "M036"].map(value => ({ value, label: topicMetric(value).name }))} />}
  </>}>
    {audienceMode ? <TopicScopeAnalysis title={title} id={id} view={view} scope={scope} onChange={onScope} pending={pending} open={open}/> : connected ? <ConnectedStructureContent live={live!} title={title} id={id} dimension={dimension} open={open}/> : rows.length<=6 ? <GroupedTrend title={title} groups={rows.map((row,i)=>({id:row.label,label:row.label,color:CHART_PALETTE[i%CHART_PALETTE.length]}))} points={structureDaily(dimension,id,view.active,view.compared)} queryKey={JSON.stringify([dimension,id,view.active,view.compared])} kind={topicUnit(id)==="%"?"line":"bar"} unit={topicUnit(id)} format={value=>topicValue(id,value)} exportAction={exported} onOpen={open} summary={selected=><div className="topic-preview__group-summary">{rows.filter(row=>selected.includes(row.label)).map(row=><section key={row.label}><span>{row.label}</span><strong>{topicValue(id,row.current)}</strong><small>{["M016","M026"].includes(id)?"所选范围日均":context}</small></section>)}</div>} /> : <>
      <Chart theme="v13" ariaLabel={`${title}分类比较`} style={{ height: 350 }} option={{ grid: { left: 100, right: HORIZONTAL_BAR_GRID.right, top: 24, bottom: 35 }, tooltip: { trigger: "axis", valueFormatter: (value: unknown) => topicValue(id, Number(value)) }, xAxis: { type: "value", axisLabel: { formatter: (value: number) => topicValue(id, value, false) } }, yAxis: { type: "category", inverse: true, data: rows.map(row => row.label) }, series: [{ type: "bar", label: horizontalBarEndLabel(value => topicValue(id, value)), name: topicMetric(id).name, data: rows.map(row => row.current), barMaxWidth: 20, itemStyle: { color: CHART_PALETTE[0], borderRadius: [0, 3, 3, 0] } }] }} />
      <ChartDataTable title={`${title}同口径数据表`} exportAction={exported}><p className="dashboard-table-context">{context}{view.compared && ` · 对比日期 ${rangeLabel(previousRange(view.active))}`}</p>{table}</ChartDataTable>
    </>}
  </Panel></DataOriginProvider>;
}
function Ranking({ id, setId, view, pending, open, reading, updateReading }: { id: string; setId: (id: string) => void; view: TopicView; pending: boolean; open: Open; reading: TopicReading; updateReading: (next: Partial<TopicReading>) => void }) {
  const { search, descending } = reading; const setSearch = (search: string) => updateReading({ search }), setDescending = (descending: boolean) => updateReading({ descending });
  const sorted = [...contentRows(view.active)].sort((a, b) => contentValue(b, id) - contentValue(a, id));
  const filtered = sorted.filter(row => `${row.title} ${row.id}`.includes(search.trim()));
  if (!descending) filtered.reverse();
  const exported = <Export name="内容排行" view={view} pending={pending} sheets={[{ name: "05_内容排行", rows: rankingExport(sorted, id, view.compared) }]} />;
  return <Panel title="内容排行" note={topicMetric(id).name + " · " + rangeLabel(view.active) + " · 前 10 项"} tools={<Select label="排行指标" value={id} onChange={next => { setId(next); setDescending(true); }} options={["M101", "M097", "M102", "M034", "M036"].map(value => ({ value, label: topicMetric(value).name }))} />}>
    <Chart theme="v13" ariaLabel="内容排行 Top10" style={{ height: 290 }} option={{ grid: { left: 108, right: HORIZONTAL_BAR_GRID.right, top: 16, bottom: 35 }, tooltip: { trigger: "axis", valueFormatter: (value: unknown) => topicValue(id, Number(value)) }, xAxis: { type: "value", axisLabel: { formatter: (value: number) => topicValue(id, value, false) } }, yAxis: { type: "category", inverse: true, data: sorted.slice(0, 10).map(row => row.title) }, series: [{ type: "bar", label: horizontalBarEndLabel(value => topicValue(id, value)), barMaxWidth: 16, name: topicMetric(id).name, data: sorted.slice(0, 10).map(row => contentValue(row, id)), itemStyle: { color: CHART_PALETTE[0] } }] }} />
    <ChartDataTable title="内容排行同口径数据表" exportAction={exported}>
      <p className="dashboard-table-context">{rangeLabel(view.active)} · 全部内容结果；搜索仅过滤表格，导出保留完整查询。{view.compared && " 对比日期 " + rangeLabel(previousRange(view.active))}</p>
      <div className="topic-preview__table-tools"><Select label="排行顺序" value={descending ? "desc" : "asc"} onChange={value => setDescending(value === "desc")} options={[{ value: "desc", label: "从高到低" }, { value: "asc", label: "从低到高" }]} /><label className="topic-preview__search ui-search"><Search /><input aria-label="搜索内容" placeholder="搜索标题或内容 ID" value={search} onChange={event => setSearch(event.target.value.slice(0, 120))} /></label></div>
    <PaginatedTable tableClassName="topic-preview__ranking" label="内容完整排行" resetKey={`${search}-${id}-${descending}`} columnCount={(id === "M036" ? 8 : 6) + (view.compared ? 2 : 0)} head={<tr><th>名次</th><th>内容名称 / 标识</th><th>类型</th><th>{topicMetric(id).name}</th>{view.compared && <><th>对比值</th><th>差值{topicUnit(id) === "%" ? "（百分点）" : ""}</th></>}{id === "M036" && <><th>有效观看次数</th><th>起播次数</th></>}<th>状态</th><th>详情</th></tr>} rows={filtered.map(row => <tr key={row.id}><td>{sorted.findIndex(item => item.id === row.id) + 1}</td><td>{row.title}<small className="topic-preview__content-id">{row.id}</small></td><td>{row.kind}</td><td>{topicValue(id, contentValue(row, id))}</td>{view.compared && <><td>{topicValue(id, contentBaseline(row, id))}</td><td>{topicValue(id, contentValue(row, id) - contentBaseline(row, id), false)}</td></>}{id === "M036" && <><td>{row.effective.toLocaleString()}</td><td>{row.starts.toLocaleString()}</td></>}<td>完整</td><td><button type="button" onClick={() => open(row.title, <><p>内容 ID：{row.id}（演示标识）</p><p>{rangeLabel(view.active)} · {topicMetric(id).name} {topicValue(id, contentValue(row, id))}</p><p>正式内容标识及分析路由待映射，当前不跳转分析页。</p></>)}>查看详情</button></td></tr>)} />
    </ChartDataTable>
  </Panel>;
}

export default function TopicPreviews({ board }: { board: "5.8" | "5.9" }) {
  const active = board === "5.8", title = active ? "活跃与留存" : "视频消费表现";
  const live=useLiveDashboard();
  const shared = readPreviewQuery();
  const saved=parseTopicView(new URLSearchParams(window.location.search).get("view") ?? "", board,Boolean(live)) ?? parseTopicView(JSON.stringify(window.history.state?.topicView) ?? "", board,Boolean(live));
  const appliedRange=live?{start:live.query.dateRange[0],end:live.query.dateRange[1]}:shared.range;
  const initial = useRef(live?{...(saved??DEFAULT_TOPIC_VIEW),active:appliedRange,cohort:saved&&JSON.stringify(saved.cohort)!==JSON.stringify(saved.active)?saved.cohort:appliedRange,failure:saved?.failure??shared.range,compared:Boolean(live.comparison)}:saved??{ ...DEFAULT_TOPIC_VIEW, active: shared.range, cohort: shared.range, failure: shared.range, compared: shared.compared });
  const [view, setView] = useState(initial.current), [draft, setDraft] = useState(initial.current);
  const cohortReading=useCohortReading(active?live:null,view.cohort);
  usePreviewQuery(view.active, view.compared);
  const [reading, setReading] = useState<TopicReading>(() => ({ ...DEFAULT_TOPIC_READING, ...initial.current.reading, ...(active ? { structureId: "M016" } : {}) }));
  const { dimension, structureId, rankingId } = reading;
  const updateReading = (next: Partial<TopicReading>) => setReading(previous => ({ ...previous, ...next }));
  const setDimension = (dimension: string) => updateReading({ dimension }), setStructureId = (structureId: string) => updateReading({ structureId }), setRankingId = (rankingId: string) => updateReading({ rankingId });
  const [favorite, setFavorite] = useState(() => previewFavorites().includes(board)), [recovered, setRecovered] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; content: ReactNode } | null>(null);
  const root = useRef<HTMLDivElement>(null), { notice, notify } = useToast();
  const [compactQuery, setCompactQuery] = useState(true);
  useEffect(() => { const element = root.current; if (!element) return; const observer = new ResizeObserver(([entry]) => setCompactQuery(entry.contentRect.width < 1160)); observer.observe(element); return () => observer.disconnect(); }, []);
  const pending = JSON.stringify(view) !== JSON.stringify(draft), open: Open = (title, content) => setDialog({ title, content });
  const models = useMemo(() => {
    const ids = active ? ["M016", "M020", "M022", "M024", "M021", "M023", "M100", "M025"] : ["M026", "M101", "M102", "M098", "M081", "M036", "M034", "M035", "M043", ...WATCH_RETENTION_IDS];
    return new Map(ids.map(id => [id, topicDailyCard(id, REGISTER_IDS.includes(id) || WATCH_RETENTION_IDS.includes(id) ? view.cohort : ["M100", "M025"].includes(id) ? view.failure : view.active, view.compared, view.mixed && !(id === "M034" && recovered))]));
  }, [active, view, recovered]);
  const month = useMemo(() => monthCard(view.active, view.compared), [view.active, view.compared]);
  const cohorts = useMemo(() => cohortRows(view.cohort, active ? REGISTER_IDS : WATCH_RETENTION_IDS, view.mixed), [view.cohort, view.mixed, active]);
  const retentionWindow = reading.retentionWindow ?? 1;
  const outcomes = useMemo(() => demoWatchingOutcomes(cohorts, retentionWindow), [cohorts, retentionWindow]);
  const previousOutcomes = useMemo(() => !active && view.compared ? demoWatchingOutcomes(cohortRows(previousRange(view.cohort), WATCH_RETENTION_IDS, view.mixed), retentionWindow) : undefined, [active, view.compared, view.cohort, view.mixed, retentionWindow]);
  const outcomeSheet = watchingOutcomesSheet(outcomes, retentionWindow, previousOutcomes);
  const diagnosisHref = (target: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("board", target);
    url.searchParams.delete("view");
    // Board-specific reading state is not transferable. Only supported shared query survives.
    return url.pathname + url.search;
  };
  const structures = useMemo(() => structureRows(dimension, structureId, view.active), [dimension, structureId, view.active]);
  const structureSheetRows = ["platform", "users", "cross"].includes(dimension) ? topicScopeExport(structureId, view) : [...structureExport(structures, structureId, view.compared), [], ...structureDetailExport(dimension,structureId,view)];
  useEffect(() => { const snapshot = { ...view, reading }; window.history.replaceState({ ...window.history.state, topicView: snapshot }, "", topicHref(board, snapshot)); }, [board, view, reading]);
  const apply = () => { setView(draft); setDialog(null); setRecovered(false); notify("已应用演示条件"); };
  const card = (id: string, compact = false) => <LiveDashboardContext.Provider key={id} value={REGISTER_IDS.includes(id)?cohortReading:live}><Card model={models.get(id)!} compact={compact} view={view} pending={pending} open={open} retry={() => { setRecovered(true); notify("已恢复当前演示指标"); }} /></LiveDashboardContext.Provider>;
  const allSheets: WorkbookSheet[] = active ? [
    { name: "01_活跃核心", rows: metricRows([models.get("M016")!, models.get("M024")!, month]) }, { name: "02_活跃结构", rows: structureSheetRows },
    { name: "03_注册留存", rows: metricRows(REGISTER_IDS.map(id => models.get(id)!)) }, { name: "04_注册留存明细", rows: cohortExport(cohorts) }, { name: "05_再激活", rows: metricRows([models.get("M100")!, models.get("M025")!]) }
  ] : [{ name: "01_消费核心", rows: metricRows(["M026", "M101", "M102", "M098", "M081", "M036"].map(id => models.get(id)!)) }, { name: "02_消费结构", rows: structureSheetRows }, { name: "03_有效观影", rows: metricRows(["M034", "M035", "M043"].map(id => models.get(id)!)) }, { name: "04_有效观影留存", rows: cohortExport(cohorts) }, { name: "05_内容排行", rows: rankingExport(contentRows(view.active), rankingId, view.compared) }, outcomeSheet];
  const icon = (label: string, action: () => void, child: ReactNode, pressed?: boolean) => <FloatingHint content={label}><button className="ui-icon-button" type="button" aria-label={label} aria-pressed={pressed} onClick={action}>{child}</button></FloatingHint>;
  return <TopicContext.Provider value={active}><div ref={root} className="v2-page topic-preview" data-page={active ? "active-retention-preview" : "video-consumption-preview"} data-preview={TOPIC_PREVIEW_MARKER}>
    <ReviewTools><div className="topic-preview__notice"><span>开发环境体验 · 合成演示数据，非正式业务结果</span><div role="group" aria-label="演示状态"><Button variant={!view.mixed ? "primary" : "secondary"} onClick={() => { setView({ ...view, mixed: false }); setDraft({ ...draft, mixed: false }); setRecovered(false); }}>正常态</Button><Button variant={view.mixed ? "primary" : "secondary"} onClick={() => { setView({ ...view, mixed: true }); setDraft({ ...draft, mixed: true }); setRecovered(false); }}>组合异常态</Button></div></div></ReviewTools>
    <DashboardHeader className="topic-preview__head" title={title} breadcrumb={"公共概览 / " + (active ? "用户生命周期" : "内容消费与互动")} description={active ? "观察活跃规模、用户结构与注册留存；留存按各批次的实际观察窗口与成熟状态阅读。" : "观察视频消费规模、有效观影、内容贡献与观看后留存；人数、次数和时长按各自统计规则阅读。"}><div className="topic-preview__toolbar"><div className="topic-preview__query"><DashboardQueryFields date={<DateField label="统计日期" value={draft.active} onChange={range => setDraft({ ...draft, active: range })} />} scope={!compactQuery && <span className="topic-preview__scope">大盘整体</span>} filters={<FilterPopover active={draft.cohort.start !== draft.active.start || draft.cohort.end !== draft.active.end || (active && (draft.failure.start !== draft.active.start || draft.failure.end !== draft.active.end))}>
{compactQuery && <span className="topic-preview__scope">大盘整体</span>}<DateField quick label={topicLabels(active).date} value={draft.cohort} onChange={range => setDraft({ ...draft, cohort: range })} />{active && <DateField label="首次体验失败日期" value={draft.failure} onChange={range => setDraft({ ...draft, failure: range })} />}<p className="topic-preview__filter-note">各日期独立作用于对应结果，完成后统一应用。</p>{compactQuery && <Select label="对比周期" value={draft.compared ? "previous" : "none"} onChange={value => setDraft({ ...draft, compared: value === "previous" })} options={[{ value: "previous", label: "上一等长周期" }, { value: "none", label: "不对比" }]} />}</FilterPopover>} comparison={!compactQuery && <Select label="对比周期" value={draft.compared ? "previous" : "none"} onChange={value => setDraft({ ...draft, compared: value === "previous" })} options={[{ value: "previous", label: "上一等长周期" }, { value: "none", label: "不对比" }]} />} apply={<Button variant="primary" onClick={apply}>应用</Button>} /></div><div className="topic-preview__actions"><DashboardActions favorite={icon(favorite ? "取消收藏" : "收藏看板", () => { try { setPreviewFavorite(board, !favorite); setFavorite(!favorite); notify(favorite ? "已取消收藏" : "已加入我的收藏（仅本机）"); } catch { notify("本机存储不可用，未保存收藏"); } }, <Star fill={favorite ? "currentColor" : "none"} />, favorite)} copyLink={icon("复制当前视图链接", () => { const href = new URL(topicHref(board, { ...view, reading }), location.origin).href; navigator.clipboard.writeText(href).then(() => notify("已复制当前视图链接")).catch(() => open("复制当前视图链接", <textarea readOnly aria-label="当前视图链接" value={href} />)); }, <Copy />)} refresh={icon("刷新看板", () => { setRecovered(false); notify("演示快照已重新载入；未请求正式业务数据"); }, <RefreshCw />)} fullscreen={icon("全屏查看", () => { (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen())?.catch(() => notify("当前环境不支持全屏查看")); }, <Maximize2 />)} exportAction={<Export name={title} view={{...view,reading}} sheets={allSheets} pending={pending} iconOnly />} /></div></div></DashboardHeader>
    {pending && <p className="topic-preview__pending" role="status">条件尚未应用 · 当前结果仍对应已应用条件 <Button onClick={apply}>应用</Button></p>}
    {active ? <>
      <section aria-label="核心判断"><DashboardSectionHeading title="核心判断" /><div className="topic-preview__grid is-two">{["M016", "M020", "M022", "M024"].map(id => card(id))}</div></section>
      <section aria-label="活跃规模与结构"><DashboardSectionHeading title="活跃规模与结构" /><div className="topic-preview__grid is-two"><Card model={month} view={view} pending={pending} open={open} retry={() => {}} /><Structure active title="活跃结构" id={structureId} setId={setStructureId} dimension={dimension} setDimension={setDimension} rows={structures} view={view} pending={pending} open={open} scope={reading.scope ?? DEFAULT_TOPIC_SCOPE} onScope={scope => updateReading({scope})} /></div></section>
      <DataOriginProvider value={null}><Panel title="整体活跃次日回访" note="指标登记与同批用户结果待开发支持">
        <p className="topic-preview__description">当前没有可用的同批结果，不展示估算值；新用户次留和存量用户复访分别保留，不能相加代替总体。</p>
      </Panel></DataOriginProvider>
      <section aria-label="注册留存详情"><DashboardSectionHeading title="注册留存详情" /><div className="topic-preview__grid is-two">{card("M021", true)}{card("M023", true)}</div><LiveDashboardContext.Provider value={cohortReading}><CohortMatrix title="注册留存明细" rows={cohorts} view={view} pending={pending} open={open} sheetName="04_注册留存明细" /></LiveDashboardContext.Provider></section>
      <section aria-label="首次体验失败用户再激活"><DashboardSectionHeading title="首次体验失败用户再激活" /><p className="topic-preview__description">首次体验失败日期 {rangeLabel(view.failure)} · 分别观察后续 48 / 72 小时的再次激活情况。</p><div className="topic-preview__grid is-two">{card("M100")}{card("M025")}</div></section>
    </> : <>
      <section aria-label="消费核心结果"><DashboardSectionHeading title="消费核心结果" /><div className="topic-preview__grid is-three">{["M026", "M101", "M102", "M098", "M081", "M036"].map(id => card(id))}</div></section>
      <WatchDurationOverview models={[models.get("M102")!, models.get("M098")!]} exportDemo={model => <Export name={model.metric.name + "同口径数据表"} view={view} pending={pending} sheets={[{ name: "01_时长明细", rows: metricRows([model]) }]} />} />
      <Structure active={false} title="消费结构" id={structureId} setId={setStructureId} dimension={dimension} setDimension={setDimension} rows={structures} view={view} pending={pending} open={open} scope={reading.scope ?? DEFAULT_TOPIC_SCOPE} onScope={scope => updateReading({scope})} />
      <section aria-label="有效观影"><DashboardSectionHeading title="有效观影" /><div className="topic-preview__grid is-three">{["M034", "M035", "M043"].map(id => card(id))}</div></section>
      <section aria-label="观影与留存诊断"><DashboardSectionHeading title="观影与留存诊断" /><p className="topic-preview__description">首次有效观看日期 {rangeLabel(view.cohort)} · 仅纳入观察期已结束的用户，与注册留存独立。</p><div className="topic-preview__grid is-three">{WATCH_RETENTION_IDS.map(id => card(id, true))}</div><CohortMatrix title="有效观影留存明细" rows={cohorts} view={view} pending={pending} open={open} sheetName="04_有效观影留存" /><WatchingRetentionDiagnosis rows={outcomes} previous={previousOutcomes} window={retentionWindow} onWindow={retentionWindow => updateReading({ retentionWindow })} href={diagnosisHref} exportAction={<Export name="观影后用户去向" sheets={[outcomeSheet]} view={view} pending={pending} />} /></section>
      <Ranking id={rankingId} setId={setRankingId} view={view} pending={pending} open={open} reading={reading} updateReading={updateReading} />
    </>}
    <p className="topic-preview__description">演示范围：2026-03-13 至 2026-09-08，最多 180 天。正式 PID、维度与内容标识的查询准入独立验证；注册留存来源渠道尚待权威登记。</p>
    {dialog && <MetricReadingDialog {...dialog} onClose={() => setDialog(null)} />}{notice && <Toast notice={notice} onClose={() => notify(null)} />}
  </div></TopicContext.Provider>;
}
