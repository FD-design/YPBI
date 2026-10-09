import { liveMetricUnit, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { connectedDimensionRows, connectedDimensionSheet } from "./connected-dimension-model";

const STAGE_METRICS = new Set(["M058", "M059", "M067"]);
export function paymentDimensionSupported(id: string, group: string) {
  return group === "新老用户" && STAGE_METRICS.has(id) || group === "商品" && id === "M058";
}

export function paymentDimensionRows(live: LiveDashboardReading, id: string, group: string) {
  const groups = group === "新老用户" && STAGE_METRICS.has(id)
    ? [{ key: "new", name: "新用户", seriesId: `${id}.new` }, { key: "old", name: "老用户", seriesId: `${id}.old` }]
    : group === "商品" && id === "M058" ? [{ key: "vip", name: "VIP", seriesId: "M065" }, { key: "coin", name: "金币", seriesId: "M066" }] : [];
  return connectedDimensionRows(live, groups);
}

export function paymentDimensionUnit(live: LiveDashboardReading, id: string, group: string) {
  const units = [...new Set(paymentDimensionRows(live, id, group).flatMap(row => row.series ? [row.series.metric.unit] : []))];
  return units.length === 1 ? units[0] : units.length ? "" : liveMetricUnit(live, id) ?? "";
}

export function paymentDimensionCross(group: string) {
  return group === "平台 × 新老用户" ? { rows: [{ key: "android", label: "Android" }, { key: "ios", label: "iOS" }, { key: "web", label: "Web" }], columns: ["新用户", "老用户"] } : undefined;
}

export function paymentDimensionSheet(live: LiveDashboardReading, id: string, group: string) {
  return connectedDimensionSheet(live, id, group, "付费结构", paymentDimensionRows(live, id, group), paymentDimensionSupported(id, group));
}
