import { ReviewTools } from "../components/ReviewTools";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { readPreviewQuery } from "./preview-query";
import { usePreviewQuery } from "./usePreviewQuery";
import { Copy, Info, Maximize2, RefreshCw, Search, Star } from "lucide-react";
import { Chart } from "../../components/Chart";
import { Button } from "../../components/ui/Button";
import { DateRangePicker } from "../../components/ui/DateRangePicker";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { FloatingHint } from "../../components/ui/FloatingHint";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { TabList } from "../../components/ui/TabList";
import { PivotTable } from "../../components/ui/PivotTable";
import { Toast, useToast } from "../../components/ui/Toast";
import { DashboardGuidance, DashboardHeader, DashboardPanel, DashboardSectionHeading } from "../features/dashboards/DashboardPresentation";
import { DashboardActions, DashboardQueryFields } from "../features/dashboards/DashboardToolbar";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { MetricReadingDialog } from "../features/dashboards/MetricReadingDialog";
import { missingCalculation } from "../features/dashboards/CalculationEvidence";
import { MetricSummary } from "../features/dashboards/MetricSummary";
import { PreviewMetricCard, type OpenPreviewReading } from "./PreviewMetricCard";
import { previewFavorites, setPreviewFavorite } from "./preview-favorites";
import { metricRows as topicMetricRows } from "./topic-preview-export";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { downloadPreviewWorkbook, type WorkbookSheet } from "./preview-workbook";
import { CHART_PALETTE } from "../../theme/tokens";
import { ProductLink } from "../app/router";
import plan from "./generated/dashboard-directory-preview.json";
import { DEMO_END, DEMO_RANGE, EXTENDED_BOARDS, EXTENDED_BOARD_MARKER, demoCalculationBasis, demoCategories, demoMetric, demoPrevious, demoRangeLabel, demoResult, demoUnit, demoValue, extendedMetricModel, extendedDailyMetricModel, type ExtendedBoard } from "./extended-board-model";
import { extendedBoardHref as hrefFor, parseExtendedView, type ExtendedView } from "./extended-board-view";
import "./topic-previews.css";
import "./extended-board-preview.css";
import { IncomeComposition, NewOldPayment, paymentStructureSheets } from "./PaymentBreakdowns";
import { paymentMetric, paymentMetricIds, paymentGroups, type PaymentDimension } from "./payment-observations";
import { PaymentOrderAnalysis, paymentOrderSheets } from "./PaymentOrderAnalysis";
import VersionPerformancePreview from "./VersionPerformancePreview";
import { DEFAULT_VERSION_PERFORMANCE_VIEW, type VersionPerformanceView } from "./version-performance-model";
import { ContentDiscoveryBoard } from "./ContentDiscoveryBoard";
import { contentDiscoverySheet, orderBoardRows, searchDemandSheet, videoClickSourceMetricModel, videoClickSourceSheet, videoHomeCategoryMetricModel, videoHomeCategoryRows, type BoardSortOrder } from "./content-discovery-analysis-model";
import { HORIZONTAL_BAR_GRID, horizontalBarEndLabel } from "./horizontal-bar-reading";
import { CompactMetricReading } from "../features/dashboards/CompactMetricReading";
import { DataOriginBadge, DataOriginProvider } from "../components/DataOrigin";
import { liveDailyReferenceRows, liveExportMetadata, liveMetricModel, livePeriodStatus, useLiveDashboard } from "../features/dashboards/LiveDashboardContext";
import { LiveSeriesDetails, LiveSeriesExport } from "../features/dashboards/ConnectedMetricCard";

const SECTION_GUIDANCE: Record<string, readonly (string | undefined)[]> = {
  "5.10": ["member.core", undefined, undefined, "member.paywall"],
  "5.12": ["playback.core", "playback.users"],
  "5.14": ["operations.outcomes", "operations.quality"]
};

const DIMENSION_GUIDANCE: Record<string, string> = {
  "付费结构": "member.structure",
  "支付方式比较": "payment.method",
  "播放质量诊断": "playback.diagnosis",
  "内容发现结构": "discovery.sources",
  "搜索需求": "discovery.search",
  "视频互动排行": "discovery.interaction",
  "签到拆解": "operations.tasks",
  "任务与福利": "operations.tasks",
  "分享邀请": "operations.invite",
  "启动结构与质量诊断": "experience.diagnosis"
};

