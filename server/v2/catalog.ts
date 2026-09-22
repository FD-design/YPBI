import {
  M016_METRIC_ID,
  metricCatalogItemSchema,
  type MetricCatalogItem,
  type MetricDefinitionItem,
  type PlatformCatalogItem
} from "../../contracts/bi-v2";
import { platformRegistry } from "../platforms/registry";
import { getV2MetricDefinition, hasCurrentExecutableMetricMapping } from "./metric-definitions";

export function projectLegacyV2MetricCatalog(
  definitions: readonly MetricDefinitionItem[]
): MetricCatalogItem[] {
  const m016Definition = definitions.find((item) => item.id === M016_METRIC_ID);
  if (
    !m016Definition
    || !hasCurrentExecutableMetricMapping(m016Definition)
    || m016Definition.ypbiMapping.capabilities.platformModes.length !== 1
  ) return [];

  const m016Capabilities = m016Definition.ypbiMapping.capabilities;
  const validationStatus = m016Definition.analysis.status === "available" ? "passed" : "pending_validation";
  const projected = metricCatalogItemSchema.safeParse({
    id: M016_METRIC_ID,
    code: m016Definition.code,
    name: m016Definition.name,
    definition: m016Definition.authority.definition,
    // 旧目录仍使用固定展示类型；完整定义源当前尚未登记标准指标单位字段。
    unit: "人",
    valueType: "integer",
    authority: {
      document: "全站指标体系.md",
      version: m016Definition.authority.version,
      validationStatus,
      statusLabel: validationStatus === "passed"
        ? "真实验数已通过"
        : "技术称已实现（待验数）"
    },
    capabilities: {
      grains: m016Capabilities.grains,
      platformMode: m016Capabilities.platformModes[0],
      dimensions: m016Capabilities.dimensions,
      filters: m016Capabilities.filters,
      comparisons: m016Capabilities.comparisons
    }
  });
  return projected.success ? [projected.data] : [];
}

export const v2MetricCatalog: readonly MetricCatalogItem[] = projectLegacyV2MetricCatalog(
  [getV2MetricDefinition(M016_METRIC_ID)].filter((item): item is MetricDefinitionItem => Boolean(item))
);

export function getV2Metric(metricId: string) {
  return v2MetricCatalog.find((metric) => metric.id === metricId);
}

export function listV2Platforms(pidScope: "all" | readonly string[]): PlatformCatalogItem[] {
  const allowed = pidScope === "all" ? null : new Set(pidScope);
  return platformRegistry
    .filter((platform) => platform.enabled && (!allowed || allowed.has(platform.pid)))
    .sort((left, right) => left.order - right.order)
    .map((platform) => ({ id: platform.id, pid: platform.pid, name: platform.name, order: platform.order }));
}
