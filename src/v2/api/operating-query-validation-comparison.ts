import { dailyDashboardMatchesQuery, dailyDashboardSuccessSchema, type DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { OPERATING_LIVE_IDS, OPERATING_METRIC_IDS, operatingSnapshotDates } from "../../../contracts/operating-detail-projection";

export interface OperatingValidationComparison {
  totalCells: number;
  matchedCells: number;
  notApplicableCells: number;
  readyCells: number;
  nonReadyCells: number;
  differences: Array<{ pid: string; columnKey: string; metricId: string; date: string; fields: string[] }>;
  scopeErrors: string[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

/** Compare the existing projections without recalculating any metric or treating null as zero. */
export function compareOperatingValidation(
  asyncDashboards: readonly DailyDashboardSuccess[], syncDashboards: readonly DailyDashboardSuccess[],
  expected: { pids: readonly string[]; date: string }
): OperatingValidationComparison {
  const result: OperatingValidationComparison = { totalCells: 0, matchedCells: 0, notApplicableCells: 0,
    readyCells: 0, nonReadyCells: 0, differences: [], scopeErrors: [] };
  const index = (items: readonly DailyDashboardSuccess[], label: string) => {
    const map = new Map<string, DailyDashboardSuccess>();
    for (const item of items) {
      const parsed = dailyDashboardSuccessSchema.safeParse(item);
      if (!parsed.success || !dailyDashboardMatchesQuery(parsed.data, parsed.data.data.query, OPERATING_METRIC_IDS)
        || parsed.data.data.query.projection !== "operating_snapshot") {
        result.scopeErrors.push(`${label}:INVALID_SNAPSHOT`); continue;
      }
      const pid = parsed.data.data.query.pid;
      if (map.has(pid)) result.scopeErrors.push(`${label}:DUPLICATE_PID:${pid}`);
      else map.set(pid, parsed.data);
    }
    return map;
  };
  const candidate = index(asyncDashboards, "async"), baseline = index(syncDashboards, "sync");
  if (!expected.pids.length || new Set(expected.pids).size !== expected.pids.length) result.scopeErrors.push("INVALID_EXPECTED_SCOPE");
  for (const [label, map] of [["async", candidate], ["sync", baseline]] as const) {
    for (const pid of expected.pids) if (!map.has(pid)) result.scopeErrors.push(`${label}:MISSING_EXPECTED_PID:${pid}`);
    for (const [pid, item] of map) {
      if (!expected.pids.includes(pid)) result.scopeErrors.push(`${label}:UNEXPECTED_PID:${pid}`);
      if (item.data.query.dateRange[1] !== expected.date) result.scopeErrors.push(`${label}:UNEXPECTED_DATE:${pid}`);
    }
  }
  if (!candidate.size || !baseline.size) result.scopeErrors.push("EMPTY_SCOPE");
  const scopes = new Set([...candidate.keys(), ...baseline.keys()]);
  const dates = new Set<string>();
  for (const pid of scopes) {
    const left = candidate.get(pid), right = baseline.get(pid);
    if (!left || !right) { result.scopeErrors.push(`MISSING_PID:${pid}`); continue; }
    if (canonical(left.data.query) !== canonical(right.data.query)) { result.scopeErrors.push(`QUERY_MISMATCH:${pid}`); continue; }
    dates.add(left.data.query.dateRange[1]);
    const metadata = ["schemaVersion", "timezone", "validationStatus", "completeness", "watermark", "sourceApiIds"] as const;
    const metadataFields = metadata.filter(key => canonical(left.data[key]) !== canonical(right.data[key]));
    const observedDates = operatingSnapshotDates(left.data.query.dateRange);
    for (const [columnKey, metricId] of Object.entries(OPERATING_LIVE_IDS)) {
      const a = left.data.series.find(series => series.metric.id === metricId)!;
      const b = right.data.series.find(series => series.metric.id === metricId)!;
      for (const date of observedDates) {
        if (metricId === "M018" && date !== left.data.query.dateRange[1]) { result.notApplicableCells++; continue; }
        result.totalCells++;
        const ap = a.points.find(point => point.date === date)!, bp = b.points.find(point => point.date === date)!;
        const fields: string[] = metadataFields.map(field => `dashboard.${field}`);
        if (canonical(a.metric) !== canonical(b.metric)) fields.push("metric");
        for (const key of ["state", "sourceStatus", "value", "inputs", "monthlyMetadata"] as const) {
          if (canonical(ap[key]) !== canonical(bp[key])) fields.push(key);
        }
        if (ap.state === "available" && (!ap.sourceStatus || ap.sourceStatus === "READY")) result.readyCells++;
        else result.nonReadyCells++;
        if (fields.length) result.differences.push({ pid, columnKey, metricId, date, fields });
        else result.matchedCells++;
      }
    }
  }
  if (dates.size > 1) result.scopeErrors.push("MIXED_BUSINESS_DATES");
  return result;
}