export function BoardSelect({ label, value, values, onChange }: { label: string; value: string; values: { value: string; label: string }[]; onChange: (value: string) => void }) {
  const shortNames: Record<string,string> = {M106:"点击次数",M107:"点击人数",M108:"人均点击次数"};
  if (values.length <= 3 && !label.includes("排序") && !label.includes("周期")) return <div className="board-metric-segments" role="group" aria-label={label}>{values.map(v => <Button key={v.value} size="sm" variant={v.value===value?"primary":"secondary"} aria-pressed={v.value===value} onClick={()=>onChange(v.value)}>{shortNames[v.value]??v.label}</Button>)}</div>;
  return <MenuSelect label={label} ariaLabel={label} value={value} density="compact" searchable={values.length>8} onChange={onChange} groups={[{label,options:values}]} />;
}
function metadata(view: ExtendedView): WorkbookSheet { return { name: "00_导出说明", rows: [["数据性质", "DEV 合成演示数据，非正式业务结果"], ["统计日期", demoRangeLabel(view.range)], ["对比日期", view.compared ? demoRangeLabel(demoPrevious(view.range)) : "不对比"], ["范围", "大盘演示样例；正式业务范围及维度逐项准入"], ["金额", "USD 演示币种，不进行换汇"], ["数值", "百分数按 0–100 导出；区间人数为独立用户集合样例，不跨日相加"], ["数据截至", DEMO_END], ["导出范围", "完整查询，不受分页、搜索、排序或图形缩放裁剪"]] }; }
function limits(): WorkbookSheet { return { name: "99_数据状态与限制", rows: [["正式查询", "尚未接入真实数据与验数"], ["失败事件", "正式事件查询和属性验数未就绪，不生成失败原因结果"], ["M032", "只展示耗时分布样例，不提供未经确认的平均值或分位指标"], ["多维结果", "独立交叉粒度演示数据；不拼接单维结果"], ["金额与复购", "未证明真实币种、退款、代付和历史覆盖，演示不代表正式准入"]] }; }
export function BoardExport({ title, view, sheets, pending = false, iconOnly = false }: { title: string; view: ExtendedView; sheets: WorkbookSheet[]; pending?: boolean; iconOnly?: boolean }) { return <PreviewExportControl name={title} scope="当前区域完整聚合结果，保留实际日期、单位和状态。" context="合成演示数据，非正式业务结果" pending={pending} iconOnly={iconOnly} onDownloadPreview={() => downloadPreviewWorkbook(title, [metadata(view), ...sheets, limits()])} />; }
function categoryRows(id: string, group: string, view: ExtendedView) {
  if (id === "M109" && group === "一级内容分类") return videoHomeCategoryRows(view.range).map(row => ({
    ...row,
    paymentFilter: undefined,
    value: row.current,
    baseline: row.comparison,
    calculation: undefined,
    baselineCalculation: undefined
  }));
  const isPayment=paymentMetricIds.has(id),categories=isPayment&&group==="商品"?paymentGroups.product.map((item,i)=>({key:item.id,name:item.label,position:i+1,row:undefined as string|undefined,column:undefined as string|undefined})):demoCategories(group);
  return categories.map((category,i)=>{
    let paymentFilter:Partial<Record<PaymentDimension,string>>|undefined;
    if(isPayment){
      if(group==="客户端平台")paymentFilter={client:paymentGroups.client.find(item=>item.label===category.name)!.id};
      if(group==="新老用户")paymentFilter={stage:paymentGroups.stage.find(item=>item.label===category.name)!.id};
      if(group==="商品")paymentFilter={product:category.key};
      if(group==="平台 × 新老用户")paymentFilter={client:paymentGroups.client.find(item=>item.label===category.row)!.id,stage:paymentGroups.stage.find(item=>item.label===category.column)!.id};
    }
    const currentModel=paymentFilter?extendedMetricModel(id,view.range,false,false,i+1,paymentFilter):null;
    const baselineModel=paymentFilter?extendedMetricModel(id,demoPrevious(view.range),false,false,i+1,paymentFilter):null;
    return {
      ...category,
      paymentFilter,
      value:paymentFilter?paymentMetric(id,view.range,paymentFilter):demoResult(id,view.range,i+1),
      baseline:paymentFilter?paymentMetric(id,demoPrevious(view.range),paymentFilter):demoResult(id,demoPrevious(view.range),i+1),
      calculation:currentModel?.result.status==="available"?currentModel.result.calculation:demoCalculationBasis(id,view.range,i+1),
      baselineCalculation:baselineModel?.result.status==="available"?baselineModel.result.calculation:demoCalculationBasis(id,demoPrevious(view.range),i+1)
    };
  });
}
function categorySheet(title: string, id: string, group: string, view: ExtendedView, order: BoardSortOrder = "position"): WorkbookSheet {
  const rows=orderBoardRows(categoryRows(id,group,view),order,row=>row.value),inputs=rows.find(row=>row.calculation)?.calculation;
  const header=["分组名称","演示稳定标识","位置","指标",...(inputs?[`分子 · ${inputs.numerator.name}`,`分母 · ${inputs.denominator.name}`]:[]),"当前值","单位",...(view.compared?[...(inputs?["对比分子","对比分母"]:[]),"对比值","差值"]:[]),"状态"];
  const data=rows.map(row=>[row.name,row.key,row.position,demoMetric(id).name,...(inputs?[row.calculation?.numerator.value??null,row.calculation?.denominator.value??null]:[]),row.value*(demoUnit(id)==="%"?100:1),demoUnit(id),...(view.compared?[...(inputs?[row.baselineCalculation?.numerator.value??null,row.baselineCalculation?.denominator.value??null]:[]),row.baseline*(demoUnit(id)==="%"?100:1),(row.value-row.baseline)*(demoUnit(id)==="%"?100:1)]:[]),inputs?"隔离演示输入":"完整"]);
  return {name:title.slice(0,30),rows:inputs?[["指标",demoMetric(id).name],["计算规则",inputs.formula],[],header,...data]:[header,...data]};
}
const metricRows = (models: DashboardMetricCardModel[]) => topicMetricRows(models, demoUnit);
const differenceValue = (id: string, difference: number) => demoUnit(id) === "%" ? `${(difference * 100).toFixed(2)} 个百分点` : demoValue(id, difference);
type DimensionSelection = { id: string; group: string; order: BoardSortOrder };
const calculationInput = (input: { value: number | null; unit: string } | undefined) => input?.value === null || input?.value === undefined ? "—" : `${input.value.toLocaleString("zh-CN")} ${input.unit}`;
export function BoardDimension({ spec, view, pending, open, onSelectionChange }: { spec: ExtendedBoard["dimensions"][number]; view: ExtendedView; pending: boolean; open: OpenPreviewReading; onSelectionChange?: (value: DimensionSelection) => void }) {
  const [id, setId] = useState(spec.ids[0]), [group, setGroup] = useState(spec.groups[0]), [search, setSearch] = useState(""), [order, setOrder] = useState<BoardSortOrder>("position"), [top, setTop] = useState("10");
  const groups = spec.title === "作者与社区明细" ? [id === "M049" ? "作者" : id === "M050" ? "帖子" : "内容类型"] : spec.groups;
  const actualGroup = groups.includes(group) ? group : groups[0];
  const rows = useMemo(() => categoryRows(id, actualGroup, view), [id, actualGroup, view]);
  const inputs=missingCalculation(demoMetric(id).definition,demoRangeLabel(view.range),"待接入",demoUnit(id)==="%");
  const ordered = orderBoardRows(rows,order,row=>row.value);
  const highCardinality = ["视频", "作者", "帖子", "搜索词", "位置"].includes(actualGroup), cross = actualGroup.includes(" × ");
  const chartRows = highCardinality ? ordered.slice(0, Number(top)) : ordered;
  const filtered = ordered.filter(row => `${row.name} ${row.key}`.toLowerCase().includes(search.toLowerCase().trim()));
  const showInlineInputs=Boolean(inputs)&&["播放质量诊断","签到拆解","任务与福利","分享邀请","启动结构与质量诊断"].includes(spec.title);
  const exported = <BoardExport title={spec.title} view={view} pending={pending} sheets={[categorySheet("01_完整结果", id, actualGroup, view,order)]} />;
  const point = (row: typeof rows[number]) => {
    const detailModel = id === "M109" && actualGroup === "一级内容分类"
      ? videoHomeCategoryMetricModel(view.range, view.compared, row.key)
      : extendedMetricModel(id, view.range, view.compared, false, row.position,row.paymentFilter);
    open(`${spec.title} · ${row.name}`, <><p>{demoMetric(id).name} · {demoRangeLabel(view.range)}</p><p>当前值 {demoValue(id, row.value)}</p>{view.compared && <p>对比 {demoRangeLabel(demoPrevious(view.range))} · {demoValue(id, row.baseline)}；差值 {differenceValue(id, row.value - row.baseline)}</p>}<p>演示标识：{row.key} · 位置 {row.position}</p><PreviewMetricCard model={detailModel} open={open} retry={() => {}} exportAction={<BoardExport title={`${row.name}趋势`} view={view} sheets={[{ name: "01_同口径数据", rows: metricRows([detailModel]) }]} />} /></>);
  };
  return <DashboardPanel title={spec.title} guidanceKey={DIMENSION_GUIDANCE[spec.title]} note={`${demoMetric(id).name} · ${demoRangeLabel(view.range)}${id === "M052" ? " · 各 Tab 独立结果，不汇总为总渗透率" : ""}`} tools={<>
    {spec.ids.length > 1 && <div className="board-control-group"><span>指标</span><BoardSelect label={`${spec.title}指标`} value={id} onChange={next => { const nextGroup=spec.title === "作者与社区明细" ? next === "M049" ? "作者" : next === "M050" ? "帖子" : "内容类型" : actualGroup; setId(next); onSelectionChange?.({ id: next, group: nextGroup,order }); }} values={spec.ids.map(value => ({ value, label: demoMetric(value).name }))} /></div>}
    {groups.length>1&&<div className="board-dimension-controls"><span>比较维度</span><MenuSelect label="比较维度" ariaLabel={`${spec.title}分组`} value={actualGroup} density="compact" searchable={groups.length>8} onChange={next=>{setGroup(next);onSelectionChange?.({id,group:next,order});}} groups={[{label:"比较维度",options:groups.map(value=>({value,label:value}))}]}/></div>}
    <div className="board-control-group board-control-group--secondary"><span>排序</span><BoardSelect label={`${spec.title}排序`} value={order} onChange={next=>{const value=next as BoardSortOrder;setOrder(value);onSelectionChange?.({id,group:actualGroup,order:value});}} values={[{ value: "position", label: "按业务顺序" }, { value: "desc", label: "按当前值降序" }]} /></div>
    {highCardinality && <BoardSelect label="图形展示数量" value={top} onChange={setTop} values={[5, 10, 20, 100].map(value => ({ value: String(value), label: `前 ${value} 项` }))} />}{cross && exported}
  </>}>
    {cross ? <PivotTable label={`${spec.title}二维交叉表`} rowHeading={actualGroup} columns={[...new Set(rows.map(row => row.column!))]} rows={[...new Set(rows.map(row => row.row!))].map(name => ({ key: name, label: name, values: [...new Set(rows.map(row => row.column!))].map(column => { const item = rows.find(row => row.row === name && row.column === column); return item ? <button type="button" onClick={() => point(item)}>{demoValue(id, item.value, false)}</button> : "—"; }) }))} /> : <>
      <div className="board-preview__category-scroll" tabIndex={chartRows.length > 10 ? 0 : undefined} aria-label={`${spec.title}全部分类图`}><Chart theme="v13" ariaLabel={`${spec.title}分类比较`} style={{ height: Math.max(260, chartRows.length * (view.compared ? 46 : 32) + 60) }} onClick={params => { const row = chartRows[(params as { dataIndex: number }).dataIndex]; if (row) point(row); }} option={{ grid: HORIZONTAL_BAR_GRID, tooltip: { trigger: "axis", formatter: (params: { dataIndex: number }[]) => { const row = chartRows[params[0].dataIndex]; return `${row.name}<br/>当前 ${demoRangeLabel(view.range)} · ${demoValue(id, row.value)}${view.compared ? `<br/>对比 ${demoRangeLabel(demoPrevious(view.range))} · ${demoValue(id, row.baseline)}<br/>差值 ${differenceValue(id, row.value - row.baseline)}` : ""}`; } }, xAxis: { type: "value", axisLabel: { hideOverlap: true, formatter: (n: number) => demoUnit(id) === "%" ? demoValue(id, n) : demoValue(id, n, false) } }, yAxis: { type: "category", inverse: true, data: chartRows.map(row => row.name), axisLabel: { width: 132, overflow: "truncate" } }, series: [{ name: "当前期", type: "bar", data: chartRows.map(row => row.value), label: horizontalBarEndLabel(value => value === null ? "—" : demoValue(id, value)), barMaxWidth: 16, itemStyle: { color: CHART_PALETTE[0] } }, ...(view.compared ? [{ name: "对比期", type: "bar", data: chartRows.map(row => row.baseline), barMaxWidth: 16, itemStyle: { color: CHART_PALETTE[1] } }] : [])] }} /></div>
      {showInlineInputs&&inputs&&<section className="board-analysis__inline-table" aria-label={`${spec.title}计算输入`}><p><b>{demoMetric(id).name}</b> · {inputs.formula}</p><div className="ui-result-table__viewport" tabIndex={0} role="region" aria-label={`${spec.title}计算输入表`}><table><thead><tr><th>{actualGroup}</th><th>{inputs.numerator.name}</th><th>{inputs.denominator.name}</th><th>结果</th><th>状态</th></tr></thead><tbody>{ordered.map(row=><tr key={row.key}><td>{row.name}</td><td>{calculationInput(row.calculation?.numerator)}</td><td>{calculationInput(row.calculation?.denominator)}</td><td>{demoValue(id,row.value)}</td><td>{row.calculation?"隔离演示输入":"待接入"}</td></tr>)}</tbody></table></div></section>}
      <ChartDataTable title={`${spec.title}同口径数据表`} exportAction={exported}><p className="dashboard-table-context">{demoRangeLabel(view.range)}{view.compared && ` · 对比 ${demoRangeLabel(demoPrevious(view.range))}`} · {demoMetric(id).name}{inputs&&` · ${inputs.formula}`}</p><label className="topic-preview__search ui-search"><Search /><input aria-label={`搜索${spec.title}`} value={search} placeholder="搜索名称或标识" onChange={e => setSearch(e.target.value.slice(0, 120))} /></label>
        <PaginatedTable label={`${spec.title}完整结果`} resetKey={JSON.stringify([id, group, search, order, view])} columnCount={(view.compared ? 7 : 5)+(inputs?(view.compared?4:2):0)} head={<tr><th>名称 / 标识</th><th>位置</th>{inputs&&<><th>{inputs.numerator.name}</th><th>{inputs.denominator.name}</th></>}<th>当前值</th>{view.compared && <>{inputs&&<><th>对比分子</th><th>对比分母</th></>}<th>对比值</th><th>差值{demoUnit(id) === "%" ? "（百分点）" : ""}</th></>}<th>状态</th><th>详情</th></tr>} rows={filtered.map(row => <tr key={row.key}><td>{row.name}<small className="topic-preview__content-id">{row.key}</small></td><td>{row.position}</td>{inputs&&<><td>{calculationInput(row.calculation?.numerator)}</td><td>{calculationInput(row.calculation?.denominator)}</td></>}<td>{demoValue(id, row.value)}</td>{view.compared && <>{inputs&&<><td>{calculationInput(row.baselineCalculation?.numerator)}</td><td>{calculationInput(row.baselineCalculation?.denominator)}</td></>}<td>{demoValue(id, row.baseline)}</td><td>{differenceValue(id, row.value - row.baseline)}</td></>}<td>{inputs?"隔离演示输入":"完整"}</td><td><button type="button" onClick={() => point(row)}>查看趋势</button></td></tr>)} />
      </ChartDataTable>
    </>}
  </DashboardPanel>;
}

