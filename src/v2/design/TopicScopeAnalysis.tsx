import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnalysisScopeControls, useAnalysisGroupVisibility, type AnalysisDisplayMode } from "../features/dashboards/AnalysisScopeControls";
import { GroupedTrend, type GroupedTrendPoint, type TrendGroup } from "../features/dashboards/GroupedTrend";
import { PivotTable } from "../../components/ui/PivotTable";
import { CardViewSwitch, type CardView } from "../../components/ui/CardViewSwitch";
import { MetricSummary } from "../features/dashboards/MetricSummary";
import { dashboardMetricStatusPresentation, type DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { CalculationEvidence } from "../features/dashboards/CalculationEvidence";
import { DetailedMetricTrend } from "../features/dashboards/DetailedMetricTrend";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { liveExportMetadata, useLiveDashboard } from "../features/dashboards/LiveDashboardContext";
import { StatePanel, RefreshNotice } from "../components/StatePanel";
import { DataOriginProvider } from "../components/DataOrigin";
import { DEFAULT_TOPIC_SCOPE, type TopicScope, type TopicView } from "./topic-preview-view";
import { TOPIC_CLIENTS, TOPIC_AUDIENCES, topicMetric, topicScopeLabel, topicUnit, topicValue } from "./topic-preview-fixtures";
import { topicScopeCells, topicScopeExport, topicUsesLiveScopes } from "./topic-scope-model";
import { topicMetadata, topicLimits } from "./topic-preview-export";
import { downloadPreviewWorkbook } from "./preview-workbook";
import { CHART_PALETTE } from "../../theme/tokens";

const GROUP_CLIENTS = TOPIC_CLIENTS.filter(item => item.value === "android" || item.value === "ios");
const GROUP_AUDIENCES = TOPIC_AUDIENCES.filter(item => item.value !== "overall");
const groupKey = (client: string, audience: string) => `${client}:${audience}`;
const unavailableLabel = (model: DashboardMetricCardModel) => model.result.status === "available" ? "未产出" : (model.result.label ?? dashboardMetricStatusPresentation(model).label);

export function TopicScopeAnalysis({ title, id, view, scope, onChange, pending, open }: {
  title: string; id: string; view: TopicView; scope: TopicScope; onChange: (scope: TopicScope) => void; pending: boolean;
  open: (title: string, content: ReactNode) => void;
}) {
  const live = useLiveDashboard(), connected = topicUsesLiveScopes(live, id);
  const cells = useMemo(() => topicScopeCells(id, view, live), [id, view, live]);
  const model = cells.find(cell => cell.scope.client === scope.client && cell.scope.audience === scope.audience)!.model;
  const result = model.result, [chartView, setChartView] = useState<CardView>("trend"), [mode, setMode] = useState<AnalysisDisplayMode>(() => scope.client === "overall" && scope.audience === "overall" ? "groups" : "overall");
  const visibility = useAnalysisGroupVisibility(GROUP_CLIENTS.map(item => item.value), GROUP_AUDIENCES.map(item => item.value), `${id}:${view.active.start}:${view.active.end}:${view.compared}:${connected}`);
  useEffect(() => {
    if (scope.client !== "overall" || scope.audience !== "overall") setMode("overall");
  }, [scope.client, scope.audience]);
  const available = result.status === "available" ? result : result.history;
  const trendModel = available ? {...model,result:available} : model;
  const selected = `${topicMetric(id).name} · ${topicScopeLabel(scope)}`;
  const groups: TrendGroup[] = GROUP_CLIENTS.flatMap((client, clientIndex) => GROUP_AUDIENCES.map((audience, audienceIndex) => ({ id: groupKey(client.value, audience.value), label: `${client.label} · ${audience.label}`, color: CHART_PALETTE[clientIndex * 2 + audienceIndex] })));
  const groupModels = new Map(groups.map(group => {
    const [client, audience] = group.id.split(":");
    return [group.id, cells.find(cell => cell.scope.client === client && cell.scope.audience === audience)!.model];
  }));
  const overallModel = cells.find(cell => cell.scope.client === "overall" && cell.scope.audience === "overall")!.model;
  const usable = (item: typeof model) => item.result.status === "available" ? item.result : item.result.history;
  const overallReading = usable(overallModel);
  const pointCount = Math.max(overallReading?.trend.current.length ?? 0, ...groups.map(group => usable(groupModels.get(group.id)!)?.trend.current.length ?? 0));
  const groupedPoints: GroupedTrendPoint[] = Array.from({ length: pointCount }, (_, index) => {
    const overallPoint = overallReading?.trend.current[index];
    const values: Record<string, number | null> = {}, states: Record<string, string> = {}, basis: NonNullable<GroupedTrendPoint["basis"]> = {};
    const previousValues: Record<string, number | null> = {}, previousBasis: NonNullable<NonNullable<GroupedTrendPoint["comparison"]>["basis"]> = {};
    groups.forEach(group => {
      const reading = usable(groupModels.get(group.id)!);
      const point = reading?.trend.current[index];
      values[group.id] = point?.value?.raw ?? null;
      states[group.id] = point?.stateLabel ?? unavailableLabel(groupModels.get(group.id)!);
      if (point?.calculation) basis[group.id] = point.calculation;
      previousValues[group.id] = point?.counterpart?.raw ?? null;
      const prior = reading?.trend.comparison?.[index];
      if (prior?.calculation) previousBasis[group.id] = prior.calculation;
    });
    return {
      date: overallPoint?.actualDate ?? usable(groupModels.get(groups[0].id)!)?.trend.current[index]?.actualDate ?? "—",
      values,
      states,
      basis,
      overall: overallPoint?.value?.raw ?? null,
      overallBasis: overallPoint?.calculation,
      ...(view.compared ? { comparison: { date: overallPoint?.counterpart?.actualDate ?? "—", values: previousValues, basis: previousBasis, overall: overallPoint?.counterpart?.raw ?? null, overallBasis: overallReading?.trend.comparison?.[index]?.calculation } } : {})
    };
  });
  const selectedGroups = visibility.groups;
  const exportControl = <PreviewExportControl name={title + "二维分析"} dataOrigin={connected ? "live" : "demo"} pending={pending || (connected && (!live!.canExport || live!.controls.dirty || live!.state.status !== "success"))}
    context={connected ? "真实接口候选结果 · 待验数" : "合成演示数据"} scope="全部客户端 × 人群的摘要和逐日结果，保留空值、计算输入与对比日期；不随单元格点选裁剪。"
    onDownloadPreview={() => downloadPreviewWorkbook(title, [connected ? {name:"00_导出说明",rows:[...liveExportMetadata(live!), ["当前分析范围", topicScopeLabel(scope)]]} : topicMetadata({...view,reading:{...view.reading!,scope}},id === "M016"), {name:"02_二维结构",rows:topicScopeExport(id,view,live)}, ...(connected ? [] : [topicLimits()])], connected ? "pending" : "demo")} />;
  return <DataOriginProvider value={connected ? "pending" : "demo"}><div className="topic-scope-analysis" data-testid="topic-scope-analysis">
    <AnalysisScopeControls label="分析范围" onReset={() => { onChange(DEFAULT_TOPIC_SCOPE); setMode("overall"); }} canReset={scope.client !== "overall" || scope.audience !== "overall"} tools={exportControl}
      groupDisplay={{ mode, onModeChange: next => { setMode(next); onChange(DEFAULT_TOPIC_SCOPE); }, clientOptions: GROUP_CLIENTS, selectedClients: visibility.clients, onClientsChange: visibility.setClients, audienceOptions: GROUP_AUDIENCES, selectedAudiences: visibility.audiences, onAudiencesChange: visibility.setAudiences, onRestoreAll: visibility.restoreAll, canRestoreAll: !visibility.isAll }}
      note={mode === "overall" ? `当前读取：${topicScopeLabel(scope)}的独立结果。点选交叉表可聚焦同一范围。` : `当前显示 ${selectedGroups.length} 个客户端 × 人群分组；对比期同步显示同组。`} />
    {connected && live!.state.status === "success" && live!.state.refreshError && <RefreshNotice onRetry={live!.retry}>刷新失败，当前保留上次查询结果。</RefreshNotice>}
    {mode === "overall" ? <section className="topic-scope-analysis__reading" aria-label={title + "当前范围"}>
      <div className="topic-scope-analysis__summary"><MetricSummary title={topicMetric(id).name} context={model.metric.aggregationLabel} value={result.status === "available" ? result.value.display : "—"} unit={result.status === "available" ? result.value.unit : topicUnit(id)} comparison={result.status === "available" ? result.comparison : null} note={result.status === "available" && result.completeness === "partial" ? "部分日期待加工，摘要仅含已返回日期；逐日状态见明细。" : undefined}/><CardViewSwitch label={title + "当前范围"} value={chartView} onChange={setChartView}/></div>
      {result.status !== "available" && <StatePanel compact kind={result.status === "loading" ? "loading" : result.status === "failed" ? "error" : "empty"} title={result.label ?? "该范围暂无结果"} description={result.message ?? "请选择有数据的范围。"} action={result.retryable && live ? {label:"重新读取",onClick:live.retry} : undefined}/>}
      {available && <>
        {available.calculation && <CalculationEvidence basis={available.calculation}/>}
        <DetailedMetricTrend model={trendModel} view={chartView} exportAction={exportControl} onOpenPoint={(point, period) => open(selected, <><p>{period === "current" ? "当前期" : "对比期"} · {point.actualDate}</p><p>{point.value?.display ?? "—"} · {point.stateLabel}</p>{point.calculation && <CalculationEvidence basis={point.calculation}/>}</>)} />
      </>}
    </section> : <section className="topic-scope-analysis__reading" aria-label={title + "分组对比"}>
      <GroupedTrend title={topicMetric(id).name} groups={groups} points={groupedPoints} kind="line" unit={topicUnit(id)} format={value => topicValue(id, value)} queryKey={`${id}:${view.active.start}:${view.active.end}:${view.compared}:${connected}`} exportAction={exportControl} onOpen={open} mode="groups" showControls={false} showLegend selection={{ selected: selectedGroups, setSelected: visibility.setGroups }} summary={selectedIds => <div className="topic-preview__group-summary">{selectedIds.map(groupId => {
        const group = groups.find(item => item.id === groupId)!;
        const reading = usable(groupModels.get(groupId)!);
        return <section key={groupId}><span>{group.label}</span><strong>{reading?.value.display ?? "—"}</strong><small>{reading ? groupModels.get(groupId)!.metric.aggregationLabel : unavailableLabel(groupModels.get(groupId)!)}</small></section>;
      })}</div>} />
    </section>}
    <section aria-label={title + "二维对照"}>
      <p className="dashboard-table-context">客户端 × 新老用户 · {topicMetric(id).name}（{topicUnit(id)}）。总体及各组人数独立读取，不相加推算；“—”表示该范围未返回。</p>
      <PivotTable label={title + "二维交叉表"} rowHeading="客户端" columns={TOPIC_AUDIENCES.map(item => item.label)} resetKey={JSON.stringify([id,view.active])}
        rows={TOPIC_CLIENTS.map(client => ({key:client.value,label:client.label,values:TOPIC_AUDIENCES.map(audience => { const cell = cells.find(cell => cell.scope.client === client.value && cell.scope.audience === audience.value)!;return cell.model.result.status === "available" ? cell.model.result.value.display : <span title={cell.model.result.message ?? unavailableLabel(cell.model)}>{unavailableLabel(cell.model)}</span>;})}))}
        selectedCell={mode === "overall" ? {rowKey:scope.client,columnIndex:TOPIC_AUDIENCES.findIndex(item => item.value === scope.audience)} : null}
        canSelectCell={cell => cells.find(item => item.scope.client === cell.rowKey && item.scope.audience === TOPIC_AUDIENCES[cell.columnIndex].value)?.model.result.status === "available"}
        onSelectCell={cell => { onChange({client:cell.rowKey as TopicScope["client"],audience:TOPIC_AUDIENCES[cell.columnIndex].value}); setMode("overall"); }}/>
    </section>
  </div></DataOriginProvider>;
}
