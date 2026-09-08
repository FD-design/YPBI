import {
  M016_AUTHORITY_VERSION,
  M016_METRIC_ID,
  type MetricCatalogItem,
  type PlatformCatalogItem
} from "../../contracts/bi-v2";
import { platformRegistry } from "../platforms/registry";

export const v2MetricCatalog: readonly MetricCatalogItem[] = [{
  id: M016_METRIC_ID,
  code: "daily_active_user_count",
  name: "日活跃用户数",
  definition: "当天打开并登录产品的去重用户数",
  unit: "人",
  valueType: "integer",
  authority: {
    document: "全站指标体系.md",
    version: M016_AUTHORITY_VERSION,
    validationStatus: "pending_validation",
    statusLabel: "技术称已实现（待验数）"
  },
  capabilities: {
    grains: ["day"],
    platformMode: "single_pid",
    dimensions: [],
    filters: [],
    comparisons: []
  }
}];

export function getV2Metric(metricId: string) {
  return v2MetricCatalog.find((metric) => metric.id === metricId);
}

export function listV2Platforms(pidScope: "all" | readonly string[]): PlatformCatalogItem[] {
  const allowed = pidScope === "all" ? null : new Set(pidScope);
  return platformRegistry
    .filter((platform) => platform.enabled && (!allowed || allowed.has(platform.pid)))
    .sort((left, right) => left.order - right.order)
    .map((platform) => ({ id: platform.hxId, pid: platform.pid, name: platform.name, order: platform.order }));
}