function latencySheet(view: ExtendedView): WorkbookSheet { return { name: "03_首帧耗时分布", rows: [["首帧耗时区间", "当前样本数（次）", ...(view.compared ? ["对比样本数（次）"] : [])], ...["0–200 ms", "200–500 ms", "500–1,000 ms", "1–2 s", "2–5 s", "5 s 以上"].map((bucket, i) => [bucket, Math.round(demoResult("M097", view.range) * [.16, .35, .26, .14, .07, .02][i]), ...(view.compared ? [Math.round(demoResult("M097", demoPrevious(view.range)) * [.14, .31, .28, .15, .09, .03][i])] : [])])] }; }

function PlaybackStageRelations({ view, pending, open, models }: { view: ExtendedView; pending: boolean; open: OpenPreviewReading; models: DashboardMetricCardModel[] }) {
  const live = useLiveDashboard();
  const result = live?.state.status === "success" ? live.state.data : null;
  const previous = live?.comparison?.state.status === "success" ? live.comparison.state.data : null;
  const readings = models.map(original => {
    const connected = Boolean(live?.metricIds.includes(original.metric.id));
    return { model: connected ? liveMetricModel(original, live!) : original, connected };
  });
  const hasLive = readings.some(reading => reading.connected);
  const rows = metricRows(readings.map(reading => reading.model));
  const sheet: WorkbookSheet = { name: "01_播放阶段结果", rows: [
    [...rows[0], "数据来源"], ...rows.slice(1).map(row => [...row, readings.find(reading => reading.model.metric.name === row[0])?.connected ? "真实候选 · 待验数" : "隔离演示"])
  ] };
  const sourceSheet: WorkbookSheet = { name: "02_来源口径", rows: [["指标", "单位", "定义", "计算口径", "来源边界"],
    ...readings.map(({ model, connected }) => {
      const metric = connected ? result?.data.series.find(series => series.metric.id === model.metric.id)?.metric : undefined;
      return [model.metric.name, metric?.unit ?? demoUnit(model.metric.id), metric?.definition ?? model.metric.definitionLabel, metric?.formula ?? "", metric?.sourceNote ?? (connected ? "当前真实查询尚无可用结果" : "合成演示数据")];
    })
  ] };
  const unavailableExport = pending || Boolean(hasLive && (!live!.canExport || live!.controls.dirty || live!.state.status !== "success"));
  const exportStages = hasLive ? <PreviewExportControl name="播放阶段" dataOrigin="mixed" pending={unavailableExport}
    scope="各阶段摘要与完整逐日结果，分别保留真实候选和演示来源、单位、计算输入及对比日期。" context={live!.query.dateRange.join(" 至 ") + " · " + live!.platformName}
    onDownloadPreview={() => downloadPreviewWorkbook("播放阶段", [{ name: "00_导出说明", rows: liveExportMetadata(live!) }, sheet, sourceSheet], "mixed")} />
    : <BoardExport title="播放阶段" view={view} sheets={[sheet]} pending={pending} />;
  return <DataOriginProvider value={hasLive ? null : "demo"}><DashboardPanel title="播放阶段关系" note="播放尝试与成功起播次数分别统计；起播率按已成熟样本计算，不以人数相减推算失败。">
    <div className="board-preview__relations">{readings.map(({ model, connected }) => {
      const series = connected ? result?.data.series.find(series => series.metric.id === model.metric.id) : undefined;
      const metricExport = connected ? series && result && live!.canExport && !live!.controls.dirty ? <LiveSeriesExport series={series} result={result} comparison={previous}
        comparisonStatus={livePeriodStatus(live!, true)} dayReferences={liveDailyReferenceRows(live!, [model.metric.id])}
        stale={Boolean(live!.state.status === "success" && live!.state.refreshError || live!.comparison?.state.status === "success" && live!.comparison.state.refreshError)} /> : <Button disabled>导出未就绪</Button>
        : <BoardExport title={`${model.metric.name}同口径数据表`} view={view} sheets={[{ name: "01_同口径数据表", rows: metricRows([model]) }]} pending={pending || model.result.status !== "available"} />;
      const openReading: OpenPreviewReading = (title, content) => open(title, <>{content}{connected && series && result && <details><summary>来源记录与计算输入</summary><LiveSeriesDetails series={series} result={result} /></details>}</>);
      const statusShowsOrigin = connected && model.result.status === "available" && model.result.completeness === "unknown" && model.result.refresh.status === "idle" && model.result.value.raw !== 0;
      return <DataOriginProvider key={model.metric.id} value={connected ? "pending" : "demo"}><CompactMetricReading model={model} tone="relation" trendVariant="link" note={statusShowsOrigin ? undefined : <DataOriginBadge />} onOpen={openReading} exportAction={metricExport} /></DataOriginProvider>;
    })}</div>
    <ChartDataTable title="播放阶段同口径数据表" exportAction={exportStages}>
      <PaginatedTable label="播放阶段结果" columnCount={sheet.rows[0].length} head={<tr>{sheet.rows[0].map((cell, i) => <th key={i}>{cell}</th>)}</tr>}
        rows={sheet.rows.slice(1).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell ?? "—"}</td>)}</tr>)} />
      {hasLive && <details><summary>真实来源记录与计算输入</summary>{readings.flatMap(({ model, connected }) => {
        const series = connected ? result?.data.series.find(series => series.metric.id === model.metric.id) : undefined;
        return series && result ? [<LiveSeriesDetails key={model.metric.id} series={series} result={result} />] : [];
      })}</details>}
    </ChartDataTable>
  </DashboardPanel></DataOriginProvider>;
}
function Latency({ view, pending }: { view: ExtendedView; pending: boolean }) { const sheet = latencySheet(view), rows = sheet.rows.slice(1); return <DashboardPanel title="首帧耗时分布" chartKind="latency-distribution" note={`${demoRangeLabel(view.range)} · 合法成功样本；不提供未经确认的平均值或分位摘要`}><Chart theme="v13" ariaLabel="首帧耗时分布" style={{ height: 310 }} option={{ grid: { left: 65, right: 30, top: 25, bottom: 45 }, tooltip: { trigger: "axis" }, xAxis: { type: "category", data: rows.map(row => row[0]) }, yAxis: { type: "value" }, series: [{ name: "当前样本数（次）", type: "bar", data: rows.map(row => row[1]), itemStyle: { color: CHART_PALETTE[0] }, barMaxWidth: 42 }, ...(view.compared ? [{ name: "对比样本数（次）", type: "bar", data: rows.map(row => row[2]), itemStyle: { color: CHART_PALETTE[1] }, barMaxWidth: 42 }] : [])] }} /><ChartDataTable title="首帧耗时同口径数据表" exportAction={<BoardExport title="首帧耗时分布" view={view} sheets={[sheet]} pending={pending} />}><PaginatedTable label="首帧耗时分布" columnCount={sheet.rows[0].length} head={<tr>{sheet.rows[0].map((cell, i) => <th key={i}>{cell}</th>)}</tr>} rows={rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{typeof cell === "number" ? cell.toLocaleString() : cell}</td>)}</tr>)} /></ChartDataTable></DashboardPanel>; }

