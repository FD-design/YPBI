import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CoreOverviewQueryInput } from "../../../../contracts/core-overview";
import { queryCoreOverview } from "../../api/client";
import type { CoreOverviewCardLocator } from "./core-overview-page-model";
import { CoreOverviewQueryController, coreOverviewQueryKey } from "./core-overview-query-controller";

export function useCoreOverviewQuery(request: CoreOverviewQueryInput) {
  const [controller] = useState(() => new CoreOverviewQueryController(queryCoreOverview));
  const requestKey = coreOverviewQueryKey(request);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useEffect(() => {
    void controller.load(request);
  }, [controller, requestKey]);

  useEffect(() => () => controller.cancelPending(), [controller]);

  const refresh = useCallback(() => controller.refresh(), [controller]);
  const retryCard = useCallback((locator: CoreOverviewCardLocator) => controller.retryCard(locator), [controller]);
  return { state, refresh, retryCard };
}
