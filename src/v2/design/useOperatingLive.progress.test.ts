import { expect, test } from "bun:test";
import * as React from "react";
import type { DailyDashboardQuery } from "../../../contracts/daily-dashboard";
import { DAILY_STATISTICS_VERSION } from "../../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, OPERATING_SNAPSHOT_STATISTICS_REASON, operatingSnapshotDates } from "../../../contracts/operating-detail-projection";
import { currentDataEnvironmentPreference, setDataEnvironmentPreference } from "../api/dataEnvironmentPreference";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { useOperatingLive } from "./useOperatingLive";

function reading(pids = ["PH", "TT"]): LiveDashboardReading {
  return { query: { boardId: "5.2", pid: pids[0], dateRange: ["2020-01-01", "2020-01-01"] }, dataEnvironment: "production",
    metricIds: OPERATING_METRIC_IDS, platforms: pids.map(pid => ({ pid, name: pid })), platformName: pids[0], state: { status: "loading" },
    canExport: true, retry() {}, controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}

// Execute the hook's real effects and cleanup without a browser or React DOM.
function hookHarness() {
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const states: unknown[] = [], effects: { deps: readonly unknown[]; cleanup?: () => void }[] = [];
  let pending: Array<() => void> = [];
  return {
    render(live: LiveDashboardReading | null) {
      let stateIndex = 0, effectIndex = 0;
      const prior = internals.H;
      internals.H = {
        useState(initial: unknown) {
          const index = stateIndex++;
          if (!(index in states)) states[index] = initial;
          return [states[index], (value: unknown) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
        },
        useMemo: (calculate: () => unknown) => calculate(),
        useEffect(effect: () => (() => void) | undefined, deps: readonly unknown[]) {
          const index = effectIndex++, previous = effects[index];
          if (!previous || previous.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
            const entry = { deps, cleanup: previous?.cleanup };
            effects[index] = entry;
            pending.push(() => { entry.cleanup?.(); entry.cleanup = effect(); });
          }
        }
      };
      try { return useOperatingLive(live); } finally { internals.H = prior; }
    },
    flushEffects() { const batch = pending; pending = []; batch.forEach(run => run()); },
    unmount() { effects.forEach(effect => effect.cleanup?.()); pending = []; }
  };
}

interface PendingRead {
  query: DailyDashboardQuery;
  signal: AbortSignal | null | undefined;
  finish: (status?: number, sourceStatus?: "READY" | "PROCESSING", fetchedAt?: string) => void;
}
function success(query: DailyDashboardQuery, sourceStatus: "READY" | "PROCESSING", fetchedAt: string) {
  return { success: true, data: { schemaVersion: "day-dashboard/v2", query, queryId: query.pid + fetchedAt, fetchedAt,
    timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["synthetic-metrics"],
    series: OPERATING_METRIC_IDS.map(id => ({ metric: { id, name: id, unit: "人", definition: "test", authorityVersion: "test", formula: null, referenceMetricId: id, sourceNote: null, inputs: [{ key: "n", name: "人数", unit: "人" }] },
      points: operatingSnapshotDates(query.dateRange).map(date => ({ date, sourceStatus, state: sourceStatus === "READY" ? "available" : "no_value", value: sourceStatus === "READY" ? 0 : null, inputs: [{ key: "n", value: 0 }] })),
      periodStatistics: { aggregationVersion: DAILY_STATISTICS_VERSION, dateRange: query.dateRange, dayCount: 8, state: "unsupported", values: [], reason: OPERATING_SNAPSHOT_STATISTICS_REASON } })) } };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await turn();
  expect(condition()).toBe(true);
}
async function withReads(run: (harness: ReturnType<typeof hookHarness>, pending: PendingRead[]) => Promise<void>) {
  const fetch = globalThis.fetch, environment = currentDataEnvironmentPreference(), pending: PendingRead[] = [], harness = hookHarness();
  setDataEnvironmentPreference("production");
  globalThis.fetch = (async (_path, init) => new Promise<Response>(resolve => {
    const query = JSON.parse(String(init?.body)) as DailyDashboardQuery;
    pending.push({ query, signal: init?.signal, finish: (status = 200, sourceStatus = "READY", fetchedAt = "2026-10-21T02:00:00Z") => resolve(Response.json(status === 200 ? success(query, sourceStatus, fetchedAt)
      : { success: false, error: { code: status === 403 ? "PID_ACCESS_DENIED" : "V2_UPSTREAM_TIMEOUT", message: "synthetic failure", requestId: "synthetic-request" } }, { status })) });
  })) as typeof globalThis.fetch;
  try { await run(harness, pending); }
  finally {
    harness.unmount();
    pending.forEach(read => read.finish());
    await turn();
    globalThis.fetch = fetch;
    setDataEnvironmentPreference(environment);
  }
}

test("真实请求结算驱动平台进度，PROCESSING响应与请求失败都结束一个平台查询", async () => {
  await withReads(async (harness, pending) => {
    const live = reading();
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 2);
    expect(harness.render(live).notice.progress).toEqual({ completed: 0, total: 2 });
    pending[0].finish(200, "PROCESSING");
    await until(() => harness.render(live).notice.progress?.completed === 1);
    const first = harness.render(live).resources.PH;
    expect(first.status).toBe("success");
    if (first.status === "success") expect(first.data.data.series[0].points[0].sourceStatus).toBe("PROCESSING");
    pending[1].finish(504);
    await until(() => harness.render(live).notice.progress === null);
    expect(harness.render(live).resources.TT.status).toBe("failure");
    expect(harness.render(live).notice.retained).toBeNull();
  });
});

test("刷新从零计数，失败后保留原读取时间，权限失败清除旧结果", async () => {
  await withReads(async (harness, pending) => {
    let live = reading(["PH"]);
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 1);
    pending[0].finish();
    await until(() => harness.render(live).resources.PH?.status === "success");
    live = { ...live, refreshRevision: 1 };
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 2);
    expect(harness.render(live).notice.progress).toEqual({ completed: 0, total: 1 });
    expect(harness.render(live).notice.retained?.firstReadAt).toBe("2026-10-21T02:00:00Z");
    pending[1].finish(504);
    await until(() => harness.render(live).notice.progress === null);
    expect(harness.render(live).notice.retained?.firstReadAt).toBe("2026-10-21T02:00:00Z");
    live = { ...live, refreshRevision: 2 };
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 3);
    pending[2].finish(403);
    await until(() => harness.render(live).resources.PH?.status === "failure");
    expect(harness.render(live).notice).toEqual({ progress: null, retained: null });
  });
});

