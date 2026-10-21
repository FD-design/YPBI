import { z } from "zod";
import { dailyDashboardQuerySchema } from "../../contracts/daily-dashboard";
import { biQueryJobRequestSchema, biQueryJobUnitResultSchema, type BiQueryJobRequest } from "../../contracts/query-jobs";
import { monthlyQueryScopes, type MonthlyQueryScope } from "../../contracts/monthly-query-scope";
import { aggregateBiV1MetricDays, normalizeBiV1MetricUnit, type BiV1MetricQuery } from "../upstream/bi-v1.metrics-adapter";
import { aggregateBiV1Playback, normalizeBiV1PlaybackUnit } from "../upstream/bi-v1.adapter";
import { projectBiV1MonthlyMetricScope } from "../upstream/bi-v1.monthly-adapter";
import { toBeijingDate } from "../upstream/date";
import { UpstreamError } from "../upstream/client";
import { dailyDashboardMetricQueries, type OperatingModernSources } from "./daily-dashboard.service";

type OperatingQueryUnit =
  | { kind: "metrics"; scope: BiV1MetricQuery }
  | { kind: "playback"; scope: Pick<BiV1MetricQuery, "pid" | "startDate" | "endDate"> }
  | { kind: "monthly"; scope: BiV1MetricQuery; month: MonthlyQueryScope };

export interface OperatingQueryPlan {
  request: BiQueryJobRequest;
  pids: string[];
  dateRange: [string, string];
  today: string;
  units: OperatingQueryUnit[];
  months: MonthlyQueryScope[];
}

const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const invalidScope = () => new UpstreamError("BI_V1_SCOPE_CONFLICT", "经营异步结果与服务端查询计划不一致", 502);

/** The caller supplies one already-authorized site group. Routing remains in the job service. */
export function createOperatingQueryPlan(pids: readonly string[], dateRange: [string, string], today = toBeijingDate(new Date())): OperatingQueryPlan {
  if (!pids.length || pids.length > 20 || new Set(pids).size !== pids.length || !z.iso.date().safeParse(today).success
    || pids.some(pid => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(pid)
      || !dailyDashboardQuerySchema.safeParse({ boardId: "5.2", pid, dateRange, projection: "operating_snapshot" }).success)) {
    throw new UpstreamError("INVALID_DAILY_READING_QUERY", "经营快照查询参数不合法", 400);
  }
  const pid = pids.join(",");
  const query = { boardId: "5.2", pid: pids[0], dateRange, projection: "operating_snapshot" as const };
  const units: OperatingQueryUnit[] = dailyDashboardMetricQueries(query).map(scope => ({ kind: "metrics", scope: { ...scope, pid } }));
  units.push({ kind: "playback", scope: { pid, startDate: dateRange[0], endDate: dateRange[1] } });
  const months = monthlyQueryScopes(dateRange[0], dateRange[1], today);
  for (const month of months) {
    if (!month.queryStart || !month.queryEnd) continue;
    units.push({ kind: "monthly", month, scope: { pid, startDate: month.queryStart, endDate: month.queryEnd,
      metricCodes: ["M018"], granularity: "summary", dimensions: [] } });
  }
  const request = biQueryJobRequestSchema.parse({ queries: units.map(unit => ({ query: {
    pid, startDate: unit.scope.startDate, endDate: shiftDay(unit.scope.endDate, 1),
    metricCodes: unit.kind === "playback" ? "M034,M036,M097" : unit.scope.metricCodes.join(","),
    granularity: unit.kind === "monthly" ? "summary" : "day", includeIncomplete: true,
    ...(unit.kind === "playback" ? { dimensions: "videoType" } : {
      ...(unit.scope.dimensions?.length ? { dimensions: unit.scope.dimensions.join(",") } : {}),
      ...(unit.scope.dimensionFilters ? { dimensionFilters: JSON.stringify(unit.scope.dimensionFilters) } : {})
    })
  } })) });
  return { request, pids: [...pids], dateRange: [...dateRange], today, units, months };
}

/** Decode only trusted server-fetched units, then share the synchronous business projections. */
export function normalizeOperatingQueryResults(plan: OperatingQueryPlan, results: readonly unknown[]): Map<string, OperatingModernSources> {
  if (results.length !== plan.units.length) throw invalidScope();
  const dates = Array.from({ length: 8 }, (_, index) => shiftDay(plan.dateRange[0], index));
  const sources = new Map<string, OperatingModernSources>(plan.pids.map(pid => [pid, {
    pid, dateRange: [...plan.dateRange], metricDays: [], playbackDays: [], monthlyDays: dates.map(date => ({ date, metrics: {} }))
  }]));
  for (const source of sources.values()) for (const month of plan.months) {
    if (!month.queryStart || !month.queryEnd) source.monthlyDays.find(day => day.date === month.anchor)!.metrics.M018 = {
      state: "no_value", dataStatus: null, value: null, numerator: null, denominator: null, unit: null
    };
  }
  for (const [index, raw] of results.entries()) {
    const parsed = biQueryJobUnitResultSchema.safeParse(raw);
    if (!parsed.success) throw new UpstreamError("BI_V1_RESPONSE_INVALID", "经营异步单元结构无法识别", 502);
    const unit = parsed.data, descriptor = plan.units[index];
    // Validate the complete multi-PID unit before slicing; foreign rows cannot disappear in filtering.
    for (const row of unit.rows) {
      if (typeof row.dimensions.pid !== "string" || !sources.has(row.dimensions.pid)
        || row.pid !== undefined && row.pid !== row.dimensions.pid) throw invalidScope();
    }
    if (unit.sourceCoverage?.some(item => !sources.has(item.pid))) throw invalidScope();
    for (const [pid, source] of sources) {
      const selected = { ...unit, rows: unit.rows.filter(row => row.dimensions.pid === pid),
        ...(unit.sourceCoverage ? { sourceCoverage: unit.sourceCoverage.filter(item => item.pid === pid) } : {}) };
      const scope = { ...descriptor.scope, pid };
      if (descriptor.kind === "playback") {
        source.playbackDays = aggregateBiV1Playback(normalizeBiV1PlaybackUnit(selected, scope), scope);
      } else {
        const metricScope = scope as BiV1MetricQuery;
        const message = normalizeBiV1MetricUnit(selected, metricScope);
        if (descriptor.kind === "monthly") {
          Object.assign(source.monthlyDays.find(day => day.date === descriptor.month.anchor)!, projectBiV1MonthlyMetricScope(message, descriptor.month, plan.today));
        } else {
          const byDate = new Map(source.metricDays.map(day => [day.date, day]));
          for (const day of aggregateBiV1MetricDays(message, metricScope)) {
            const existing = byDate.get(day.date);
            if (existing) Object.assign(existing.metrics, day.metrics);
            else { source.metricDays.push(day); byDate.set(day.date, day); }
          }
        }
      }
    }
  }
  return sources;
}
