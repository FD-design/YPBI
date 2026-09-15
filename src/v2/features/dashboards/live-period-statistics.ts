import type { DailyDashboardQuery, DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";
import type { DashboardMetricReading } from "./dashboard-metric-card-model";

type Series = DailyDashboardSuccess["data"]["series"][number];
export const periodStatisticLabel = (kind: "period_sum" | "daily_average") => kind === "period_sum" ? "合计" : "均值";

/** Period values belong to one exact query; never derive or borrow them from daily points. */
export function availablePeriodStatistics(series: Series, result: DailyDashboardSuccess, query = result.data.query) {
  const actual = result.data.query;
  if (actual.pid !== query.pid || actual.boardId !== query.boardId || actual.dateRange.some((date, i) => date !== query.dateRange[i])) return null;
  if (!("periodStatistics" in series)) return null;
  const statistics = series.periodStatistics;
  return statistics.state === "available" && statistics.dateRange.every((date, i) => date === query.dateRange[i]) ? statistics : null;
}

export function livePeriodReadingStatistics(series: Series, result: DailyDashboardSuccess, query: DailyDashboardQuery, freshness = ""): DashboardMetricReading["statistics"] {
  const statistics = availablePeriodStatistics(series, result, query);
  if (!statistics || statistics.dayCount < 2) return [];
  return statistics.values.map(statistic => ({
    label: periodStatisticLabel(statistic.kind),
    display: statistic.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }),
    unit: series.metric.unit,
    detail: `${query.dateRange.join(" 至 ")} · ${statistics.dayCount} 个业务日；服务端按已返回日值${statistic.kind === "period_sum" ? "累计" : "计算日均"}。${series.metric.unit === "人" && statistic.kind === "daily_average" ? "日均人数不是区间去重人数。" : ""}待验数，完整性未知。${freshness}`
  }));
}
