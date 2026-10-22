import { createContext, useContext, type ReactNode } from "react";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { useOperatingLive, useOperatingResources, type OperatingRequestScope } from "./useOperatingLive";

const OperatingResourcesContext = createContext<ReturnType<typeof useOperatingResources> | undefined>(undefined);

export function OperatingLiveResources({ live, children }: { live: OperatingRequestScope | null; children: ReactNode }) {
  const resources = useOperatingResources(live);
  return <OperatingResourcesContext.Provider value={resources}>{children}</OperatingResourcesContext.Provider>;
}

export function useSharedOperatingLive(live: LiveDashboardReading | null, platform = "all") {
  return useOperatingLive(live, platform, useContext(OperatingResourcesContext));
}
