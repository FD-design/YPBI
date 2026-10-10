import type { DailyDashboardSuccess, DailyPlaybackGroupSeries, DailyPlaybackSummary, DailyReadingMetric } from "../../../contracts/daily-dashboard";
import { livePointStateLabel, type LiveDashboardReading, type LiveSeries } from "../features/dashboards/LiveDashboardContext";
import type { WorkbookSheet } from "./preview-workbook";

export const PLAYBACK_VIDEO_TYPE_IDS = ["M097", "M036"] as const;
export type PlaybackScope = Pick<LiveDashboardReading, "query" | "state" | "comparison">;
const prefix = (id: string) => `${id}.videoType:`;
export const playbackGroupSeriesId = (id: string, key: string) => prefix(id) + key;
export function playbackGroupIdentity(seriesId: string) {
  const id = PLAYBACK_VIDEO_TYPE_IDS.find(id => seriesId.startsWith(prefix(id)));
  return id ? { id, key: seriesId.slice(prefix(id).length) } : null;
}

export function playbackGroupPeriod(live: PlaybackScope, before = false) {
  const period = before ? live.comparison : live;
  const result = period?.state.status === "success" ? period.state.data : null;
  const matches = period && result && live.query.boardId === "5.12" && period.query.boardId === live.query.boardId && period.query.pid === live.query.pid
    && result.data.query.boardId === period.query.boardId && result.data.query.pid === period.query.pid
    && result.data.query.dateRange.every((date, index) => date === period.query.dateRange[index]);
  const extension = matches && result.data.schemaVersion === "day-dashboard/v2" ? result.data.playbackGroups?.videoType : undefined;
  const blocked = !period ? "未启用对比" : period.state.status === "loading" ? "读取中" : period.state.status === "failure" ? "读取失败"
    : !matches ? "查询范围不匹配" : !extension ? "视频类型真实分组待接入" : extension.dimension !== "videoType" ? "数据异常" : undefined;
  const requestState = extension?.day.state;
  const requestIssue = blocked ?? (requestState === "source_failure" ? "来源读取失败" : requestState === "invalid_response" ? "数据异常" : requestState === "empty" ? "本期未返回分组记录" : undefined);
  const groups = blocked ? [] : extension?.groups ?? [];
  const dates: string[] = [];
  if (period) for (let time = Date.parse(period.query.dateRange[0]); time <= Date.parse(period.query.dateRange[1]); time += 86400000) dates.push(new Date(time).toISOString().slice(0, 10));
  return { period, result: matches ? result : null, extension, groups, dates, requestIssue,
    freshness: period?.state.status === "success" && period.state.refreshError ? "刷新失败，保留上次查询结果" : period?.state.status === "success" && period.state.refreshing ? "刷新中，保留上次查询结果" : "本次查询结果" };
}
type GroupPeriod = ReturnType<typeof playbackGroupPeriod>;
export function playbackGroupKeys(live: PlaybackScope) {
  return [...new Set([...playbackGroupPeriod(live).groups, ...(live.comparison ? playbackGroupPeriod(live, true).groups : [])].map(group => group.key))];
}
function scopeStatus(period: GroupPeriod, id: string, date?: string) {
  return period.extension?.day.scopeStatuses.find(status => status.metricId === id && (!status.businessDate || date === status.businessDate))?.sourceStatus;
}
function statusLabel(sourceStatus: LiveSeries["points"][number]["sourceStatus"]) {
  return livePointStateLabel({ date: "", value: null, inputs: [], state: "no_value", sourceStatus });
}
export function playbackGroupNotice(live: PlaybackScope, id: string) {
  const notice = (before: boolean) => {
    const period = playbackGroupPeriod(live, before);
    const scopes = period.extension?.day.scopeStatuses.filter(status => status.metricId === id).map(status => `${status.businessDate ? status.businessDate + " · " : ""}${statusLabel(status.sourceStatus)}`) ?? [];
    return period.requestIssue ?? ([...new Set(scopes)].join("；") || (!period.groups.length ? "本期未返回分组记录" : null));
  };
  const current = notice(false), previous = live.comparison ? notice(true) : null;
  return [current && `当前期：${current}`, previous && `对比期：${previous}`].filter(Boolean).join("；") || null;
}

