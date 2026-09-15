import { ReviewTools } from "../components/ReviewTools";
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Copy, Download, Plus, Save, Search, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { DateRangePicker } from "../../components/ui/DateRangePicker";
import { TabList } from "../../components/ui/TabList";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { FunnelQueryBuilder, FunnelResultView, exportFunnel } from "./FunnelAnalysisPreview";
import { Chart } from "../../components/Chart";
import { chartValueExtent } from "../../components/chart-axis";
import { metricHeadingUnit } from "../../components/metric-unit";
import { PaginatedLegend } from "../../components/ui/PaginatedLegend";
import { TrendRange, useTrendRange } from "../../components/ui/TrendRange";
import { CHART_PALETTE } from "../../theme/tokens";
import { MetricSummary } from "../features/dashboards/MetricSummary";
import type { AnalysisSeries } from "./personal-query-preview";
import { Toast, useToast } from "../../components/ui/Toast";
import { DashboardHeader } from "../features/dashboards/DashboardPresentation";
import { MetricReadingDialog } from "../features/dashboards/MetricReadingDialog";
import { StatePanel } from "../components/StatePanel";
import { navigate, ProductLink, useBrowserLocation } from "../app/router";
import { downloadPreviewWorkbook } from "./preview-workbook";
import { addAnalysisToBoard, stageAnalysisDraft, readAnalysisDraft, clearAnalysisDraft, analysisFingerprint, emptyAnalysis, localId, personalHref, readWorkspace, removePersonalObject, saveWorkspaceObject, subscribeWorkspace, validName, type AnalysisConfig, type AnalysisKind, type PersonalBoard, type QuickOverview, type SavedAnalysis } from "./personal-workspace-model";
import { configurationError, quickMetricDate, quickSampleChange, quickPlatformSample, quickPlatformChange, PREVIEW_EVENTS, PREVIEW_METRICS, previewDateLimits, queryAnalysisPreview, resultRows, workspaceEvents, workspaceMetrics, workspacePlatforms, type AnalysisResult } from "./personal-query-preview";
import { metricBusinessExplanation } from "../features/metrics/metric-presentation";
import { resultPresentation } from "./analysis-presentation";
import { groupFields, drillEventConfig, fieldLabel } from "./event-analysis-preview";
import { QuerySelect } from "./AnalysisQueryBuilder";
import { AnalysisQueryBuilder, analysisSummary } from "./AnalysisQueryBuilder";
import { shiftDate } from "../../components/ui/date-range-model";
import "./personal-workspace-preview.css";
import { PreviewBoardPresentation } from "./PreviewBoardPresentation";
import { DashboardCardModeControl, useDashboardCardMode } from "../features/dashboards/DashboardCardMode";

