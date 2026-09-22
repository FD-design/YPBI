import { useEffect, useMemo, useState } from "react";
import { fetchDailyDashboard, V2RequestError } from "../api/client";
import { shiftDate } from "../../components/ui/date-range-model";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { operatingLiveRows, operatingLiveColumns, operatingResource, type OperatingResources } from "./operating-live-model";

/** Independent per-PID snapshots; failed or missing results never become fixtures. */
export function useOperatingLive(live: LiveDashboardReading | null) {
  const [resources, setResources] = useState<OperatingResources>({});
  const platforms = live?.platforms ?? [], date = live?.query.dateRange[1] ?? "";
  const key = JSON.stringify([date, platforms, live?.metricIds]);
  const revision = live?.state.status === "success" ? live.state.data.data.queryId : live?.state.status;
  useEffect(() => {
    if (!live || live.state.status === "loading") return;
    const controller = new AbortController();
    setResources(current => Object.fromEntries(platforms.map(platform => {
      const prior = operatingResource(current[platform.pid], platform.pid, date);
      return [platform.pid, prior?.status === "success" ? { ...prior, refreshing:true } : {status:"loading"}];
    })));
    let next = 0;
    const worker = async () => {
      while (next < platforms.length && !controller.signal.aborted) {
        const platform = platforms[next++];
        try {
          const data = await fetchDailyDashboard({ boardId: "5.2", pid: platform.pid, dateRange: [shiftDate(date, -7), date] }, live.metricIds, controller.signal);
          if (!controller.signal.aborted) setResources(current => ({ ...current, [platform.pid]: { status: "success", data, refreshing: false, refreshError: null } }));
        } catch (error) {
          if (controller.signal.aborted) return;
          const failure = error instanceof V2RequestError ? error : new V2RequestError("经营明细读取失败", { kind: "error", code: "OPERATING_READ_FAILED", status: 0 });
          setResources(current => {
            const prior = operatingResource(current[platform.pid], platform.pid, date);
            return { ...current, [platform.pid]: prior?.status === "success" && failure.kind === "error"
              ? { ...prior, refreshing: false, refreshError: { message: failure.message, code: failure.code } }
              : { status: "failure", kind: failure.kind, code: failure.code, message: failure.message } };
          });
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, platforms.length) }, worker));
    return () => controller.abort();
  }, [key, revision]);
  return { resources, columns: useMemo(() => operatingLiveColumns(live), [key]), rows: live ? operatingLiveRows(live, resources) : null };
}
