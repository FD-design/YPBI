import { liveMetricModel, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { DEFAULT_TOPIC_SCOPE, type TopicScope, type TopicView } from "./topic-preview-view";
import { TOPIC_CLIENTS, TOPIC_AUDIENCES, topicCard, topicMetric, topicScopeLabel, topicUnit } from "./topic-preview-fixtures";
import { metricRows } from "./topic-preview-export";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";

/** Real scopes are explicit adapter series. A joint result never comes from joining marginal totals. */
export function topicLiveScopeId(id: string, scope: TopicScope) {
  if (scope.client !== "overall" && scope.audience !== "overall") return null;
  if (scope.client !== "overall") return `${id}.${scope.client}`;
  return scope.audience === "overall" ? id : `${id}.${scope.audience === "existing" ? "old" : "new"}`;
}
export function topicUsesLiveScopes(live: LiveDashboardReading | null, id: string) {
  return Boolean(live?.metricIds.some(metricId => metricId === id || metricId.startsWith(id + ".")));
}
export function topicScopeModel(id: string, view: TopicView, scope = DEFAULT_TOPIC_SCOPE, live: LiveDashboardReading | null = null): DashboardMetricCardModel {
  if (!topicUsesLiveScopes(live, id)) return topicCard(id, view.active, view.compared, view.mixed, scope);
  const definition = topicMetric(id);
  // Connected scopes need catalog metadata, never generated demonstration observations.
  const original: DashboardMetricCardModel = { metric: { ...definition, definitionLabel: definition.definition, aggregationLabel: topicScopeLabel(scope) }, result: {
    status: "not_ready", label: "该范围待接入", contextLabel: topicScopeLabel(scope), retryable: false
  } };
  const sourceId = topicLiveScopeId(id, scope);
  if (!sourceId || !live!.metricIds.includes(sourceId)) return { metric: original.metric, result: {
    status: "not_ready" as const, label: "该范围待接入", contextLabel: topicScopeLabel(scope), retryable: false,
    message: "需要同一客户端与人群范围的独立结果；总体和单维结果保持可读。"
  } };
  const model = liveMetricModel({ ...original, metric: { ...original.metric, id: sourceId } }, live!);
  return { ...model, metric: { ...model.metric, id, aggregationLabel: model.metric.aggregationLabel + " · " + topicScopeLabel(scope) } };
}
export function topicScopeCells(id: string, view: TopicView, live: LiveDashboardReading | null = null) {
  return TOPIC_CLIENTS.flatMap(client => TOPIC_AUDIENCES.map(audience => {
    const scope = { client: client.value, audience: audience.value };
    return { scope, model: topicScopeModel(id, view, scope, live) };
  }));
}
export function topicScopeExport(id: string, view: TopicView, live: LiveDashboardReading | null = null) {
  const cells = topicScopeCells(id, view, live);
  const named = cells.map(cell => ({...cell.model, metric:{...cell.model.metric,name:cell.model.metric.name + " · " + topicScopeLabel(cell.scope)}}));
  const rows = metricRows(named, () => topicUnit(id));
  return [["客户端", "用户人群", ...rows[0]], ...rows.slice(1).map(row => {
    const index = named.findIndex(model => model.metric.name === row[0]), scope = cells[index].scope;
    return [TOPIC_CLIENTS.find(item => item.value === scope.client)!.label, TOPIC_AUDIENCES.find(item => item.value === scope.audience)!.label, ...row];
  })];
}
