import type { z } from "zod";
import { operatingQueryJobRequestSchema, operatingQueryJobCreatedSchema, operatingQueryJobStatusSchema, operatingQueryJobResultSchema,
  type OperatingQueryJobRequest, type OperatingQueryJobProgress } from "../../../contracts/operating-query-jobs";
import { dailyDashboardMatchesQuery, type DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS } from "../../../contracts/operating-detail-projection";
import { shiftDate } from "../../components/ui/date-range-model";
import { createQueryJobProtocolRunner, invalidQueryJobScope, type BiQueryJobRuntime } from "./query-jobs";
import { currentDataEnvironmentPreference } from "./dataEnvironmentPreference";
import { recordDailyDashboardEnvironment } from "./daily-dashboard-environment";

function matches(value: { pids: string[]; date: string }, request: OperatingQueryJobRequest) {
  return value.date === request.date && value.pids.length === request.pids.length
    && value.pids.every((pid, index) => pid === request.pids[index]);
}

/** The server owns the plan; the browser verifies scope and reuses the original 93-column result. */
export function createOperatingQueryJobRunner(runtime: BiQueryJobRuntime = {}) {
  return (request: OperatingQueryJobRequest, options: { signal?: AbortSignal; onProgress?: (progress: Readonly<OperatingQueryJobProgress>) => void } = {}) => {
    const environment = currentDataEnvironmentPreference();
    const run = createQueryJobProtocolRunner<OperatingQueryJobRequest, OperatingQueryJobProgress,
      z.infer<typeof operatingQueryJobCreatedSchema>, z.infer<typeof operatingQueryJobResultSchema>, DailyDashboardSuccess[]>({
      requestSchema: operatingQueryJobRequestSchema, createdSchema: operatingQueryJobCreatedSchema,
      statusSchema: operatingQueryJobStatusSchema, resultSchema: operatingQueryJobResultSchema,
      isCurrentScope: () => currentDataEnvironmentPreference() === environment,
      validateCreated: (value, request) => matches(value.data, request),
      validateProgress: (value, request) => matches(value, request)
        && (value.completedUnits === undefined || value.totalUnits === undefined || value.completedUnits <= value.totalUnits)
        && (value.phase !== "complete" || value.status === "SUCCEEDED")
        && (value.status !== "SUCCEEDED" || value.completedUnits === undefined || value.totalUnits === undefined || value.completedUnits === value.totalUnits),
      progressSnapshot: value => operatingQueryJobStatusSchema.parse({ success: true, data: Object.fromEntries(
        ["kind", "handle", "pids", "date", "phase", "status", "completedUnits", "totalUnits", "attempts", "createdAtMs", "startedAtMs", "finishedAtMs", "expiresAtMs", "errorCode"]
          .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key as keyof OperatingQueryJobProgress]])
      ) }).data,
      finish: (result, request) => {
        if (result.data.phase !== "complete") return null;
        const dashboards = result.data.dashboards;
        if (!dashboards || dashboards.length !== request.pids.length) return invalidQueryJobScope();
        return dashboards.map((dashboard, index) => {
          if (!dailyDashboardMatchesQuery(dashboard, { boardId: "5.2", pid: request.pids[index],
            dateRange: [shiftDate(request.date, -7), request.date], projection: "operating_snapshot" }, OPERATING_METRIC_IDS)) return invalidQueryJobScope();
          return recordDailyDashboardEnvironment(dashboard, environment);
        });
      }
    }, runtime);
    return run(request, options);
  };
}

export const runOperatingQueryJob = createOperatingQueryJobRunner();
