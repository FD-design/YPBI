import { liveCalculation, liveMetricModel, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { dailyReferenceDates } from "../features/dashboards/daily-reading-model";
import type { DashboardMetricAvailableResult, DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { connectedDimensionReading, connectedDimensionRows, connectedDimensionSeries, connectedDimensionSheet } from "./connected-dimension-model";
import { PLAYBACK_VIDEO_TYPE_IDS, playbackGroupIdentity, playbackGroupKeys, playbackGroupMetric, playbackGroupNotice, playbackGroupPeriod, playbackGroupReading, playbackGroupSeriesId, playbackVideoTypeSheet } from "./live-playback-groups";

export type { ConnectedDimensionRow as PlaybackDiagnosisRow } from "./connected-dimension-model";

const CLIENTS = [{ key: "android", name: "Android" }, { key: "ios", name: "iOS" }, { key: "web", name: "Web" }] as const;
const PLATFORM_METRICS = new Set(["M034", "M036", "M097"]);

export function playbackDiagnosisSupported(id: string, group: string) {
  return group === "客户端平台" && PLATFORM_METRICS.has(id) || group === "视频类型" && PLAYBACK_VIDEO_TYPE_IDS.some(metric => metric === id);
}

export const playbackDiagnosisNotice = (live: LiveDashboardReading, id: string, group: string) => group === "视频类型" && playbackDiagnosisSupported(id, group) ? playbackGroupNotice(live, id) : null;
export function playbackDiagnosisReading(live: LiveDashboardReading, id: string) {
  return connectedDimensionReading(playbackGroupIdentity(id) ? playbackGroupReading(live, id) : live, id);
}
export function playbackDiagnosisSeries(live: LiveDashboardReading, id: string, before = false) {
  return connectedDimensionSeries(playbackGroupIdentity(id) ? playbackGroupReading(live, id) : live, id, before);
}

function ruleIssue(live: LiveDashboardReading, seriesId: string, currentDate: string, previousDate: string) {
  const identity = playbackGroupIdentity(seriesId);
  if (!identity) return null;
  const version = (date: string) => {
    const period = [live, live.comparison, live.dayReference].find(period => period && date >= period.query.dateRange[0] && date <= period.query.dateRange[1]);
    if (!period || period.state.status !== "success" || !period.state.data) return null;
    const source = playbackGroupMetric(playbackGroupPeriod({ ...live, ...period, state: { ...period.state, data: period.state.data } }), identity.key, identity.id);
    return source.points.find(point => point.date === date)?.ruleVersion ?? null;
  };
  const current = version(currentDate), previous = version(previousDate);
  return current && previous && current !== previous ? "规则版本不同，不比较差值" : null;
}
export const playbackDiagnosisComparisonIssue = (live: LiveDashboardReading, row: { seriesId: string }) => live.comparison ? ruleIssue(live, row.seriesId, live.query.dateRange[1], live.comparison.query.dateRange[1]) : null;

/** Keep both returned trends while disabling only comparisons across different rules. */
export function playbackDiagnosisMetricModel(live: LiveDashboardReading, id: string, original: DashboardMetricCardModel) {
  if (!playbackGroupIdentity(id)) return undefined;
  const model = liveMetricModel(original, live);
  const project = (result: DashboardMetricAvailableResult): DashboardMetricAvailableResult => {
    const issue = playbackDiagnosisComparisonIssue(live, { seriesId: id });
    const trend = (points: DashboardMetricAvailableResult["trend"]["current"]) => points.map(point => {
      const issue = point.counterpart && ruleIssue(live, id, point.actualDate, point.counterpart.actualDate);
      return issue ? { ...point, differenceDisplay: null, comparisonUnavailableReason: issue } : point;
    });
    return { ...result, comparison: issue && result.comparison ? { status: "unavailable", label: result.comparison.label, detail: issue } : result.comparison,
      trend: { ...result.trend, current: trend(result.trend.current), comparison: result.trend.comparison && trend(result.trend.comparison) },
      ...(result.reading ? { reading: { ...result.reading, comparisons: result.reading.comparisons.map((comparison, index) => {
        const issue = ruleIssue(live, id, live.query.dateRange[1], dailyReferenceDates(live.query.dateRange[1])[index]);
        return issue ? { status: "unavailable" as const, label: comparison.label, detail: issue } : comparison;
      }) } } : {}) };
  };
  return { ...model, result: model.result.status === "available" ? project(model.result) : { ...model.result, ...(model.result.history ? { history: project(model.result.history), reading: project(model.result.history).reading } : {}) } };
}

export function playbackDiagnosisRows(live: LiveDashboardReading, id: string, group: string) {
  if (group === "视频类型" && playbackDiagnosisSupported(id, group)) return playbackGroupKeys(live).map((key, index) => {
    const current = playbackGroupPeriod(live), previous = playbackGroupPeriod(live, true);
    const currentSource = playbackGroupMetric(current, key, id), previousSource = playbackGroupMetric(previous, key, id);
    const now = currentSource.series ? currentSource : playbackGroupMetric(current, key, id, previousSource.selected?.metric);
    const before = previousSource.series ? previousSource : playbackGroupMetric(previous, key, id, currentSource.selected?.metric);
    const point = now.points.at(-1), prior = before.points.at(-1);
    return { key, name: key, position: index + 1, seriesId: playbackGroupSeriesId(id, key), series: now.series, baselineSeries: before.series,
      value: point?.value ?? null, baseline: prior?.value ?? null, state: point?.label ?? now.issue ?? "当日未返回", baselineState: prior?.label ?? before.issue ?? "当日未返回",
      calculation: now.series && point ? liveCalculation(now.series, now.series.points.at(-1)!) : undefined,
      baselineCalculation: before.series && prior ? liveCalculation(before.series, before.series.points.at(-1)!) : undefined,
      freshness: current.freshness === "本次查询结果" ? "" : current.freshness };
  });
  return connectedDimensionRows(live, playbackDiagnosisSupported(id, group) ? CLIENTS.map(client => ({ ...client, seriesId: `${id}.${client.key}` })) : []);
}

export function playbackDiagnosisSheet(live: LiveDashboardReading, id: string, group: string) {
  if (group === "视频类型" && playbackDiagnosisSupported(id, group)) return playbackVideoTypeSheet(live, [id]);
  return connectedDimensionSheet(live, id, group, "播放质量诊断", playbackDiagnosisRows(live, id, group), playbackDiagnosisSupported(id, group));
}