test("日期切换取消旧轮，迟到响应不计入新进度或覆盖新结果", async () => {
  await withReads(async (harness, pending) => {
    const old = reading(["PH"]);
    harness.render(old); harness.flushEffects();
    await until(() => pending.length === 1);
    const current: LiveDashboardReading = { ...old, query: { ...old.query, dateRange: ["2020-01-02", "2020-01-02"] } };
    expect(harness.render(current).notice.progress).toBeNull();
    harness.flushEffects();
    await until(() => pending.length === 2);
    expect(pending[0].signal?.aborted).toBe(true);
    expect(harness.render(current).notice.progress).toEqual({ completed: 0, total: 1 });
    pending[1].finish();
    await until(() => harness.render(current).notice.progress === null);
    const result = harness.render(current).resources.PH;
    pending[0].finish(200, "PROCESSING");
    await turn();
    expect(harness.render(current).resources.PH).toBe(result);
    expect(harness.render(current).notice).toEqual({ progress: null, retained: null });
  });
});

test("测试模式按服务器站点组运行任务，成功投影保持93列真实状态，失败组不转同步", async () => {
  const originalFetch = globalThis.fetch, originalEnvironment = currentDataEnvironmentPreference(), harness = hookHarness();
  setDataEnvironmentPreference("test");
  const calls: string[] = [], handles = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const live = { ...reading(), dataEnvironment: "test" as const, operatingAsyncPidGroups: [["PH"], ["TT"]] };
  globalThis.fetch = (async (path, init) => {
    calls.push(String(path));
    expect(new Headers(init?.headers).get("x-ypbi-data-environment")).toBe("test");
    const request = init?.body ? JSON.parse(String(init.body)) : null;
    const index = request ? request.pids[0] === "PH" ? 0 : 1 : String(path).includes(handles[0]) ? 0 : 1;
    const scope = { kind: "operating-snapshot", pids: [index ? "TT" : "PH"], date: "2020-01-01", handle: handles[index] };
    if (request) return Response.json({ success: true, data: { ...scope, reused: false } });
    const progress = { ...scope, status: index ? "FAILED" : "SUCCEEDED", phase: "query", completedUnits: index ? 2 : 14, totalUnits: 14, attempts: 1 };
    if (!String(path).endsWith("/result")) return Response.json({ success: true, data: progress });
    const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2019-12-25", "2020-01-01"], projection: "operating_snapshot" };
    return Response.json({ success: true, data: { ...progress, phase: "complete", dashboards: [success(query, "PROCESSING", "2026-10-21T02:00:00Z")] } });
  }) as typeof globalThis.fetch;
  try {
    harness.render(live); harness.flushEffects();
    await new Promise(resolve => setTimeout(resolve, 2100));
    await until(() => harness.render(live).resources.PH?.status === "success" && harness.render(live).resources.TT?.status === "failure");
    const current = harness.render(live);
    expect(current.notice.progress).toBeNull();
    expect(current.resources.PH.status === "success" && current.resources.PH.data.data.series).toHaveLength(93);
    expect(current.resources.PH.status === "success" && current.resources.PH.data.data.series[0].points[0].sourceStatus).toBe("PROCESSING");
    expect(current.resources.TT).toMatchObject({ status: "failure", code: "QUERY_JOB_FAILED", message: "查询任务执行失败" });
    expect(calls.filter(path => path === "/api/bi/v2/queries/jobs")).toHaveLength(2);
    expect(calls.some(path => path.includes("daily-reading"))).toBe(false);
  } finally { harness.unmount(); globalThis.fetch = originalFetch; setDataEnvironmentPreference(originalEnvironment); }
});

test("异步目录漏平台或重复平台时失败关闭，不偷偷改用同步或查询未授权PID", async () => {
  const originalFetch = globalThis.fetch, originalEnvironment = currentDataEnvironmentPreference();
  setDataEnvironmentPreference("test");
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected request"); }) as typeof globalThis.fetch;
  try {
    for (const groups of [[["PH"]], [["PH"], ["PH"]], [["PH"], ["OTHER"]]]) {
      const harness = hookHarness(), live = { ...reading(), dataEnvironment: "test" as const, operatingAsyncPidGroups: groups };
      harness.render(live); harness.flushEffects();
      expect(harness.render(live).resources.PH.status).toBe("failure");
      expect(harness.render(live).resources.TT.status).toBe("failure");
      expect(harness.render(live).notice.progress).toBeNull();
      harness.unmount();
    }
    expect(calls).toBe(0);
  } finally { globalThis.fetch = originalFetch; setDataEnvironmentPreference(originalEnvironment); }
});
