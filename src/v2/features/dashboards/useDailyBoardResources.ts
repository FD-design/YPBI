import type { DailyDashboardQuery } from "../../../../contracts/daily-dashboard";
import { fetchDailyDashboard } from "../../api/client";
import { useV2Resource } from "../../api/useV2Resource";
import { previousDailyQuery, supplementaryDailyQuery } from "./daily-reference-plan";

export function useDailyBoardResources(query: DailyDashboardQuery, metricIds: readonly string[], compared: boolean) {
  const previousQuery = previousDailyQuery(query);
  const referenceQuery = supplementaryDailyQuery(query, compared);
  const current = useV2Resource(JSON.stringify(query), async signal => metricIds.length ? fetchDailyDashboard(query, metricIds, signal) : null);
  const previous = useV2Resource(JSON.stringify([previousQuery, compared]), async signal =>
    compared && metricIds.length ? fetchDailyDashboard(previousQuery, metricIds, signal, "supplementary") : null);
  const reference = useV2Resource(JSON.stringify(["day-references", referenceQuery]), async signal =>
    referenceQuery && metricIds.length ? fetchDailyDashboard(referenceQuery, metricIds, signal, "supplementary") : null);
  return { current, previous, reference, previousQuery, referenceQuery };
}
