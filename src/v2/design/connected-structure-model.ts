import type { DailyDashboardQuery, DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { shiftDate } from "../../components/ui/date-range-model";
import { liveCalculation, liveExportMetadata, livePointStateLabel, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import type { GroupedTrendPoint } from "../features/dashboards/GroupedTrend";
import { availablePeriodStatistics } from "../features/dashboards/live-period-statistics";
import type { WorkbookSheet } from "./preview-workbook";
import { diagnosticRatioInputs } from "../features/dashboards/diagnostic-inputs";

export function liveStructureIds(live: LiveDashboardReading | null, id: string, dimension: string) {
  if (!live) return null;
  const groups = dimension === "platform" ? ["android", "ios", "web"].map((suffix, i) => ({ id: `${id}.${suffix}`, label: ["Android", "iOS", "Web"][i] }))
    : dimension === "users" ? ["new", "old"].map((suffix, i) => ({ id: `${id}.${suffix}`, label: ["新用户", "老用户"][i] }))
      : dimension === "acquisition" ? [{ id: `${id}.nature`, label: "自然新增" }, { id: `${id}.internal`, label: "内部导量" }] : [];
  return groups.some(group => live.metricIds.includes(group.id)) ? groups : null;
}

function datesIn(query: DailyDashboardQuery | undefined) {
  if (!query) return [];
  const count = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
  return Number.isInteger(count) && count > 0 && count <= 366
    ? Array.from({ length: count }, (_, i) => shiftDate(query.dateRange[0], i)) : [];
}

function period(live: LiveDashboardReading, before = false) {
  const source = before ? live.comparison : live;
  const query = source?.query;
  const received = source?.state.status === "success" ? source.state.data : null;
  const actual = received?.data.query;
  const result = query && actual && query.pid === live.query.pid && query.boardId === live.query.boardId
    && actual.pid === query.pid && actual.boardId === query.boardId
    && actual.dateRange[0] <= query.dateRange[0] && actual.dateRange[1] >= query.dateRange[1] ? received : null;
  return { query, result, dates: datesIn(query), state: source?.state };
}

const validNumber = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value >= 0;

function observation(live: LiveDashboardReading, source: ReturnType<typeof period>, id: string, date: string) {
  const supported = live.metricIds.includes(id);
  const matches = supported ? source.result?.data.series.filter(series => series.metric.id === id) ?? [] : [];
  const series = matches.length === 1 ? matches[0] : undefined;
  const matchesDate = series?.points.filter(point => point.date === date) ?? [];
  const raw = matchesDate.length === 1 ? matchesDate[0] : undefined;
  const ready = raw && (!raw.sourceStatus || raw.sourceStatus === "READY");
  const readable = ready && raw.state === "available" && validNumber(raw.value);
  const inputsReadable = ready && (readable || raw.state === "zero_denominator") || Boolean(series && diagnosticRatioInputs(series.metric, raw));
  const point = raw && series ? { ...raw, value: readable ? raw.value : null,
    inputs: series.metric.inputs.map(input => {
      const matches = raw.inputs.filter(candidate => candidate.key === input.key);
      return { key: input.key, value: inputsReadable && matches.length === 1 && validNumber(matches[0].value) ? matches[0].value : null };
    }) } : undefined;
  const freshness = source.state?.status === "success" && (source.state.refreshError || source.state.refreshing) ? " · 上次查询结果" : "";
  const state = !supported ? "切片待接入" : source.state?.status === "loading" ? "读取中" : source.state?.status === "failure" ? "读取失败"
    : matchesDate.length > 1 || matches.length > 1 ? "数据异常" : raw ? raw.state === "available" && ready && !readable ? "数据异常" : livePointStateLabel(raw, series?.metric) : "当日未返回";
  return { value: point?.value ?? null, state: state + freshness, point, series,
    basis: point && series ? liveCalculation(series, point) : undefined };
}

function summaryValue(id: string, readings: ReturnType<typeof observation>[], result: DailyDashboardSuccess | null, query: DailyDashboardQuery | undefined) {
  if (!readings.length || readings.some(reading => reading.value === null)) return null;
  if (id === "M081") {
    const inputs = readings.map(reading => reading.point?.inputs);
    if (inputs.some(input => !input || input.length !== 2 || input.some(item => !validNumber(item.value)))) return null;
    const numerator = inputs.reduce((sum, input) => sum + input![0].value!, 0);
    const denominator = inputs.reduce((sum, input) => sum + input![1].value!, 0);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : null;
  }
  const series = readings[0].series;
  if (!series || !result || !query) return null;
  if (readings.length === 1) return readings[0].value;
  const statistics = availablePeriodStatistics(series, result, query);
  const values = statistics?.values.filter(value => value.kind === (id === "M008" ? "period_sum" : "daily_average")) ?? [];
  return statistics?.dayCount === readings.length && values.length === 1 && validNumber(values[0].value) ? values[0].value : null;
}

/** One date-aligned projection serves the trend, calculation evidence and complete export. */
export function connectedStructureModel(live: LiveDashboardReading, id: string, dimension: string) {
  const groups = liveStructureIds(live, id, dimension) ?? [];
  const unit = id === "M081" ? "%" : "人";
  const current = period(live), previous = period(live, true);
  const readPeriod = (source: ReturnType<typeof period>) => ({ ...source,
    readings: new Map(groups.map(group => [group.id, source.dates.map(date => observation(live, source, group.id, date))])) });
  const now = readPeriod(current), before = readPeriod(previous);
  const snapshot = (source: typeof now, index: number) => ({
    values: Object.fromEntries(groups.map(group => [group.id, source.readings.get(group.id)?.[index]?.value ?? null])),
    states: Object.fromEntries(groups.map(group => [group.id, source.readings.get(group.id)?.[index]?.state ?? "当日未返回"])),
    basis: Object.fromEntries(groups.flatMap(group => {
      const basis = source.readings.get(group.id)?.[index]?.basis;
      return basis ? [[group.id, basis]] : [];
    }))
  });
  const points: GroupedTrendPoint[] = now.dates.map((date, index) => ({ date, ...snapshot(now, index),
    ...(before.dates[index] ? { comparison: { date: before.dates[index], ...snapshot(before, index) } } : {}) }));
  const summaries = groups.map(group => ({ ...group,
    value: summaryValue(id, now.readings.get(group.id) ?? [], now.result, now.query),
    summaryLabel: !live.metricIds.includes(group.id) ? "切片待接入" : unit === "%" ? "所选范围按基数加权" : id === "M008" ? "所选范围累计" : "所选范围日均"
  }));
  const workbook: WorkbookSheet[] = [{ name: "数据说明", rows: liveExportMetadata(live) }, { name: "分组明细", rows: [
    ["周期", "日期", "分组", `值（${unit}）`, "计算输入", "状态", "平台", "查询时间"],
    ...[{ label: "当前", source: now }, ...(live.comparison ? [{ label: "对比", source: before }] : [])].flatMap(({ label, source }) => groups.flatMap(group =>
      (source.readings.get(group.id) ?? []).map((reading, index) => [label, source.dates[index], group.label,
        reading.value === null ? null : reading.value * (unit === "%" ? 100 : 1),
        reading.series?.metric.inputs.map((input, i) => `${input.name}: ${reading.point?.inputs[i]?.value ?? "—"} ${input.unit}`).join(" / ") ?? "",
        `${reading.state} · 待验数`, live.query.pid, source.result?.data.fetchedAt ?? null])))
  ] }];
  return { groups, unit, points, summaries, workbook, hasCurrentResult: Boolean(now.result) };
}
