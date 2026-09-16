import { liveCalculation, liveStateLabel, liveValue, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";

/** Exact metric + scope + date only. Never substitute a parent projection for a slice. */
export function liveObservation(live: LiveDashboardReading | null, id: string, date: string) {
  if (!live?.metricIds.includes(id)) return null;
  const series = live.state.status === "success" && live.state.data.data.query.pid === live.query.pid ? live.state.data.data.series.find(series => series.metric.id === id) : undefined;
  const point = series?.points.find(point => point.date === date);
  const state = live.state.status === "loading" ? "正在读取" : live.state.status === "failure" ? "读取失败" : point ? liveStateLabel[point.state] : "当日无记录";
  return { value: point?.value ?? null, unit: series?.metric.unit ?? "", display: point && series ? liveValue(point.value, series.metric.unit) : "—", state,
    basis: point && series ? liveCalculation(series, point) : undefined, series, result: live.state.status === "success" ? live.state.data : null };
}
