import { useEffect, useMemo, useState } from "react";
import { OPERATING_METRIC_IDS } from "../../../contracts/operating-detail-projection";
import { fetchDailyDashboard, V2RequestError } from "../api/client";
import { shiftDate } from "../../components/ui/date-range-model";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { operatingLiveRows, operatingLiveColumns, operatingLiveColumnMetadataKey, operatingResource, operatingDataEnvironment, type OperatingResources } from "./operating-live-model";
import { completeOperatingPlatformQuery, operatingReadNotice, type OperatingReadProgress } from "./operating-read-progress";

const MAX_OPERATING_REQUESTS = 6;

/** Independent per-PID snapshots; failed or missing results never become fixtures. */
export function useOperatingLive(live: LiveDashboardReading | null, platform = "all") {
  const [resources, setResources] = useState<OperatingResources>({});
  const [progress, setProgress] = useState<OperatingReadProgress | null>(null);
  const platforms = live?.platforms ?? [], date = live?.query.dateRange[1] ?? "";
  const environment = live ? operatingDataEnvironment(live) : undefined;
  // The route's dataScopeKey remounts on environment changes; provenance arrival is not a new query.
  const key = JSON.stringify([Boolean(live), date, platforms.map(platform => platform.pid)]);
  const revision = live?.refreshRevision ?? 0;
  const progressScopeKey = JSON.stringify([key, revision]);
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    setProgress({ scopeKey: progressScopeKey, total: platforms.length, completed: 0 });
    setResources(current => Object.fromEntries(platforms.map(platform => {
      const prior = operatingResource(current[platform.pid], platform.pid, date, environment);
      return [platform.pid, prior?.status === "success" ? { ...prior, refreshing:true } : {status:"loading"}];
    })));
    let next = 0;
    const worker = async () => {
      while (next < platforms.length && !controller.signal.aborted) {
        const platform = platforms[next++];
        try {
          const data = await fetchDailyDashboard({ boardId: "5.2", pid: platform.pid, dateRange: [shiftDate(date, -7), date], projection: "operating_snapshot" }, OPERATING_METRIC_IDS, controller.signal);
          if (!controller.signal.aborted) setResources(current => ({ ...current, [platform.pid]: { status: "success", data, refreshing: false, refreshError: null } }));
        } catch (error) {
          if (controller.signal.aborted) return;
          const failure = error instanceof V2RequestError ? error : new V2RequestError("经营明细读取失败", { kind: "error", code: "OPERATING_READ_FAILED", status: 0 });
          setResources(current => {
            const prior = operatingResource(current[platform.pid], platform.pid, date, environment);
            return { ...current, [platform.pid]: prior?.status === "success" && failure.kind === "error"
              ? { ...prior, refreshing: false, refreshError: { message: failure.message, code: failure.code, requestId: failure.requestId } }
              : { status: "failure", kind: failure.kind, code: failure.code, message: failure.message, requestId: failure.requestId } };
          });
        } finally {
          if (!controller.signal.aborted) setProgress(current => completeOperatingPlatformQuery(current, progressScopeKey));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(MAX_OPERATING_REQUESTS, platforms.length) }, worker));
    return () => controller.abort();
  }, [key, revision]);
  const columnMetadataKey = useMemo(() => operatingLiveColumnMetadataKey(live, resources, platform), [live, resources, platform]);
  const columns = useMemo(() => operatingLiveColumns(live, resources, platform), [live, columnMetadataKey]);
  const rows = useMemo(() => live ? operatingLiveRows(live, resources, platform) : null, [live, resources, platform]);
  const notice = useMemo(() => operatingReadNotice(live, resources, progress, progressScopeKey, platform), [live, resources, progress, progressScopeKey, platform]);
  return { resources, columns, rows, notice };
}