export function playbackGroupMetric(period: GroupPeriod, key: string, id: string, fallbackMetric?: DailyReadingMetric) {
  const groups = period.groups.filter(group => group.key === key), matches = groups[0]?.series.filter(series => series.metric.id === id) ?? [];
  const selected = matches.length === 1 ? matches[0] : undefined;
  const metric = selected?.metric ?? fallbackMetric;
  const issue = period.requestIssue ?? (groups.length > 1 || matches.length > 1 ? "数据异常" : !groups.length ? "本期未返回该分组" : !selected ? "指标未返回" : undefined);
  const normalize = (point: DailyPlaybackSummary | DailyPlaybackGroupSeries["points"][number] | undefined, date?: string) => {
    const invalid = !selected || !point || point.inputs.length !== selected.metric.inputs.length
      || selected.metric.inputs.some(input => point.inputs.filter(value => value.key === input.key).length !== 1)
      || point.inputs.some(input => input.value !== null && (!Number.isFinite(input.value) || input.value < 0));
    const duplicate = date && selected && selected.points.filter(point => point.date === date).length > 1;
    const sourceStatus = point?.sourceStatus ?? scopeStatus(period, id, date);
    const state = issue === "来源读取失败" || issue === "读取失败" ? "source_failure" : issue === "本期未返回分组记录" || issue === "本期未返回该分组" ? "no_record"
      : issue || duplicate ? "invalid_value" : !point ? "no_record" : point.state;
    const ready = !issue && !duplicate && sourceStatus === "READY" && typeof point?.ruleVersion === "string" && point.ruleVersion.length > 0 && !invalid;
    const readable = ready && (state === "available" && point!.value !== null && Number.isFinite(point!.value) && point!.value >= 0 || state === "zero_denominator");
    const normalizedState = state === "available" && !readable ? "invalid_value" : state;
    return { date: date ?? period.period?.query.dateRange.join(" 至 ") ?? "", value: readable && state === "available" ? point!.value : null,
      state: normalizedState, sourceStatus, ruleVersion: issue ? null : point?.ruleVersion ?? null,
      inputs: metric?.inputs.map(input => ({ key: input.key, value: readable ? point!.inputs.find(value => value.key === input.key)?.value ?? null : null })) ?? [],
      label: issue ?? (duplicate ? "数据异常" : sourceStatus && sourceStatus !== "READY" ? statusLabel(sourceStatus) : normalizedState === "incomplete" ? "区间结果不完整" : livePointStateLabel({ date: date ?? "", state: normalizedState, sourceStatus, value: null, inputs: [] })) };
  };
  const points = period.dates.map(date => normalize(selected?.points.find(point => point.date === date), date));
  const summary = normalize(selected?.summary);
  const versions = selected ? [...new Set(points.map(point => point.ruleVersion ?? "未返回"))].join("；") : "";
  const series: LiveSeries | undefined = metric ? { metric: { ...metric, id: playbackGroupSeriesId(id, key), name: `${metric.name} · ${key}`,
    sourceNote: [metric.sourceNote, `视频类型：${key}。${selected ? `规则版本：${versions}` : issue}`].filter(Boolean).join("；") },
    points: points.map(point => ({ ...point, state: point.state === "incomplete" ? "no_value" : point.state })) } : undefined;
  return { series, summary, points, selected, issue: issue ?? (scopeStatus(period, id) ? statusLabel(scopeStatus(period, id)) : undefined) };
}

/** Project one returned group into the existing daily detail/trend reader; never an overall series. */
export function playbackGroupReading(live: LiveDashboardReading, seriesId: string): LiveDashboardReading {
  const identity = playbackGroupIdentity(seriesId);
  if (!identity) return live;
  const fallbackMetric = [playbackGroupPeriod(live), playbackGroupPeriod(live, true)].map(period => playbackGroupMetric(period, identity.key, identity.id).selected?.metric).find(Boolean);
  const project = (period: Pick<LiveDashboardReading, "query" | "state">) => {
    if (period.state.status !== "success") return period.state;
    const group = playbackGroupMetric(playbackGroupPeriod({ ...live, ...period }), identity.key, identity.id, fallbackMetric);
    return { ...period.state, data: { ...period.state.data, data: { ...period.state.data.data, series: group.series ? [group.series] : [] } } as DailyDashboardSuccess };
  };
  const optional = (period: LiveDashboardReading["comparison"] | LiveDashboardReading["dayReference"]) => period && ({ ...period, state: period.state.status === "success" && period.state.data ? project({ ...period, state: { ...period.state, data: period.state.data } }) : period.state });
  return { ...live, metricIds: [seriesId], state: project(live), comparison: optional(live.comparison) as LiveDashboardReading["comparison"], dayReference: optional(live.dayReference) };
}

/** Both the region and whole-board export use the same complete, unfiltered group facts. */
export function playbackVideoTypeSheet(live: PlaybackScope, ids: readonly string[] = PLAYBACK_VIDEO_TYPE_IDS, onlyKey?: string): WorkbookSheet {
  const rows: WorkbookSheet["rows"] = [["数据性质", "真实后台候选结果，待验数；分组完整性未知，仅展示已返回标识"],
    ...ids.map(id => [id, playbackGroupNotice(live, id) ?? "已返回"]),
    ["周期", "平台", "视频类型", "指标", "日期", "结果（原始值）", "单位", "计算输入", "状态", "规则版本", "查询时间", "数据至", "刷新状态", "指标版本"]];
  for (const key of playbackGroupKeys(live).filter(key => onlyKey === undefined || key === onlyKey)) for (const id of ids) for (const before of live.comparison ? [false, true] : [false]) {
    const period = playbackGroupPeriod(live, before), reading = playbackGroupMetric(period, key, id);
    for (const point of [...reading.points, reading.summary]) rows.push([before ? "对比期" : "当前期", live.query.pid, key, reading.selected?.metric.name ?? id,
      point.date, point.value, reading.selected?.metric.unit === "%" ? "原始比值" : reading.selected?.metric.unit ?? "",
      point.inputs.map(input => { const metadata = reading.selected?.metric.inputs.find(item => item.key === input.key); return `${metadata?.name ?? input.key}：${input.value ?? "—"} ${metadata?.unit ?? ""}`; }).join("；"),
      point.label, point.ruleVersion, period.result?.data.fetchedAt ?? "", period.extension?.day.watermark ?? null, period.freshness, reading.selected?.metric.authorityVersion ?? ""]);
  }
  return { name: "播放质量视频类型", rows };
}
export function playbackDiagnosisBoardSheets(live: PlaybackScope): WorkbookSheet[] {
  return live.query.boardId === "5.12" ? [playbackVideoTypeSheet(live)] : [];
}
