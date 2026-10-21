import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { liveResourceRetainsResult } from "../features/dashboards/LiveDashboardContext";
import { operatingDataEnvironment, operatingResource, type OperatingResources } from "./operating-live-model";
import type { OperatingQueryJobProgress } from "../../../contracts/operating-query-jobs";

/** Counts settled platform requests, independently of any metric's dataStatus. */
export interface OperatingReadProgress {
  scopeKey: string;
  total: number;
  completed: number;
  jobs?: Record<string, { progress?: OperatingQueryJobProgress; settled: boolean }>;
}

export function completeOperatingPlatformQuery(progress: OperatingReadProgress | null, scopeKey: string): OperatingReadProgress | null {
  return progress?.scopeKey === scopeKey && progress.completed < progress.total
    ? { ...progress, completed: progress.completed + 1 }
    : progress;
}

export interface OperatingReadNotice {
  progress: { completed: number; total: number; query?: { known: boolean; queued: number; projecting: number; attempts: number } } | null;
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
  const inProgress = progress?.scopeKey === scopeKey && progress.total > 0 && progress.completed < progress.total;
  const jobs = inProgress && progress.jobs ? Object.values(progress.jobs) : null;
  const settled = !inProgress ? null : jobs ? {
    completed: jobs.reduce((sum, job) => sum + (job.progress?.completedUnits ?? 0), 0),
    total: jobs.reduce((sum, job) => sum + (job.progress?.totalUnits ?? 0), 0),
    query: { known: jobs.every(job => job.progress?.totalUnits !== undefined && job.progress.completedUnits !== undefined),
      queued: jobs.filter(job => !job.settled && job.progress?.status === "QUEUED").length,
      projecting: jobs.filter(job => !job.settled && job.progress?.phase === "projection").length,
      attempts: Math.max(0, ...jobs.map(job => job.progress?.attempts ?? 0)) }
  } : { completed: progress.completed, total: progress.total };
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
