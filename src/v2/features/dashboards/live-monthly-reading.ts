import type { DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";
import { monthlyQueryScopes, type MonthlyQueryScope } from "../../../../contracts/monthly-query-scope";

type Series = DailyDashboardSuccess["data"]["series"][number];
export const isMonthlyMetric = (id: string) => id === "M018";

/** Query execution time determines the adapter's bounds; it is not an upstream watermark. */
export function liveMonthlySeriesRows(series: Series, result: DailyDashboardSuccess) {
  if (!isMonthlyMetric(series.metric.id)) return [];
  const timestamp = Date.parse(result.data.fetchedAt);
  if (!Number.isFinite(timestamp)) return [];
  const today = new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return monthlyQueryScopes(...result.data.query.dateRange, today).flatMap(scope => {
    const point = series.points.find(point => point.date === scope.anchor);
    return point ? [{ scope, point, label: monthlyScopeLabel(scope) }] : [];
  });
}

export function monthlyScopeLabel(scope: MonthlyQueryScope) {
  return scope.queryStart && scope.queryEnd
    ? `${scope.month} 自然月 · ${scope.queryStart} 至 ${scope.queryEnd}`
    : `${scope.month} 自然月 · 尚无已结束业务日`;
}

export function monthlyComparisonReason(current: MonthlyQueryScope, previous?: MonthlyQueryScope): string | null {
  if (!previous) return "未返回独立的上一自然月可比结果。";
  if (!current.queryEnd || !previous.queryEnd) return "当前月或对比月尚无已结束业务日。";
  const priorMonth = new Date(`${current.monthStart}T00:00:00Z`);
  priorMonth.setUTCMonth(priorMonth.getUTCMonth() - 1);
  if (previous.month !== priorMonth.toISOString().slice(0, 7)) return "对比结果不是独立的上一自然月，不能作为月度基准。";
  const complete = current.queryEnd === current.monthEnd;
  if (complete ? previous.queryEnd !== previous.monthEnd : previous.queryEnd.slice(8) !== current.queryEnd.slice(8)) {
    return complete ? "完整自然月需要上一完整自然月结果。" : "当前月查询尚未覆盖整月，未返回上月相同自然日进度的独立结果。";
  }
  return null;
}
