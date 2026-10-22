import { useEffect, useRef } from "react";
import type { DailyDashboardQuery } from "../../../../contracts/daily-dashboard";
import { fetchDailyDashboard } from "../../api/client";
import { useV2Resource, type V2ResourceState } from "../../api/useV2Resource";
import { previousDailyQuery, supplementaryDailyQuery } from "./daily-reference-plan";

/** Hide the previous scope during the render before its effect starts the next request. */
export function useDailyBoardResource<T>(requestKey: string, load: (signal: AbortSignal) => Promise<T>) {
  const activeKey = useRef(requestKey);
  const resource = useV2Resource(requestKey, load);
  useEffect(() => { activeKey.current = requestKey; }, [requestKey]);
  const state: V2ResourceState<T> = activeKey.current === requestKey ? resource.state : { status: "loading" };
  return { ...resource, state };
}

export function useDailyBoardResources(query: DailyDashboardQuery, metricIds: readonly string[], compared: boolean) {
  const previousQuery = previousDailyQuery(query);
  const referenceQuery = supplementaryDailyQuery(query, compared);
  const current = useDailyBoardResource(JSON.stringify(query), async signal => metricIds.length ? fetchDailyDashboard(query, metricIds, signal) : null);
  const previous = useDailyBoardResource(JSON.stringify([previousQuery, compared]), async signal => compared && metricIds.length ? fetchDailyDashboard(previousQuery, metricIds, signal) : null);
  const reference = useDailyBoardResource(JSON.stringify(["day-references", referenceQuery]), async signal => referenceQuery && metricIds.length ? fetchDailyDashboard(referenceQuery, metricIds, signal) : null);
  return { current, previous, reference, previousQuery, referenceQuery };
}
