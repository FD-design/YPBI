import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { connectedDimensionRows, connectedDimensionSheet } from "./connected-dimension-model";

export { connectedDimensionSeries as playbackDiagnosisSeries, connectedDimensionReading as playbackDiagnosisReading } from "./connected-dimension-model";
export type { ConnectedDimensionRow as PlaybackDiagnosisRow } from "./connected-dimension-model";

const CLIENTS = [{ key: "android", name: "Android" }, { key: "ios", name: "iOS" }, { key: "web", name: "Web" }] as const;
const PLATFORM_METRICS = new Set(["M034", "M036", "M097"]);

export function playbackDiagnosisSupported(id: string, group: string) {
  return group === "客户端平台" && PLATFORM_METRICS.has(id);
}

export function playbackDiagnosisRows(live: LiveDashboardReading, id: string, group: string) {
  return connectedDimensionRows(live, playbackDiagnosisSupported(id, group) ? CLIENTS.map(client => ({ ...client, seriesId: `${id}.${client.key}` })) : []);
}

export function playbackDiagnosisSheet(live: LiveDashboardReading, id: string, group: string) {
  return connectedDimensionSheet(live, id, group, "播放质量诊断", playbackDiagnosisRows(live, id, group), playbackDiagnosisSupported(id, group));
}