const useWorkspace = () => useSyncExternalStore(subscribeWorkspace, readWorkspace);
const kindName = (kind: AnalysisKind) => kind === "metrics" ? "指标分析" : kind === "funnels" ? "漏斗分析" : "事件分析";
function useDesktop() {
  const [desktop, setDesktop] = useState(() => window.innerWidth > 1100);
  useEffect(() => { const media = window.matchMedia("(min-width: 1101px)"); const update = () => setDesktop(media.matches); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  return desktop;
}
function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
    const traverse = (event: Event) => {
      if ((event as Event & { navigationType: string }).navigationType === "traverse" && event.cancelable && !window.confirm("当前有未保存配置。确定离开并放弃修改吗？")) event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement)?.closest("a");
      if (!anchor || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || anchor.target === "_blank" || anchor.href === window.location.href) return;
      if (!window.confirm("当前有未保存配置。确定离开并放弃修改吗？")) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", click, true); navigation?.addEventListener("navigate", traverse);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", click, true); navigation?.removeEventListener("navigate", traverse); };
  }, [dirty]);
}
function Select({ label, value, options, onChange, disabled = false }: { label: string; value: string; options: { value: string; label: string; disabled?: boolean; meta?: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <MenuSelect label={label} value={value} groups={[{ label, options }]} onChange={onChange} disabled={disabled} density="compact" />;
}
function NameDialog({ title, initial = "", onClose, onSave }: { title: string; initial?: string; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(initial), [error, setError] = useState("");
  return <MetricReadingDialog title={title} dismissOnBackdrop={false} onClose={() => { if (name === initial || window.confirm("放弃未保存的名称修改吗？")) onClose(); }} content={<form className="personal-form" onSubmit={event => { event.preventDefault(); if (!validName(name)) { setError("请输入1～60个字符的名称。"); return; } try { onSave(name.trim()); } catch (error) { setError((error as Error).message); } }}><label>名称<input aria-label="方案名称" value={name} onChange={event => setName(event.target.value)} maxLength={60} autoFocus /></label><small>仅在本次体验内保存，刷新页面后清空。</small>{error && <p role="alert">{error}</p>}<Button variant="primary" type="submit" icon={Save}>保存本次体验</Button></form>} />;
}
function DefinitionPicker({ kind, onSelect, onClose }: { kind: AnalysisKind; onSelect: (id: string, version: string) => void; onClose: () => void }) {
  const [search, setSearch] = useState(""), [category, setCategory] = useState("all");
  const definitions = kind === "metrics" ? workspaceMetrics.map(item => ({ id: item.id, name: item.name, category: item.classification?.primary ?? "跨分类派生", version: item.authority.version, description: item.authority.definition, sample: PREVIEW_METRICS.has(item.id) })) : workspaceEvents.map(item => ({ id: item.id, name: item.name, category: item.module, version: item.version, description: item.definition, sample: PREVIEW_EVENTS.has(item.id) }));
  const filtered = definitions.filter(item => (category === "all" || item.category === category) && `${item.name} ${item.description} ${kind === "events" ? item.id : ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <MetricReadingDialog title={kind === "metrics" ? "选择指标" : "选择事件"} onClose={onClose} content={<div className="personal-picker"><div className="personal-tools"><label className="ui-search"><Search /><input aria-label="搜索定义" placeholder="搜索名称或定义" value={search} onChange={event => setSearch(event.target.value)} maxLength={120} /></label><Select label="业务分类" value={category} onChange={setCategory} options={[{ value: "all", label: "全部分类" }, ...[...new Set(definitions.map(item => item.category))].map(value => ({ value, label: value }))]} /></div><p className="personal-note">权威定义可用于配置体验。“有样例”仅表示提供合成结果，全部正式能力仍按查询与验数准入。</p><div className="personal-picker__items">{filtered.map(item => <button type="button" key={item.id} onClick={() => { onSelect(item.id, item.version); onClose(); }}><span><b>{item.name}</b><small>{item.category} · {item.version}{kind === "events" ? ` · ${item.id}` : ""}</small><span>{item.description}</span></span><small>{item.sample ? "有样例" : "仅配置"}</small></button>)}{!filtered.length && <StatePanel compact kind="empty" title="没有匹配的定义" description="请调整关键词或分类。" />}</div></div>} />;
}
function ResultTable({ result, onDrill }: { result: AnalysisResult; onDrill?: (series: AnalysisSeries, field: string) => void }) {
  const [layout, setLayout] = useState("flat");
  const dates = [...new Set(result.series.flatMap(s => s.points.map(p => p.date)))];
  const dimensions = groupFields(result.config).filter(f => f.id !== result.config.group && f.id !== result.config.secondaryGroup && !(result.config.filters ?? []).some(filter => filter.field === f.id));
  const groupCell = (series: AnalysisSeries) => <><span>{series.name}</span>{onDrill && Object.keys(series.groupValues ?? {}).length > 0 && dimensions.length > 0 && !series.previous && <QuerySelect label={`继续拆解 ${series.name}`} value="none" options={[{value:"none",label:"继续拆解"}, ...dimensions.map(f => ({value:f.id,label:f.name}))]} onChange={field => { if(field !== "none") onDrill(series, field); }} />}</>;
  return <><div className="analysis-result-actions"><QuerySelect label="明细布局" value={layout} onChange={setLayout} options={[{value:"flat",label:"平铺明细"},{value:"dates",label:"日期展开为列"}]} /><span className="personal-note">完整聚合结果 · 不受图形 Top10 或缩放影响</span></div>
    {layout === "flat" ? <PaginatedTable label="完整聚合结果" columnCount={5} resetKey={result.fingerprint} head={<tr><th>日期 / 实际对比日期</th><th>分析项 / 分组</th><th className="is-numeric">数值</th><th>单位</th><th>状态</th></tr>} rows={result.series.flatMap(series => series.points.map((point, i) => <tr key={`${series.key}:${point.date}`}><td>{point.actualDate}</td><td>{i === 0 ? groupCell(series) : series.name}</td><td className="is-numeric">{point.display}</td><td>{series.unit}</td><td>{point.state}</td></tr>))} />
    : <PaginatedTable label="按日期展开的完整结果" columnCount={dates.length + 2} resetKey={result.fingerprint} head={<tr><th>分析项 / 分组</th><th>区间独立结果</th>{dates.map(date => <th key={date}>{date}</th>)}</tr>} rows={result.series.map(series => <tr key={series.key}><td>{groupCell(series)}</td><td>{series.summary} {series.unit}</td>{dates.map(date => { const p=series.points.find(p=>p.date===date); return <td key={date} title={p?.actualDate}>{p?.display ?? "—"}<small className="personal-cell-note">{p?.state}</small></td>; })}</tr>)} />}</>;
}
function ExportResult({ result, disabled = false }: { result: AnalysisResult; disabled?: boolean }) {
  const [error, setError] = useState("");
  return <><Button icon={Download} disabled={disabled || !result.series.length} onClick={() => { try { if(result.funnel) { exportFunnel(result); return; } downloadPreviewWorkbook("分析合成样例", [{ name: "说明", rows: [["数据", "合成演示，非业务结果"], ["日期", `${result.config.range.start} 至 ${result.config.range.end}`], ["范围", result.config.scope], ["已应用条件", analysisSummary(result.config)], ["配置与引用版本", JSON.stringify(result.config)], ["注意", result.warnings.join("；")]] }, { name: "完整聚合结果", rows: [["日期", "分析项", "数值", "单位", "状态"], ...resultRows(result)] }]); setError(""); } catch { setError("导出失败，请重试。"); } }}>导出样例</Button>{error && <span role="alert">{error}</span>}</>;
}
function ResultChart({ series, unit, view, compact }: { series: AnalysisSeries[]; unit: string; view: "line" | "bar"; compact: boolean }) {
  const dates = [...new Set(series.flatMap(s => s.points.map(point => point.date)))], range = useTrendRange(dates);
  const [hidden, setHidden] = useState<string[]>([]), ratio = ["%", "比例"].includes(unit);
  const extent = chartValueExtent(series.filter(item => !hidden.includes(item.key)).flatMap(item => dates.slice(range.start, range.end + 1).map(date => { const value = item.points.find(point => point.date === date)?.value ?? null; return value === null ? null : ratio ? value * 100 : value; })), view === "bar", ["人", "次"].includes(unit) ? 1 : 0);
  return <section className="personal-result__chart" aria-label={`${unit}趋势图`}>
    <Chart theme="v13" ariaLabel={`${series.map(s => s.name).join("、")}趋势，单位${unit}`} style={{ height: compact ? 220 : 300 }} option={{ animation: false, tooltip: { trigger: "axis", renderMode: "richText", formatter: (params: any[]) => params.map(p => { const s=series[p.seriesIndex], point=s?.points.find(point=>point.date===dates[range.start+p.dataIndex]); return `${p.seriesName} · ${point?.actualDate??"未覆盖"}：${point?.display??"—"} ${unit}`; }).join("\n") }, grid: { left: 50, right: 20, top: 25, bottom: 28, containLabel: true }, xAxis: { type: "category", data: dates.slice(range.start, range.end + 1).map(date => /^\d{4}-/.test(date) ? date.slice(5) : date) }, yAxis: { type: "value", name: ratio ? "" : metricHeadingUnit(series[0].name, unit), ...(extent ? { min: extent.min, max: extent.max, interval: extent.interval } : {}), ...(ratio ? { axisLabel: { formatter: "{value}%" } } : {}) }, series: series.map((s, index) => ({ name: s.name, type: view, itemStyle: { color: CHART_PALETTE[index % CHART_PALETTE.length] }, showSymbol: range.end - range.start < 32, connectNulls: false, lineStyle: { type: s.previous ? "dashed" : "solid" }, data: hidden.includes(s.key) ? [] : dates.slice(range.start, range.end + 1).map(date => { const raw=s.points.find(p=>p.date===date)?.value??null; return raw===null?null:ratio?raw*100:raw; }) })) }} />
    <PaginatedLegend label={`${unit}图例`} items={series.map((s, index) => ({ id: s.key, label: s.name, color: CHART_PALETTE[index % CHART_PALETTE.length], selected: !hidden.includes(s.key) }))} onToggle={id => setHidden(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])} />
    <TrendRange dates={dates} values={series[0].points.map(point => point.value)} start={range.start} end={range.end} onChange={range.setRange} />
  </section>;
}
function ResultView({ result, stale = false, compact = false, ordinary = false, onDrill }: { result: AnalysisResult; stale?: boolean; compact?: boolean; ordinary?: boolean; onDrill?: (series: AnalysisSeries, field: string) => void }) {
  const [view, setView] = useState("line"), [mainItem, setMainItem] = useState(result.config.items[0]?.key), panelId = useId();
  const cardMode = useDashboardCardMode(ordinary && result.config.kind === "metrics" && result.config.items.length === 1 && result.config.group === "none" && result.config.grain !== "total");
  if (result.funnel) return <FunnelResultView result={result} stale={stale} />;
  const selectedItem = result.config.items.some(i=>i.key===mainItem) ? mainItem : result.config.items[0]?.key;
  const presentation = resultPresentation({...result,config:{...result.config,mainItem:selectedItem}});
  const { cross, grouped, ranked, pie } = presentation;
  const allowed = cross ? [{id:"table",label:"交叉明细"}] : [
    ...(result.config.grain !== "total" ? [{id:"line",label:"折线"},{id:"bar",label:"柱状"}] : []),
    ...(grouped ? [{id:"ranking",label:"横向排行"},...(pie ? [{id:"pie",label:"饼图"},{id:"donut",label:"环形图"}] : [])] : []),
    {id:"value",label:"数值"},{id:"table",label:"表格"}];
  const effectiveView = cardMode === "value" ? "value" : allowed.some(v=>v.id===view) ? view : allowed[0].id;
  const summary = (result.totals ?? result.series).filter(series => !series.previous);
  const selectedKeys = new Set(ranked.slice(0,10).map(s=>JSON.stringify(s.groupValues)));
  const chartSeries = grouped ? result.series.filter(s => s.itemKey === selectedItem && selectedKeys.has(JSON.stringify(s.groupValues))) : result.series;
  const units = [...new Set(chartSeries.map(series => series.unit))];
  const categories = (["pie","donut"].includes(effectiveView) ? ranked : ranked.slice(0,10)).map(s=>({name:Object.entries(s.groupValues??{}).map(([field,value])=>fieldLabel(presentation.item.ref,field,value)).join(" / "), value:s.summaryRaw, series:s}));
  return <div className="personal-result" data-stale={stale || undefined}>
    {stale && <p className="personal-warning" role="status">条件已修改，以下仍为上次结果。请重新查询后再导出或加入看板。</p>}
    {result.config.comparison && ["week", "month"].includes(result.config.grain ?? "") && <p className="personal-note">两期分别按自然周／月计算，按时段顺序对齐；实际覆盖日期见悬浮提示和完整表。多出的时段独立保留，不补齐或平均。</p>}
    {result.warnings.map(warning => <p className="personal-warning" key={warning}>{warning}</p>)}
    {!result.series.length ? <StatePanel kind="empty" title="当前配置没有可展示结果" description="请检查筛选条件与数据能力；未接入能力不以其他数据替代。" /> : <>
      <div className="personal-result__head"><span className="personal-note">{result.config.range.start} 至 {result.config.range.end} · 合成样例</span>{cardMode !== "value" && <TabList label="结果展示" value={effectiveView} onChange={setView} panelId={panelId} items={allowed} />}</div>
      <div id={panelId} role="tabpanel">
        <div className="personal-summary">{summary.map(series => <MetricSummary key={series.key} title={series.name} value={series.summary} unit={series.unit} note={series.note} size="supporting" />)}</div>
        {grouped && !cross && <div className="analysis-result-actions"><QuerySelect label="图形主分析项" value={selectedItem} onChange={setMainItem} options={result.config.items.map(i=>({value:i.key,label:(result.totals??[]).find(t=>t.itemKey===i.key&&!t.previous)?.name??i.ref}))} /><span className="personal-note">{ranked.length > 10 ? "图形按当前区间结果固定展示Top10；完整表和导出保留全部。" : "类别图按当前期全区间结果阅读。"} {!pie && presentation.pieReason}</span></div>}
        {cross && <p className="personal-note">二维分组展示真实交叉明细；不将各维度边际汇总拼接，也不绘制大量交叉折线。</p>}
        {["line","bar"].includes(effectiveView) && units.map(unit=><ResultChart key={unit+selectedItem} series={chartSeries.filter(s=>s.unit===unit)} unit={unit} view={effectiveView as "line"|"bar"} compact={compact} />)}
        {["ranking","pie","donut"].includes(effectiveView) && <Chart theme="v13" ariaLabel={effectiveView==="ranking"?"分组排行":"分组构成"} style={{height:320}} option={{animation:false,tooltip:{trigger:"item"},...(effectiveView==="ranking"?{grid:{left:20,right:30,top:20,bottom:24,containLabel:true},xAxis:{type:"value"},yAxis:{type:"category",inverse:true,data:categories.map(c=>c.name)},series:[{type:"bar",data:categories.map(c=>c.value)}]}:{series:[{type:"pie",radius:effectiveView==="donut"?["40%","68%"]:"68%",data:categories.map(c=>({name:c.name,value:c.value})),label:{formatter:"{b}: {d}%"}}]})}} />}
        {cardMode === "value" ? <ChartDataTable title="完整聚合结果" exportAction={<ExportResult result={result} disabled={stale}/>}><ResultTable result={result} onDrill={stale?undefined:onDrill}/></ChartDataTable> : <section className="personal-result__table"><h3>完整聚合结果</h3><ResultTable result={result} onDrill={stale?undefined:onDrill} /></section>}
      </div>
    </>}
  </div>;
}

function AddToBoard({ source, onClose, notify }: { source: SavedAnalysis; onClose: () => void; notify: (message: string) => void }) {
  const { boards } = useWorkspace(); const [selected, setSelected] = useState(""), [name, setName] = useState(""), [error, setError] = useState("");
  return <MetricReadingDialog title="加入我的概览" dismissOnBackdrop={false} onClose={() => { if ((!name && !selected) || window.confirm("放弃当前选择并关闭吗？")) onClose(); }} content={<form className="personal-form" onSubmit={event => { event.preventDefault(); try { let boardId = selected; if (!boardId) { if (!validName(name)) throw new Error("请选择看板或填写新看板名称。"); boardId = localId(); saveWorkspaceObject("boards", { id: boardId, name, revision: 0, components: [], updated: "" }); } addAnalysisToBoard(source.id, boardId); notify("已加入本次体验看板，来源分析独立保留"); onClose(); } catch (error) { setError((error as Error).message); } }}><p>{source.name}</p><Select label="目标看板" value={selected} onChange={setSelected} options={[{ value: "", label: "新建一个看板" }, ...boards.map(board => ({ value: board.id, label: board.name }))]} />{!selected && <label>新看板名称<input aria-label="新看板名称" value={name} maxLength={60} onChange={event => setName(event.target.value)} /></label>}{selected && boards.find(board => board.id === selected)?.components.some(component => component.sourceId === source.id) && <p>该分析已在此看板中；再次加入会创建独立组件，继续引用同一来源。</p>}{error && <p role="alert">{error}</p>}<Button variant="primary" type="submit">确认加入</Button><ProductLink href={personalHref("/dashboards/mine")}>查看我的概览</ProductLink></form>} />;
}

function AnalysisEditor({ kind, id, desktop, notify }: { kind: AnalysisKind; id: string | null; desktop: boolean; notify: (message: string) => void }) {
  const workspace = useWorkspace(), saved = workspace.analyses.find(item => item.id === id && item.config.kind === kind);
  const [config, setConfig] = useState<AnalysisConfig>(() => saved ? structuredClone(saved.config) : readAnalysisDraft(kind) ?? emptyAnalysis(kind));
  const [result, setResult] = useState<AnalysisResult | null>(() => !configurationError(config) ? queryAnalysisPreview(config) : null), [naming, setNaming] = useState<"save" | "as" | null>(null), [add, setAdd] = useState(false), [error, setError] = useState("");
  useEffect(() => clearAnalysisDraft(), []);
  const [trail, setTrail] = useState<AnalysisResult[]>([]);
  const dirty = Boolean(saved ? analysisFingerprint(config) !== analysisFingerprint(saved.config) : config.items.some(item => item.ref));
  useUnsavedWarning(dirty);
  const stale = Boolean(result && result.fingerprint !== analysisFingerprint(config));
  const valid = !configurationError(config), applied = Boolean(result?.series.length && !stale && !result.warnings.length);
  if (id && !saved) return <ExpiredObject />;
  const Builder = kind === "funnels" ? FunnelQueryBuilder : AnalysisQueryBuilder;
  const save = (name: string, asNew = false) => {
    const object = saveWorkspaceObject("analyses", { id: !asNew && saved ? saved.id : localId(), revision: !asNew && saved ? saved.revision : 0, name, config, updated: "" });
    setNaming(null); notify("分析配置已保存到本次体验；未保存结果或同步账号");
    navigate(personalHref(`/analysis/${kind}`, object.id), { replace: Boolean(saved && !asNew) });
  };
  return <>
    <DashboardHeader title={saved?.name ?? `新建${kindName(kind)}`} breadcrumb={`分析中心 / ${kindName(kind)}`} summary={<span>{saved ? dirty ? "配置有未保存修改" : "配置已保存 · 本次体验" : "未保存"} · 权威定义不在此修改</span>}>
      <ProductLink href={personalHref("/analysis/saved")}>已保存的分析</ProductLink>
      <Button icon={Save} disabled={!desktop || !valid} onClick={() => saved ? save(saved.name) : setNaming("save")}>保存配置</Button>
      {saved && <Button disabled={!desktop || !valid} onClick={() => setNaming("as")}>另存为</Button>}
      <Button disabled={!desktop || !saved || dirty || !applied} onClick={() => setAdd(true)}>加入看板</Button>
      {result && <ExportResult result={result} disabled={stale} />}
    </DashboardHeader>
    {!desktop && <p className="personal-note">当前宽度为阅读模式；配置编辑与保存请在桌面宽屏继续。</p>}
    <Builder config={config} onChange={setConfig} desktop={desktop} onQuery={() => { try { setResult(queryAnalysisPreview(config)); setError(""); } catch (error) { setError((error as Error).message); } }} />
    {trail.length > 0 && <Button onClick={() => { if (stale && !window.confirm("返回上层会放弃未查询的条件修改，继续吗？")) return; const previous=trail[trail.length-1]; setConfig(structuredClone(previous.config)); setResult(previous); setTrail(trail.slice(0,-1)); }}>返回上层分析（{trail.length}）</Button>}
    {result && <p className="personal-note">已查询：{analysisSummary(result.config)}</p>}
    <section className="personal-surface personal-analysis-output" aria-label="分析结果">{error && <p role="alert">{error}</p>}{result ? <ResultView result={result} stale={stale} onDrill={(series,field) => {
      try { const next = drillEventConfig(result.config, series.groupValues ?? {}, field); setTrail([...trail,result]); setConfig(next); setError(""); }
      catch (error) { setError((error as Error).message); }
    }} /> : <StatePanel kind="empty" title={valid ? "条件已就绪" : "从选择分析项开始"} description="选择指标或事件，再点击查询样例。" />}</section>
    {naming && <NameDialog title={naming === "as" ? "另存分析" : "保存分析配置"} initial={saved?.name} onClose={() => setNaming(null)} onSave={name => save(name, naming === "as")} />}
    {add && saved && <AddToBoard source={saved} onClose={() => setAdd(false)} notify={notify} />}
  </>;
}
function ExpiredObject() { return <StatePanel kind="empty" title="本次体验对象已失效" description="刷新会清空体验配置；请返回列表重新创建。正式账号对象未被修改。" action={{ label: "返回我的概览", onClick: () => navigate(personalHref("/dashboards/mine")) }} />; }

function SavedAnalysisList({ desktop, notify }: { desktop: boolean; notify: (message: string) => void }) {
  const { analyses } = useWorkspace(); const [search, setSearch] = useState(""), [kind, setKind] = useState("all"), [renaming, setRenaming] = useState<SavedAnalysis | null>(null);
  const rows = analyses.filter(item => (kind === "all" || kind === item.config.kind) && item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <><DashboardHeader title="已保存的分析" breadcrumb="分析中心 / 已保存的分析"><ProductLink href={personalHref("/analysis/metrics")}>新建指标分析</ProductLink><ProductLink href={personalHref("/analysis/events")}>新建事件分析</ProductLink><ProductLink href={personalHref("/analysis/funnels")}>新建漏斗分析</ProductLink></DashboardHeader><div className="personal-surface personal-tools"><label className="ui-search"><Search /><input aria-label="搜索已保存分析" placeholder="搜索名称" value={search} onChange={e => setSearch(e.target.value)} /></label><Select label="分析类型" value={kind} onChange={setKind} options={[{ value: "all", label: "全部类型" }, { value: "metrics", label: "指标分析" }, { value: "events", label: "事件分析" }, { value: "funnels", label: "漏斗分析" }]} /></div><section className="personal-surface"><PaginatedTable label="已保存分析列表" columnCount={5} head={<tr><th>名称</th><th>类型</th><th>分析项</th><th>更新时间</th><th>操作</th></tr>} rows={rows.map(item => <tr key={item.id}><td><ProductLink href={personalHref(`/analysis/${item.config.kind}`, item.id)}>{item.name}</ProductLink></td><td>{kindName(item.config.kind)}</td><td>{item.config.items.length}</td><td>{new Date(item.updated).toLocaleString("zh-CN", { hour12: false })}</td><td><Button size="sm" disabled={!desktop} onClick={() => setRenaming(item)}>改名</Button></td></tr>)} />{!analyses.length && <p className="personal-note personal-inset">在指标分析或事件分析中选择条件并保存，方案会出现在这里。</p>}</section>{renaming && <NameDialog title="重命名分析" initial={renaming.name} onClose={() => setRenaming(null)} onSave={name => { saveWorkspaceObject("analyses", { ...renaming, name }); setRenaming(null); notify("名称已更新，已有看板引用保持不变"); }} />}</>;
}

function PersonalBoards({ id, desktop, notify, embedded = false, boardSearch = "" }: { id: string | null; desktop: boolean; notify: (message: string) => void; embedded?: boolean; boardSearch?: string }) {
  const { boards, analyses } = useWorkspace(); const board = boards.find(item => item.id === id);
  const [localSearch, setSearch] = useState("");
  const search = embedded ? boardSearch : localSearch;
  const [naming, setNaming] = useState<"create" | "rename" | null>(null), [deleting, setDeleting] = useState(false), [draft, setDraft] = useState<PersonalBoard | null>(null), [adding, setAdding] = useState(false), [sourceIds, setSourceIds] = useState<string[]>([]);
  useUnsavedWarning(Boolean(draft));
  const current = draft ?? board;
  if (id && !board) return <ExpiredObject />;
  const saveDraft = () => { if (draft) { saveWorkspaceObject("boards", draft); setDraft(null); notify("看板布局已保存到本次体验"); } };
  return <PreviewBoardPresentation key={id ?? "list"} board={`personal-${id ?? "list"}`}>
    <DashboardHeader title={current?.name ?? "我的概览"} breadcrumb="看板中心 / 我的概览" summary={current ? "组件引用已保存分析；布局调整不改变分析定义。" : "创建自己的看板，将已保存的分析放在一起阅读。"}>
      {!draft && <DashboardCardModeControl/>}{!embedded && <ProductLink href={new URLSearchParams(window.location.search).has("design") ? "/dashboards/public?design=dashboard-center" : "/dashboards/public"}>公共概览</ProductLink>}
      {current ? <><ProductLink href={personalHref("/dashboards/mine")}>全部我的看板</ProductLink>{draft ? <><Button onClick={() => setDraft(null)}>取消编辑</Button><Button variant="primary" disabled={!desktop} onClick={saveDraft}>保存布局</Button></> : <><Button disabled={!desktop} onClick={() => setDraft(structuredClone(board!))}>编辑看板</Button><Button disabled={!desktop} onClick={() => setNaming("rename")}>改名</Button><Button disabled={!desktop} onClick={() => setDeleting(true)} icon={Trash2}>删除</Button></>}</> : <Button variant="primary" icon={Plus} disabled={!desktop} onClick={() => setNaming("create")}>新建看板</Button>}
    </DashboardHeader>
    {!desktop && <p className="personal-note">当前宽度为阅读模式，配置编辑请在桌面宽屏继续。</p>}
    {!current ? <>{!embedded && <div className="personal-tools"><label className="ui-search"><Search /><input aria-label="搜索我的看板" placeholder="搜索我的看板" value={search} onChange={e => setSearch(e.target.value)} /></label></div>}<div className="personal-board-list">{boards.filter(board => board.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(board => <ProductLink className="personal-surface personal-board-link" key={board.id} href={personalHref("/dashboards/mine", board.id)}><h2>{board.name}</h2><span>{board.components.length} 个组件</span><small>更新于 {new Date(board.updated).toLocaleString("zh-CN")}</small></ProductLink>)}</div>{!boards.length && <StatePanel kind="empty" title="还没有个人看板" description="先新建看板，或在分析页保存后加入看板。" />}</> : <>
      {draft && desktop && <div className="personal-tools"><Button icon={Plus} onClick={() => setAdding(true)}>添加已保存分析</Button><span className="personal-note">可用上下移动调整阅读顺序；移除仅作用于当前组件。</span></div>}
      {!current.components.length && <StatePanel kind="empty" title="看板中还没有分析" description="编辑看板并添加已保存分析，或从分析页保存后加入此看板。" action={{ label: "新建指标分析", onClick: () => navigate(personalHref("/analysis/metrics")) }} />}
      <div className="personal-board-grid">{current.components.map((component, index) => {
        const source = analyses.find(item => item.id === component.sourceId);
        let result: AnalysisResult | null = null;
        if (source && !configurationError(source.config)) result = queryAnalysisPreview(source.config);
        const change = (patch: Partial<typeof component>) => draft && setDraft({ ...draft, components: draft.components.map(c => c.id === component.id ? { ...c, ...patch } : c) });
        const move = (offset: number) => { if (!draft) return; const components = [...draft.components]; [components[index], components[index + offset]] = [components[index + offset], components[index]]; setDraft({ ...draft, components }); };
        return <article key={component.id} className={`personal-surface personal-board-card is-${component.width}`}><header><h2>{source ? <ProductLink href={personalHref(`/analysis/${source.config.kind}`, source.id)}>{component.title || source.name}</ProductLink> : "来源已失效"}</h2></header>{draft && desktop && <div className="personal-board-edit"><label>展示标题<input value={component.title} placeholder={source?.name} maxLength={60} onChange={e => change({ title: e.target.value })} /></label><Select label="组件宽度" value={component.width} onChange={width => change({ width: width as "half" | "full" })} options={[{ value: "half", label: "半行" }, { value: "full", label: "整行" }]} /><Button icon={ArrowUp} size="sm" disabled={index === 0} aria-label={`上移组件${index + 1}`} onClick={() => move(-1)}>上移</Button><Button icon={ArrowDown} size="sm" disabled={index === current.components.length - 1} aria-label={`下移组件${index + 1}`} onClick={() => move(1)}>下移</Button><Button size="sm" icon={Copy} onClick={() => setDraft({ ...draft, components: [...draft.components, { ...component, id: localId() }] })}>复制组件</Button><Button size="sm" icon={Trash2} onClick={() => setDraft({ ...draft, components: draft.components.filter(c => c.id !== component.id) })}>移除组件</Button></div>}{result ? <ResultView result={result} compact ordinary={!draft} /> : <StatePanel compact kind="empty" title="来源配置不可用" description="请打开来源分析核对，不以其他结果替换。" />}</article>;
      })}</div>
    </>}
    {naming && <NameDialog title={naming === "create" ? "新建我的看板" : "重命名看板"} initial={naming === "rename" ? board?.name : ""} onClose={() => setNaming(null)} onSave={name => { const next = saveWorkspaceObject("boards", naming === "rename" && board ? { ...board, name } : { id: localId(), revision: 0, name, components: [], updated: "" }); setNaming(null); navigate(personalHref("/dashboards/mine", next.id)); }} />}
    {deleting && board && <MetricReadingDialog title="删除个人看板" onClose={() => setDeleting(false)} content={<div className="personal-form"><p>删除“{board.name}”及其组件。已保存的来源分析继续保留；删除后无法恢复此看板。</p><Button onClick={() => { removePersonalObject("boards", board.id); setDeleting(false); navigate(personalHref("/dashboards/mine")); notify("看板已删除，来源分析保留"); }}>确认删除看板</Button></div>} />}
    {adding && draft && <MetricReadingDialog title="添加已保存分析" dismissOnBackdrop={false} onClose={() => { if (!sourceIds.length || window.confirm("放弃当前选择并关闭吗？")) { setAdding(false); setSourceIds([]); } }} content={<div className="personal-form">{analyses.map(source => <label key={source.id} className="personal-checkbox"><input type="checkbox" checked={sourceIds.includes(source.id)} onChange={e => setSourceIds(e.target.checked ? [...sourceIds, source.id] : sourceIds.filter(id => id !== source.id))} />{source.name}<small>{kindName(source.config.kind)}{draft.components.some(c => c.sourceId === source.id) ? " · 已有组件，再选会重复加入" : ""}</small></label>)}{!analyses.length && <p>暂无已保存分析，请先创建并保存分析配置。</p>}<Button disabled={!sourceIds.length} variant="primary" onClick={() => { setDraft({ ...draft, components: [...draft.components, ...sourceIds.map(sourceId => ({ id: localId(), sourceId, title: "", width: "half" as const }))] }); setAdding(false); setSourceIds([]); }}>加入选中分析</Button></div>} />}
  </PreviewBoardPresentation>;
}

function QuickOverviews({ id, desktop, notify }: { id: string | null; desktop: boolean; notify: (message: string) => void }) {
  const { overviews } = useWorkspace(), saved = overviews.find(item => item.id === id);
  const [draft, setDraft] = useState<QuickOverview | null>(()=>saved&&!saved.metricIds.length?structuredClone(saved):null), [create, setCreate] = useState(false), [picker, setPicker] = useState(false), [remove, setRemove] = useState(false);
  const [date, setDate] = useState("2026-09-08"), [appliedDate, setAppliedDate] = useState(date), [pid, setPid] = useState(saved?.pid ?? workspacePlatforms[0]?.pid ?? ""), [appliedPid, setAppliedPid] = useState(pid);
  const [detail, setDetail] = useState<string | null>(null), [days, setDays] = useState("30"), [definitionOpen, setDefinitionOpen] = useState(false);
  const current = draft ?? saved;
  useUnsavedWarning(Boolean(draft));
  if (id && !saved) return <ExpiredObject />;
  const currentIds = current?.metricIds ?? [];
  const rows = currentIds.map(id => {
    const metric = workspaceMetrics.find(m => m.id === id)!;
    const actualDate = quickMetricDate(id, appliedDate);
    const config = { ...emptyAnalysis("metrics"), items: [{ key: id, ref: id, version: metric.authority.version, measure: "count" as const }], range: { start: actualDate, end: actualDate } };
    const result = queryAnalysisPreview(config), value = result.series[0];
    const platform=quickPlatformSample(value,appliedPid);
    return { id, metric, actualDate, value, platform, platformDay:quickPlatformChange(id,actualDate,platform,appliedPid,-1),platformWeek:quickPlatformChange(id,actualDate,platform,appliedPid,-7), dayChange: quickSampleChange(id, actualDate, value, -1), weekChange: quickSampleChange(id, actualDate, value, -7) };
  });
  const stale = date !== appliedDate || pid !== appliedPid;
  let detailResult: AnalysisResult | null = null;
  if (detail) { const metric = workspaceMetrics.find(m => m.id === detail)!; const end = quickMetricDate(detail, appliedDate); detailResult = queryAnalysisPreview({ ...emptyAnalysis("metrics"), items: [{ key: detail, ref: detail, version: metric.authority.version, measure: "count" }], range: { start: shiftDate(end, -(Number(days) - 1)), end } }); }
  if(detailResult){const overall=detailResult.series.map(series=>({...series,name:"大盘"}));const platform=overall.map(series=>quickPlatformSample(series,appliedPid)).filter((series):series is AnalysisSeries=>!!series);detailResult={...detailResult,series:[...platform,...overall]};}
  const exportRows = () => downloadPreviewWorkbook("指标速览合成样例", [{ name: "说明", rows: [["范围", "本地合成样例，业务平台数据未接入"], ["参考日期", appliedDate], ["业务平台", appliedPid]] }, { name: "完整速览", rows: [["指标", "实际日期", "业务平台", "平台结果", "独立大盘样例", "单位", "平台较昨日", "平台较上周", "大盘较昨日", "大盘较上周", "状态"], ...rows.map(row => [row.metric.name, row.actualDate, appliedPid, row.platform?.summaryRaw ?? null, row.value?.summaryRaw ?? null, row.value?.unit ?? "", row.platformDay,row.platformWeek,row.dayChange, row.weekChange, row.value ? "演示数据" : "未提供样例"])] }]);
  return <>
    <DashboardHeader title={current?.name ?? "指标速览"} breadcrumb="看板中心 / 指标速览" summary="自选日常关注指标，一张表对照所选平台与大盘，查看日、周变化；点数值继续看趋势。">
      {current ? <><ProductLink href={personalHref("/dashboards/metric-overviews")}>全部速览</ProductLink>{draft ? <><Button onClick={() => setDraft(null)}>取消编辑</Button><Button variant="primary" disabled={!desktop || !draft.metricIds.length || !validName(draft.name)} onClick={() => { saveWorkspaceObject("overviews", { ...draft, pid }); setDraft(null); notify("速览配置已保存到本次体验"); }}>保存配置</Button></> : <><Button disabled={!desktop} onClick={() => setDraft(structuredClone(saved!))}>编辑速览</Button><Button disabled={!desktop} onClick={() => setRemove(true)}>删除速览</Button></>}<Button icon={Download} disabled={stale || Boolean(draft) || !rows.length} onClick={exportRows}>导出样例</Button></> : <Button variant="primary" disabled={!desktop} icon={Plus} onClick={() => setCreate(true)}>新建速览</Button>}
    </DashboardHeader>
    {!desktop && <p className="personal-note">当前宽度为阅读模式，配置编辑请在桌面宽屏继续。</p>}
    {!current ? <><div className="personal-board-list">{overviews.map(item => <ProductLink key={item.id} className="personal-surface personal-board-link" href={personalHref("/dashboards/metric-overviews", item.id)}><h2>{item.name}</h2><span>{item.metricIds.length} 个指标 · {workspacePlatforms.find(p => p.pid === item.pid)?.name}</span></ProductLink>)}</div>{!overviews.length && <StatePanel kind="empty" title="把每天要看的指标放在一张表里" description="可创建多份命名速览，分别用于日常经营、增长或内容质量巡检。" action={{label:"体验核心指标速览",onClick:()=>{const item=saveWorkspaceObject("overviews",{id:localId(),revision:0,name:"核心指标速览（演示）",metricIds:["M016","M008","M026","M058","M059","M036"],pid:workspacePlatforms[0].pid,updated:""});navigate(personalHref("/dashboards/metric-overviews",item.id));}}}/>}</> : <>
      <div className="personal-surface personal-query"><label className="personal-date">参考日期<input type="date" aria-label="速览参考日期" value={date} min="2026-04-13" max="2026-09-08" onChange={e => setDate(e.target.value)} /></label><Select label="速览业务平台" value={pid} onChange={setPid} options={workspacePlatforms.map(p => ({ value: p.pid, label: p.name }))} /><Button variant="primary" disabled={!date || date < "2026-04-13" || date > "2026-09-08"} onClick={() => { setAppliedDate(date); setAppliedPid(pid); }}>查询样例</Button>{stale && <span role="status">条件待应用</span>}</div>
      {draft && desktop && <div className="personal-surface personal-tools"><label className="personal-name">速览名称<input value={draft.name} maxLength={60} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label><Button icon={Plus} onClick={() => setPicker(true)}>添加指标</Button></div>}
      <section className="personal-surface quick-overview-table"><PaginatedTable label="指标速览结果" columnCount={draft ? 9 : 8} resetKey={`${appliedDate}:${appliedPid}`} head={<tr><th>指标</th><th>实际日期</th><th>{workspacePlatforms.find(p => p.pid === appliedPid)?.name ?? "业务平台"}</th><th>较昨日</th><th>较上周同日</th><th>大盘</th><th>较昨日</th><th>较上周同日</th>{draft && <th>配置</th>}</tr>} rows={rows.map((row, index) => <tr key={row.id}><td><button className="personal-text-button" onClick={() => { setDetail(row.id); setDays("30"); }}>{row.metric.name}</button><small className="personal-cell-note">{row.metric.classification?.secondary ?? "周期派生"}</small></td><td>{row.actualDate}{row.id === "M020" && <small className="personal-cell-note">最近成熟注册日 · 样例</small>}</td><td><button className="personal-text-button" onClick={()=>{setDetail(row.id);setDays("30");}}>{row.platform?row.platform.summary+" "+row.platform.unit:"暂无样例"}</button></td><td>{row.platformDay}</td><td>{row.platformWeek}</td><td><button className="personal-text-button" onClick={() => {setDetail(row.id);setDays("30");}}>{row.value ? `${row.value.summary} ${row.value.unit}` : "暂无样例"}</button></td><td>{row.dayChange}</td><td>{row.weekChange}</td>{draft && <td><div className="personal-tools"><Button size="sm" icon={ArrowUp} aria-label={row.metric.name+"上移"} disabled={index===0} onClick={()=>{const ids=[...draft.metricIds];[ids[index-1],ids[index]]=[ids[index],ids[index-1]];setDraft({...draft,metricIds:ids});}}/><Button size="sm" icon={ArrowDown} aria-label={row.metric.name+"下移"} disabled={index===rows.length-1} onClick={()=>{const ids=[...draft.metricIds];[ids[index+1],ids[index]]=[ids[index],ids[index+1]];setDraft({...draft,metricIds:ids});}}/><Button size="sm" onClick={() => setDraft({ ...draft, metricIds: draft.metricIds.filter(id => id !== row.id) })}>移除</Button></div></td>}</tr>)} />{!rows.length && <p className="personal-note personal-inset">编辑速览并添加关注指标。</p>}</section>
    </>}
    {create && <NameDialog title="新建指标速览" onClose={() => setCreate(false)} onSave={name => { const item = saveWorkspaceObject("overviews", { id: localId(), revision: 0, name, metricIds: [], pid: workspacePlatforms[0]?.pid ?? "", updated: "" }); setCreate(false); navigate(personalHref("/dashboards/metric-overviews", item.id)); }} />}
    {picker && draft && <DefinitionPicker kind="metrics" onClose={() => setPicker(false)} onSelect={id => { if (draft.metricIds.includes(id)) { notify("该指标已在速览中"); return; } const metricIds = [...draft.metricIds, id]; setDraft({ ...draft, metricIds }); }} />}
    {remove && saved && <MetricReadingDialog title="删除指标速览" onClose={() => setRemove(false)} content={<div className="personal-form"><p>删除“{saved.name}”的配置，不影响指标定义及其他速览。</p><Button onClick={() => { removePersonalObject("overviews", saved.id); setRemove(false); navigate(personalHref("/dashboards/metric-overviews")); notify("本次体验中的速览已删除，无法恢复"); }}>确认删除速览</Button></div>} />}
    {detail && detailResult && <MetricReadingDialog title={`${workspaceMetrics.find(m => m.id === detail)?.name} · 指标数据详情`} onClose={() => setDetail(null)} content={<div className="personal-form"><Select label="详情时间" value={days} onChange={setDays} options={[{ value: "7", label: "近7天" }, { value: "30", label: "近30天" }]} /><p className="personal-note">演示数据 · 所选平台与大盘分别展示；未接入真实查询。图表和速览表使用同一日样例。</p><ResultView result={detailResult} compact /><div className="personal-tools"><Button size="sm" onClick={()=>{if(draft&&!window.confirm("当前有未保存配置。确定离开并放弃修改吗？"))return;stageAnalysisDraft({...detailResult!.config,scope:appliedPid});navigate(personalHref("/analysis/metrics"));}}>进入指标分析</Button><Button size="sm" aria-expanded={definitionOpen} onClick={()=>setDefinitionOpen(!definitionOpen)}>查看指标定义</Button></div>{definitionOpen&&<section className="personal-surface" aria-label="指标定义"><h3>{workspaceMetrics.find(m=>m.id===detail)!.name}</h3><p>{metricBusinessExplanation(workspaceMetrics.find(m=>m.id===detail)!,new Map(workspaceMetrics.map(m=>[m.id,m.name]))).description}</p><p>{metricBusinessExplanation(workspaceMetrics.find(m=>m.id===detail)!,new Map(workspaceMetrics.map(m=>[m.id,m.name]))).calculation}</p><small>定义版本：{workspaceMetrics.find(m=>m.id===detail)!.authority.version}</small></section>}<p className="personal-note">真实看板引用尚未接入。</p></div>} />}
  </>;
}

export default function PersonalWorkspacePreview({ embedded = false, boardSearch = "" }: { embedded?: boolean; boardSearch?: string }) {
  const location = useBrowserLocation(), desktop = useDesktop(), { notice, notify } = useToast();
  const id = new URLSearchParams(location.search).get("object"), key = `${location.pathname}:${id ?? "new"}`;
  let content: ReactNode;
  if (location.pathname === "/dashboards/mine") content = <PersonalBoards key={key} id={id} desktop={desktop} notify={notify} embedded={embedded} boardSearch={boardSearch} />;
  else if (location.pathname === "/dashboards/metric-overviews") content = <QuickOverviews key={key} id={id} desktop={desktop} notify={notify} />;
  else if (location.pathname === "/analysis/saved") content = <SavedAnalysisList desktop={desktop} notify={notify} />;
  else content = <AnalysisEditor key={key} kind={location.pathname === "/analysis/events" ? "events" : location.pathname === "/analysis/funnels" ? "funnels" : "metrics"} id={id} desktop={desktop} notify={notify} />;
  return <div className="personal-workspace-preview v2-page" data-preview-marker="PERSONAL_WORKSPACE_DEV_ONLY"><ReviewTools><div className="personal-preview-notice"><b>本地交互体验</b><span>权威定义 · 合成样例；本次体验内保存，刷新页面后清空，未同步账号。</span></div></ReviewTools>{content}{notice && <Toast notice={notice} onClose={() => notify(null)} />}</div>;
}
