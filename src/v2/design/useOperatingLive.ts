import { useEffect, useMemo, useRef, useState } from "react";
import { OPERATING_METRIC_IDS } from "../../../contracts/operating-detail-projection";
import { fetchDailyDashboard, V2RequestError, readV2RequestDiagnostics } from "../api/client";
import { shiftDate } from "../../components/ui/date-range-model";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { operatingLiveRows, operatingLiveColumns, operatingLiveColumnMetadataKey, operatingResource, type OperatingResources } from "./operating-live-model";
import { completeOperatingPlatformQuery, operatingReadNotice, type OperatingReadProgress } from "./operating-read-progress";
import { runOperatingQueryJob } from "../api/operating-query-jobs";
import { currentDataEnvironmentPreference } from "../api/dataEnvironmentPreference";
import { BiQueryJobTerminalError, BiQueryJobWaitError } from "../api/query-jobs";

const MAX_OPERATING_REQUESTS = 1;

export type OperatingRequestScope = Pick<LiveDashboardReading, "query" | "state" | "dataEnvironment" | "platforms" | "operatingAsyncPidGroups" | "refreshRevision">;

/** Independent per-PID snapshots; failed or missing results never become fixtures. */
export function useOperatingResources(live: OperatingRequestScope | null) {
  const [resources, setResources] = useState<OperatingResources>({});
  const [progress, setProgress] = useState<OperatingReadProgress | null>(null);
  const platforms = live?.platforms ?? [], date = live?.query.dateRange[1] ?? "";
  const environment = currentDataEnvironmentPreference();
  const asyncGroups = live?.operatingAsyncPidGroups;
  // Request intent invalidates the scope immediately; provenance arrival is not a new query.
  const key = JSON.stringify([Boolean(live), environment, date, platforms.map(platform => platform.pid), asyncGroups]);
  const activeKey = useRef(key);
  const revision = live?.refreshRevision ?? 0;
  const progressScopeKey = JSON.stringify([key, revision]);
  useEffect(() => {
    activeKey.current = key;
    if (!live) {
      setResources(current => Object.keys(current).length ? {} : current);
      setProgress(null);
      return;
    }
    const controller = new AbortController();
    setProgress({ scopeKey: progressScopeKey, total: platforms.length, completed: 0,
      ...(asyncGroups ? { jobs: Object.fromEntries(asyncGroups.map((_, index) => [String(index), { settled: false }])) } : {}) });
    setResources(current => Object.fromEntries(platforms.map(platform => {
      const prior = operatingResource(current[platform.pid], platform.pid, date, environment);
      return [platform.pid, prior?.status === "success" ? { ...prior, refreshing:true } : {status:"loading"}];
    })));
    const fail = (pid: string, error: unknown) => {
      if (controller.signal.aborted) return;
      const failure = error instanceof V2RequestError ? error : error instanceof BiQueryJobTerminalError || error instanceof BiQueryJobWaitError
        ? new V2RequestError(error.message, { ...readV2RequestDiagnostics(error), kind: "error", code: error.code, status: 0 })
        : new V2RequestError("经营明细读取失败", { kind: "error", code: "OPERATING_READ_FAILED", status: 0 });
      setResources(current => {
        const prior = operatingResource(current[pid], pid, date, environment);
        return { ...current, [pid]: prior?.status === "success" && failure.kind === "error"
          ? { ...prior, refreshing: false, refreshError: { message: failure.message, ...readV2RequestDiagnostics(failure), code: failure.code } }
          : { status: "failure", kind: failure.kind, message: failure.message, ...readV2RequestDiagnostics(failure), code: failure.code } };
      });
    };
    if (asyncGroups) {
      const pids = asyncGroups.flat(), expected = platforms.map(item => item.pid);
      const valid = asyncGroups.every(group => group.length > 0 && group.length <= 20)
        && pids.length === expected.length && new Set(pids).size === pids.length && pids.every(pid => expected.includes(pid));
      if (!valid) {
        const failure = new V2RequestError("经营查询分组与授权平台不一致", { kind: "error", code: "INVALID_V2_QUERY_RESPONSE", status: 200 });
        expected.forEach(pid => fail(pid, failure));
        setProgress(null);
        return () => controller.abort();
      }
      // Each authorized site owns one task. A failed task never silently switches to synchronous reads.
      void Promise.all(asyncGroups.map(async (group, index) => {
        const groupKey = String(index);
        try {
          const dashboards = await runOperatingQueryJob({ kind: "operating-snapshot", pids: [...group], date }, {
            signal: controller.signal,
            onProgress: value => setProgress(current => current?.scopeKey === progressScopeKey && !controller.signal.aborted
              ? { ...current, jobs: { ...current.jobs, [groupKey]: { progress: value, settled: false } } } : current)
          });
          if (!controller.signal.aborted) setResources(current => ({ ...current,
            ...Object.fromEntries(dashboards.map(data => [data.data.query.pid, { status: "success" as const, data, refreshing: false, refreshError: null }])) }));
        } catch (error) { group.forEach(pid => fail(pid, error)); }
        finally {
          if (!controller.signal.aborted) setProgress(current => current?.scopeKey === progressScopeKey
            ? { ...current, completed: Math.min(current.total, current.completed + group.length),
              jobs: { ...current.jobs, [groupKey]: { ...current.jobs?.[groupKey], settled: true } } } : current);
        }
      }));
      return () => controller.abort();
    }
    let next = 0;
    const worker = async () => {
      while (next < platforms.length && !controller.signal.aborted) {
        const platform = platforms[next++];
        try {
          const data = await fetchDailyDashboard({ boardId: "5.2", pid: platform.pid, dateRange: [shiftDate(date, -7), date], projection: "operating_snapshot" }, OPERATING_METRIC_IDS, controller.signal);
          if (!controller.signal.aborted) setResources(current => ({ ...current, [platform.pid]: { status: "success", data, refreshing: false, refreshError: null } }));
        } catch (error) {
          if (controller.signal.aborted) return;
          fail(platform.pid, error);
        } finally {
          if (!controller.signal.aborted) setProgress(current => completeOperatingPlatformQuery(current, progressScopeKey));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(MAX_OPERATING_REQUESTS, platforms.length) }, worker));
    return () => controller.abort();
  }, [key, revision]);
  return {
    resources: activeKey.current === key ? resources : Object.fromEntries(platforms.map(platform => [platform.pid, { status: "loading" as const }])),
    progress: activeKey.current === key ? progress : null,
    progressScopeKey
  };
}

export function useOperatingLive(live: LiveDashboardReading | null, platform = "all", shared?: ReturnType<typeof useOperatingResources>) {
  const own = useOperatingResources(shared ? null : live);
  const { resources, progress, progressScopeKey } = shared ?? own;
  const columnMetadataKey = useMemo(() => operatingLiveColumnMetadataKey(live, resources, platform), [live, resources, platform]);
  const columns = useMemo(() => operatingLiveColumns(live, resources, platform), [live, columnMetadataKey]);
  const rows = useMemo(() => live ? operatingLiveRows(live, resources, platform) : null, [live, resources, platform]);
  const notice = useMemo(() => operatingReadNotice(live, resources, progress, progressScopeKey, platform), [live, resources, progress, progressScopeKey, platform]);
  return { resources, columns, rows, notice };
}
