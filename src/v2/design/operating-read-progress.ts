import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { liveResourceRetainsResult } from "../features/dashboards/LiveDashboardContext";
import { operatingDataEnvironment, operatingResource, type OperatingResources } from "./operating-live-model";

/** Counts settled platform requests, independently of any metric's dataStatus. */
export interface OperatingReadProgress {
  scopeKey: string;
  total: number;
  completed: number;
}

export function completeOperatingPlatformQuery(progress: OperatingReadProgress | null, scopeKey: string): OperatingReadProgress | null {
  return progress?.scopeKey === scopeKey && progress.completed < progress.total
    ? { ...progress, completed: progress.completed + 1 }
    : progress;
}

export interface OperatingReadNotice {
  progress: { completed: number; total: number } | null;
  retained: { count: number; firstReadAt: string | null; lastReadAt: string | null; unknownTimes: number } | null;
}

export function operatingReadNotice(
  live: LiveDashboardReading | null,
  resources: OperatingResources,
  progress: OperatingReadProgress | null,
  scopeKey: string,
  selectedPlatform = "all"
): OperatingReadNotice {
  if (!live) return { progress: null, retained: null };
  const settled = progress?.scopeKey === scopeKey && progress.total > 0 && progress.completed < progress.total
    ? { completed: progress.completed, total: progress.total } : null;
  const retained = (live.platforms ?? [{ pid: live.query.pid }]).flatMap(platform => {
    if (selectedPlatform !== "all" && platform.pid !== selectedPlatform) return [];
    const resource = operatingResource(resources[platform.pid], platform.pid, live.query.dateRange[1], operatingDataEnvironment(live));
    return resource?.status === "success" && liveResourceRetainsResult(resource) ? [resource.data.data.fetchedAt] : [];
  });
  const dated = retained.filter(time => Number.isFinite(Date.parse(time))).sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    progress: settled,
    retained: retained.length ? {
      count: retained.length, firstReadAt: dated[0] ?? null, lastReadAt: dated.at(-1) ?? null,
      unknownTimes: retained.length - dated.length
    } : null
  };
}
