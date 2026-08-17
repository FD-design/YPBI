import type { AnalyticsQuery } from "../../contracts/analytics";
import type { CardConfig } from "../../contracts/card";
import { funnelEvents, metrics, modelCapabilities } from "./registry";

export interface ValidationResult { valid: boolean; issues: string[] }

export function validateAnalyticsQuery(query: AnalyticsQuery): ValidationResult {
  const issues: string[] = [];
  const model = modelCapabilities[query.modelId];
  if (!model) issues.push(`分析模型不存在或未开放：${query.modelId}`);
  if (model) {
    query.metricIds.filter((id) => !model.metrics.includes(id)).forEach((id) => issues.push(`当前模型不支持指标：${id}`));
    query.dimensionIds.filter((id) => !model.dimensions.includes(id)).forEach((id) => issues.push(`当前模型不支持维度：${id}`));
  }
  for (const metricId of query.analysisType === "funnel" ? [] : query.metricIds) {
    const metric = metrics[metricId];
    if (!metric) issues.push(`指标不存在或未开放：${metricId}`);
    else if (!metric.analysisTypes.includes(query.analysisType)) issues.push(`${metric.name} 不支持当前分析类型`);
    else query.dimensionIds.filter((id) => !metric.dimensions.includes(id)).forEach((id) => issues.push(`${metric.name} 不支持维度：${id}`));
  }
  if (query.modelId === "acquisition_conversion" && query.dimensionIds.includes("channel")) {
    if (query.metricIds.includes("downloadRegisterRate")) issues.push("下载→注册转化不支持渠道维度，注册数只能关联到平台和日期");
    if (query.metricIds.includes("visitRegisterRate")) issues.push("访问→注册转化不支持渠道维度，注册数只能关联到平台和日期");
  }
  if (query.analysisType === "funnel") {
    if (query.eventIds.length < 2) issues.push("漏斗至少需要 2 个事件");
    const allowed = new Set<string>([...funnelEvents.payment, ...funnelEvents.content]);
    query.eventIds.filter((id) => !allowed.has(id)).forEach((id) => issues.push(`漏斗事件未开放：${id}`));
    if (model && !model.funnelEvents) issues.push(`当前模型不支持漏斗：${query.modelId}`);
    else if (model?.funnelEvents) query.eventIds.filter((id) => !model.funnelEvents?.includes(id)).forEach((id) => issues.push(`当前模型不支持漏斗事件：${id}`));
  } else if (!query.metricIds.length) {
    issues.push("当前分析至少需要 1 个指标");
  }
  return { valid: issues.length === 0, issues };
}

export function validateCardConfig(config: CardConfig): ValidationResult {
  const query: AnalyticsQuery = {
    modelId: config.modelId,
    analysisType: config.analysisType,
    metricIds: config.metricIds,
    dimensionIds: config.dimensionIds,
    eventIds: config.eventIds ?? [],
    platformIds: ["validation"],
    platformMode: "single",
    dateRange: ["2026-01-01", "2026-01-01"],
    filters: {},
    limit: 50
  };
  return validateAnalyticsQuery(query);
}
