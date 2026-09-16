import type { DailyDashboardQuery } from "../../../../contracts/daily-dashboard";
import { shiftDate } from "../../../components/ui/date-range-model";
import { dailyReferenceDates } from "./daily-reading-model";

export function previousDailyQuery(query: DailyDashboardQuery): DailyDashboardQuery {
  const days = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
  return { ...query, dateRange: [shiftDate(query.dateRange[0], -days), shiftDate(query.dateRange[0], -1)] };
}

/** Reuse visible/interval-comparison dates; only a missing reference day needs another read. */
export function supplementaryDailyQuery(query: DailyDashboardQuery, compared: boolean): DailyDashboardQuery | null {
  if (!compared) return null;
  const before = previousDailyQuery(query);
  const missing = dailyReferenceDates(query.dateRange[1]).filter(date => ![query, before].some(period => date >= period.dateRange[0] && date <= period.dateRange[1]));
  if (!missing.length) return null;
  return { ...query, dateRange: [missing[0], missing.at(-1)!] };
}