export default function ExtendedBoardPreview({ board }: { board: string }) {
  const spec = EXTENDED_BOARDS[board], entry = plan.items.find(item => item.section === board)!;
  const shared = readPreviewQuery();
  const initial: ExtendedView = parseExtendedView(new URLSearchParams(location.search).get("view"), board) ?? { range: shared.range, compared: shared.compared, mixed: false };
  const [view, setView] = useState(initial), [draft, setDraft] = useState(initial), [recovered, setRecovered] = useState<string[]>([]), [favorite, setFavorite] = useState(() => previewFavorites().includes(board));
  usePreviewQuery(view.range, view.compared);
  const [selections, setSelections] = useState<Record<string, DimensionSelection>>({});
  const [game, setGame] = useState("0");
  const [reading, setReading] = useState<{ title: string; content: ReactNode } | null>(null), root = useRef<HTMLDivElement>(null), { notice, notify } = useToast();
  const open: OpenPreviewReading = (title, content) => setReading({ title, content }), pending = JSON.stringify(view) !== JSON.stringify(draft);
  const models = useMemo(() => new Map(spec.sections.flatMap(section => section.ids).map(id => [id, extendedDailyMetricModel(id, view.range, view.compared, view.mixed && !recovered.includes(id),0,board==="5.10"?{}:undefined)])), [spec, view, recovered,board]);
  const update = (next: ExtendedView) => { setView(next); setRecovered([]); setReading(null); window.history.replaceState(window.history.state, "", hrefFor(board, next)); };
  const experience = view.experience ?? DEFAULT_VERSION_PERFORMANCE_VIEW;
  const updateExperience = (next: VersionPerformanceView) => {
    update({ ...view, experience: next });
    setDraft(current => ({ ...current, experience: next }));
  };
  const sectionSheet = (index: number, name: string): WorkbookSheet => ({ name, rows: metricRows(spec.sections[index].ids.map(id => models.get(id)!)) });
  const dimensionSheet = (index: number, name: string) => { const dimension = spec.dimensions[index], selected = selections[dimension.title] ?? { id: dimension.ids[0], group: dimension.groups[0],order:"position" as const }; return categorySheet(name, selected.id, selected.group, view,selected.order); };
  const merge = (name: string, ...parts: WorkbookSheet[]): WorkbookSheet => ({ name, rows: parts.flatMap(part => [[part.name], ...part.rows, []]) });
  const paymentSheets=board==="5.10"?paymentStructureSheets(view.range,view.compared,view.mixed&&!recovered.includes("M065")):[];
  const orderSheets=board==="5.11"?paymentOrderSheets(view.range,view.mixed,view.compared):[];
  const sheets: WorkbookSheet[] = board === "5.10" ? [sectionSheet(0, "01_付费核心"), sectionSheet(1, "02_新用户价值"), merge("03_付费结构",paymentSheets[0],dimensionSheet(0,"其他付费结构")), paymentSheets[1], sectionSheet(3, "05_会员引导与付费墙")]
    : board === "5.11" ? orderSheets
    : board === "5.12" ? [merge("01_质量概览", sectionSheet(0, "核心质量"), sectionSheet(1, "用户规模")), { name: "02_播放阶段", rows: metricRows([extendedMetricModel("M101", view.range, view.compared), models.get("M097")!]) }, latencySheet(view), dimensionSheet(0, "05_维度诊断")]
    : board === "5.13" ? [sectionSheet(0, "01_发现与搜索核心"), merge("02_分类导航使用", sectionSheet(1, "分类总览"), dimensionSheet(0, "分类比较")), merge("03_视频点击来源", { name: "总体逐日趋势", rows: metricRows([videoClickSourceMetricModel(view.range, view.compared)]) }, videoClickSourceSheet(view.range, view.compared, selections["视频点击来源"]?.order ?? "desc"), dimensionSheet(1, "视频首页一级分类")), contentDiscoverySheet(view.range,view.compared,selections["内容发现结构"]?.order), searchDemandSheet(view.range,view.compared,(selections["搜索需求"]?.group as "搜索词"|"搜索类型"|undefined)??"搜索词",selections["搜索需求"]?.order??"desc",(selections["搜索需求"]?.id as "M092"|"M093"|"M046"|undefined)??"M092"), dimensionSheet(4, "05_视频互动"), merge("06_作者与社区", sectionSheet(3, "作者与社区"), dimensionSheet(5, "明细"))]
    : board === "5.14" ? [merge("01_玩法核心", sectionSheet(0, "玩法结果"), sectionSheet(1, "过程质量")), dimensionSheet(0, "02_签到拆解"), dimensionSheet(1, "03_任务与福利"), dimensionSheet(2, "04_分享邀请")]
    : [sectionSheet(0, "01_启动核心"), dimensionSheet(0, "02_启动拆解")];
  const dimensionPanel = (dimension: ExtendedBoard["dimensions"][number]) => <BoardDimension key={dimension.title} spec={dimension} view={view} pending={pending} open={open} onSelectionChange={value => setSelections(previous => ({ ...previous, [dimension.title]: value }))} />;
  const icon = (label: string, action: () => void, child: ReactNode, pressed?: boolean) => <FloatingHint content={label}><button className="ui-icon-button" type="button" aria-label={label} aria-pressed={pressed} onClick={action}>{child}</button></FloatingHint>;
  const renderCard = (id: string, compact = false) => { const model = models.get(id)!; return <PreviewMetricCard key={id} compact={compact} model={model} open={open} retry={() => setRecovered(ids => [...ids, id])} exportAction={<BoardExport title={`${model.metric.name}同口径数据表`} view={view} sheets={[{ name: "01_同口径数据表", rows: metricRows([model]) }]} pending={pending || model.result.status !== "available"} />} />; };
  const standardContent = <>
    {board === "5.11" ? <>
      <PaymentOrderAnalysis range={view.range} compared={view.compared} pending={pending} onOpen={open} />
      <details className="payment-business__advanced">
        <summary>提交、下单、回调与到账指标</summary>
        <DashboardGuidance title="支付链路核心" guidanceKey="payment.core" />
        <div className="topic-preview__grid is-three">{spec.sections.flatMap(section => section.ids).map(id => renderCard(id))}</div>
      </details>
    </> : board === "5.13" ? <ContentDiscoveryBoard view={view} pending={pending} open={open} renderCard={renderCard}
      exportAction={(title, contentSheets) => <BoardExport title={title} view={view} sheets={contentSheets} pending={pending} />}
      categoryNavigation={dimensionPanel(spec.dimensions[0])} videoHomeCategories={dimensionPanel(spec.dimensions[1])}
      videoInteraction={dimensionPanel(spec.dimensions[4])} communityDetails={dimensionPanel(spec.dimensions[5])}
      onSelectionChange={(key, value) => setSelections(previous => ({ ...previous, [key]: value }))} /> : spec.sections.map((section, index) => {
      if (board === "5.10" && index === 2) return <IncomeComposition key="income" range={view.range} compared={view.compared} pending={pending} onOpen={open} incomplete={view.mixed && !recovered.includes("M065")} onRetry={() => setRecovered(ids => [...ids, "M065"])} />;
      const visibleIds = section.ids;
      return <section key={section.title} aria-label={board === "5.15" && index === 0 ? undefined : section.title}>
        {!(board === "5.15" && index === 0) && <DashboardSectionHeading title={section.title} guidanceKey={SECTION_GUIDANCE[board]?.[index]} />}
        <div className="board-preview__section-flow">
          {section.note && <p className="topic-preview__description">{section.note}</p>}
          {board === "5.10" && index === 1 && <NewOldPayment range={view.range} compared={view.compared} pending={pending} onOpen={open} />}
          {visibleIds.length > 0 && <div className={`topic-preview__grid is-${section.columns === 3 ? "three" : "two"}${board === "5.15" && index === 0 ? " board-preview__startup-grid" : ""}`}>
            {visibleIds.map(id => renderCard(id, board === "5.15" && id === "M091"))}
          </div>}
          {board === "5.12" && index === 0 && <Latency view={view} pending={pending} />}
          {board === "5.12" && index === 1 && <PlaybackStageRelations view={view} pending={pending} open={open} models={[extendedDailyMetricModel("M101", view.range, view.compared, view.mixed), models.get("M097")!, models.get("M031")!]} />}
        </div>
      </section>;
    })}
    {board === "5.14" ? <section aria-label="玩法拆解"><DashboardSectionHeading title="玩法拆解" /><TabList label="玩法拆解" value={game} onChange={setGame} panelId="game-breakdown" items={spec.dimensions.map((item, index) => ({ id: String(index), label: item.title }))} /><div id="game-breakdown" role="tabpanel" aria-label={spec.dimensions[Number(game)].title}>{dimensionPanel(spec.dimensions[Number(game)])}</div></section> : board === "5.11" || board === "5.13" ? null : board === "5.10" ? <details className="payment-business__advanced"><summary>更多付费拆解</summary>{spec.dimensions.map(dimensionPanel)}</details> : spec.dimensions.map(dimensionPanel)}
  </>;
  return <div ref={root} className="v2-page topic-preview board-preview" data-preview={EXTENDED_BOARD_MARKER} data-board={board}>
    <ReviewTools><div className="topic-preview__notice"><span>开发环境体验 · 合成演示数据，非正式业务结果</span><div role="group" aria-label="演示状态">{[false, true].map(mixed => <Button key={String(mixed)} variant={view.mixed === mixed ? "primary" : "secondary"} onClick={() => { update({ ...view, mixed }); setDraft({ ...draft, mixed }); }}>{mixed ? "组合异常态" : "正常态"}</Button>)}</div></div></ReviewTools>
    <DashboardHeader title={entry.title} breadcrumb={`公共概览 / ${entry.category}`} description={entry.scope}><div className="topic-preview__toolbar"><div className="topic-preview__query"><DashboardQueryFields date={<DateRangePicker value={draft.range} onChange={range => setDraft({ ...draft, range })} today="2026-09-10" maxDate={DEMO_END} maxDays={366} />} scope={<span className="topic-preview__scope">大盘整体</span>} comparison={<BoardSelect label="对比周期" value={draft.compared ? "previous" : "none"} onChange={value => setDraft({ ...draft, compared: value === "previous" })} values={[{ value: "previous", label: "上一等长周期" }, { value: "none", label: "不对比" }]} />} apply={<Button variant="primary" onClick={() => { update(draft); notify("已应用演示条件"); }}>应用</Button>} /></div><div className="topic-preview__actions"><DashboardActions favorite={icon(favorite ? "取消收藏" : "收藏看板", () => { try { setPreviewFavorite(board, !favorite); setFavorite(!favorite); notify(favorite ? "已取消收藏" : "已加入我的收藏（仅本机）"); } catch { notify("本机存储不可用，收藏未保存"); } }, <Star fill={favorite ? "currentColor" : "none"} />, favorite)} copyLink={icon("复制当前视图链接", () => { const href = new URL(hrefFor(board, view), location.origin).href; navigator.clipboard.writeText(href).then(() => notify("已复制当前视图链接")).catch(() => open("复制当前视图链接", <textarea readOnly aria-label="当前视图链接" value={href} />)); }, <Copy />)} refresh={icon("刷新看板", () => { setRecovered([]); notify("演示快照已重新载入"); }, <RefreshCw />)} fullscreen={icon("全屏查看", () => { (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen())?.catch(() => notify("当前环境不支持全屏")); }, <Maximize2 />)} exportAction={<BoardExport title={entry.title} view={view} sheets={sheets} pending={pending} iconOnly />} /></div></div></DashboardHeader>

    {pending && <p className="topic-preview__pending" role="status">条件尚未应用 · 当前结果仍对应已应用条件</p>}
    {board === "5.15" ? <div className="board-preview__experience-stack">
      <section className="board-preview__experience-module" aria-labelledby="startup-diagnosis-heading">
        <DashboardSectionHeading id="startup-diagnosis-heading" title="启动诊断" guidanceKey="experience.startup" />
        <div className="board-preview__experience-content">{standardContent}</div>
      </section>
      <VersionPerformancePreview range={view.range} compared={view.compared} mixed={view.mixed} view={experience} onChange={updateExperience} exportAction={(title, versionSheets, iconOnly) => <BoardExport title={title} view={view} sheets={versionSheets} pending={pending} iconOnly={iconOnly} />} />
    </div> : standardContent}
    <p className="topic-preview__description">日期最多 366 天。正式数据、真实业务维度、对象保存与分析能力按独立准入开放；本页用于本地交互审查。</p>
    {reading && <MetricReadingDialog {...reading} onClose={() => setReading(null)} />}{notice && <Toast notice={notice} onClose={() => notify(null)} />}
  </div>;
}
