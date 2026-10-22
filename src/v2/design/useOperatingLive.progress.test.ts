import { expect, test } from "bun:test";
import * as React from "react";
import type { DailyDashboardQuery } from "../../../contracts/daily-dashboard";
import { DAILY_STATISTICS_VERSION } from "../../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, OPERATING_SNAPSHOT_STATISTICS_REASON, operatingSnapshotDates } from "../../../contracts/operating-detail-projection";
import { operatingQueryDateRange } from "../../../contracts/operating-query-jobs";
import { currentDataEnvironmentPreference, setDataEnvironmentPreference, type DataEnvironmentMode } from "../api/dataEnvironmentPreference";
import { dailyDashboardEnvironment } from "../api/daily-dashboard-environment";
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
        useRef(initial: unknown) {
          const index = stateIndex++;
          if (!(index in states)) states[index] = { current: initial };
          return states[index];
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

for (const environment of ["test", "production"] as const) test(`${environment}模式按服务器站点组运行任务，成功投影保持93列真实状态，失败组不转同步`, async () => {
  const originalFetch = globalThis.fetch, originalEnvironment = currentDataEnvironmentPreference(), harness = hookHarness();
  setDataEnvironmentPreference(environment);
  const calls: string[] = [], handles = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const live = { ...reading(), dataEnvironment: environment, operatingAsyncPidGroups: [["PH"], ["TT"]] };
  globalThis.fetch = (async (path, init) => {
    calls.push(String(path));
    expect(new Headers(init?.headers).get("x-ypbi-data-environment")).toBe(environment);
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
    expect(current.resources.PH.status === "success" && dailyDashboardEnvironment(current.resources.PH.data)).toBe(environment);
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

function asyncReading(pids = ["PH"], environment: DataEnvironmentMode = "test"): LiveDashboardReading {
  return { ...reading(pids), dataEnvironment: environment, operatingAsyncPidGroups: pids.map(pid => [pid]) };
}

interface PendingJobRead {
  path: string;
  body: { pids: string[]; date: string } | null;
  signal: AbortSignal | null | undefined;
  headers: Headers;
  finish: (payload: unknown, status?: number) => void;
}

async function withJobReads(run: (harness: ReturnType<typeof hookHarness>, pending: PendingJobRead[]) => Promise<void>, mode: DataEnvironmentMode = "test") {
  const originalFetch = globalThis.fetch, environment = currentDataEnvironmentPreference(), harness = hookHarness(), pending: PendingJobRead[] = [];
  setDataEnvironmentPreference(mode);
  globalThis.fetch = (async (path, init) => new Promise<Response>(resolve => {
    pending.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : null,
      signal: init?.signal, headers: new Headers(init?.headers), finish: (payload, status = 200) => resolve(Response.json(payload, { status })) });
  })) as typeof globalThis.fetch;
  try { await run(harness, pending); }
  finally {
    harness.unmount();
    pending.forEach(read => read.finish({ success: false, error: { code: "FIXTURE_CLEANUP", message: "fixture cleanup" } }, 503));
    await turn();
    globalThis.fetch = originalFetch;
    setDataEnvironmentPreference(environment);
  }
}

const jobHandle = "11111111-1111-4111-8111-111111111111";
function jobScope(live: LiveDashboardReading, pid = live.query.pid, handle = jobHandle) {
  return { kind: "operating-snapshot", pids: [pid], date: live.query.dateRange[1], handle };
}
async function finishJob(pending: PendingJobRead[], live: LiveDashboardReading, createIndex = 0) {
  const scope = jobScope(live), statusIndex = pending.length;
  pending[createIndex].finish({ success: true, data: { ...scope, reused: false } });
  await new Promise(resolve => setTimeout(resolve, 2100));
  await until(() => pending.length > statusIndex);
  const progress = { ...scope, status: "SUCCEEDED", phase: "query", completedUnits: 14, totalUnits: 14, attempts: 1 };
  pending[statusIndex].finish({ success: true, data: progress });
  await until(() => pending.length > statusIndex + 1);
  const query: DailyDashboardQuery = { boardId: "5.2", pid: live.query.pid,
    dateRange: operatingQueryDateRange(live.query.dateRange[1]), projection: "operating_snapshot" };
  pending[statusIndex + 1].finish({ success: true, data: { ...progress, phase: "complete", dashboards: [success(query, "READY", "2026-10-21T02:00:00Z")] } });
}

test("异步创建HTTP400仅失败当前平台组，其他组完成93列且不转同步", async () => {
  await withJobReads(async (harness, pending) => {
    const live = asyncReading(["PH", "TT"]);
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 2);
    const diagnostics = { code: "QUERY_JOB_UPSTREAM_REJECTED", requestId: "fixture-create-rejected", upstreamBusinessCode: 400, upstreamHttpStatus: 200 };
    pending[1].finish({ success: false, error: { ...diagnostics, message: "查询任务被拒绝" } }, 400);
    await until(() => harness.render(live).resources.TT?.status === "failure");
    await finishJob(pending, live);
    await until(() => harness.render(live).resources.PH?.status === "success");
    const result = harness.render(live);
    expect(result.resources.PH.status === "success" && result.resources.PH.data.data.series).toHaveLength(93);
    expect(result.resources.TT).toMatchObject({ status: "failure", ...diagnostics });
    expect(result.rows?.find(row => row.pid === "TT")?.values).toHaveLength(93);
    for (const value of result.rows!.find(row => row.pid === "TT")!.values) expect(value.evidence?.current.requestFailure).toEqual(diagnostics);
    for (const value of result.rows!.find(row => row.pid === "PH")!.values) expect(value.evidence?.current.requestFailure).toBeUndefined();
    expect(result.notice.progress).toBeNull();
    expect(pending.filter(read => read.body)).toHaveLength(2);
    expect(pending.every(read => read.path.startsWith("/api/bi/v2/queries/jobs"))).toBe(true);
  });
});

test("异步创建失败按平台保留各自上游业务码与HTTP状态，93列详情不串用诊断", async () => {
  await withJobReads(async (harness, pending) => {
    const live = asyncReading(["PH", "TT"]);
    const diagnostics = [
      { code: "QUERY_JOB_UPSTREAM_REJECTED", requestId: "fixture-ph-rejected", upstreamBusinessCode: 400, upstreamHttpStatus: 200 },
      { code: "QUERY_JOB_UPSTREAM_REJECTED", requestId: "fixture-tt-rejected", upstreamBusinessCode: 503, upstreamHttpStatus: 503 }
    ];
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 2);
    pending.forEach((request, index) => request.finish({ success: false, error: { ...diagnostics[index], message: "查询任务被拒绝" } }, 400));
    await until(() => harness.render(live).notice.progress === null);
    const result = harness.render(live);
    expect(result.rows).toHaveLength(2);
    result.rows!.forEach((row, index) => {
      expect(result.resources[row.pid]).toMatchObject({ status: "failure", ...diagnostics[index] });
      expect(row.values).toHaveLength(93);
      for (const value of row.values) expect(value.evidence?.current.requestFailure).toEqual(diagnostics[index]);
    });
    expect(pending).toHaveLength(2);
  });
});

test("异步创建期间切换日期取消旧轮，旧句柄不轮询且晚到结果不覆盖当前范围", async () => {
  await withJobReads(async (harness, pending) => {
    const old = asyncReading(), current = { ...old, query: { ...old.query, dateRange: ["2020-01-02", "2020-01-02"] as [string, string] } };
    harness.render(old); harness.flushEffects();
    await until(() => pending.length === 1);
    expect(harness.render(current).notice.progress).toBeNull();
    harness.flushEffects();
    await until(() => pending.length === 2);
    expect(pending[0].signal?.aborted).toBe(true);
    pending[0].finish({ success: true, data: { ...jobScope(old, "PH", "22222222-2222-4222-8222-222222222222"), reused: false } });
    await finishJob(pending, current, 1);
    await until(() => harness.render(current).resources.PH?.status === "success");
    const result = harness.render(current);
    expect(result.resources.PH.status === "success" && result.resources.PH.data.data.query.dateRange).toEqual(["2019-12-26", "2020-01-02"]);
    expect(result.notice.progress).toBeNull();
    expect(pending.some(read => read.path.includes("22222222"))).toBe(false);
    expect(pending.filter(read => read.body).map(read => read.body?.date)).toEqual(["2020-01-01", "2020-01-02"]);
  });
});

test("异步刷新创建失败保留原结果与时间，权限拒绝清除旧结果，显式刷新才创建新任务", async () => {
  await withJobReads(async (harness, pending) => {
    let live = asyncReading();
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 1);
    await finishJob(pending, live);
    await until(() => harness.render(live).resources.PH?.status === "success");
    const previous = harness.render(live).resources.PH;
    live = { ...live, refreshRevision: 1 };
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 4);
    expect(harness.render(live).notice.retained?.firstReadAt).toBe("2026-10-21T02:00:00Z");
    const diagnostics = { code: "QUERY_JOB_UPSTREAM_REJECTED", requestId: "fixture-refresh-rejected", upstreamBusinessCode: 400, upstreamHttpStatus: 200 };
    pending[3].finish({ success: false, error: { ...diagnostics, message: "查询任务被拒绝" } }, 400);
    await until(() => harness.render(live).notice.progress === null);
    const failed = harness.render(live).resources.PH;
    expect(failed).toMatchObject({ status: "success", refreshing: false, refreshError: diagnostics });
    expect(failed.status === "success" && previous.status === "success" && failed.data === previous.data).toBe(true);
    for (const value of harness.render(live).rows![0].values) {
      expect(value.evidence?.current.requestFailure).toEqual(diagnostics);
      expect(value.evidence?.current.stale).toBe(true);
    }
    expect(harness.render(live).notice.retained?.firstReadAt).toBe("2026-10-21T02:00:00Z");
    expect(pending).toHaveLength(4);
    live = { ...live, refreshRevision: 2 };
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 5);
    pending[4].finish({ success: false, error: { code: "PID_ACCESS_DENIED", message: "无权访问", requestId: "fixture-refresh-denied" } }, 403);
    await until(() => harness.render(live).resources.PH?.status === "failure");
    expect(harness.render(live).notice).toEqual({ progress: null, retained: null });
    expect(pending.filter(read => read.body)).toHaveLength(3);
    expect(harness.render(live).resources.PH).not.toHaveProperty("upstreamBusinessCode");
    expect(harness.render(live).resources.PH).not.toHaveProperty("upstreamHttpStatus");
    live = { ...live, refreshRevision: 3 };
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 6);
    await finishJob(pending, live, 5);
    await until(() => harness.render(live).resources.PH?.status === "success");
    const recovered = harness.render(live);
    expect(recovered.resources.PH).toMatchObject({ status: "success", refreshing: false, refreshError: null });
    for (const value of recovered.rows![0].values) {
      expect(value.evidence?.current.requestFailure).toBeUndefined();
      expect(value.evidence?.current.stale).toBe(false);
    }
    expect(recovered.notice).toEqual({ progress: null, retained: null });
  });
}, 10_000);

test("环境作用域卸载停止旧异步创建，正式能力禁用时沿原同步读取且不接收旧进度", async () => {
  await withJobReads(async (oldHarness, pending) => {
    const old = asyncReading();
    oldHarness.render(old); oldHarness.flushEffects();
    await until(() => pending.length === 1);
    oldHarness.unmount();
    expect(pending[0].signal?.aborted).toBe(true);
    setDataEnvironmentPreference("production");
    const current = reading(["PH"]), newHarness = hookHarness();
    try {
      newHarness.render(current); newHarness.flushEffects();
      await until(() => pending.length === 2);
      expect(pending[1].path).toBe("/api/bi/v2/queries/dashboards/daily-reading");
      expect(pending[1].headers.get("x-ypbi-data-environment")).toBe("production");
      pending[0].finish({ success: true, data: { ...jobScope(old), reused: false } });
      const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2019-12-25", "2020-01-01"], projection: "operating_snapshot" };
      pending[1].finish(success(query, "PROCESSING", "2026-10-21T03:00:00Z"));
      await until(() => newHarness.render(current).resources.PH?.status === "success");
      const result = newHarness.render(current);
      expect(result.resources.PH.status === "success" && result.resources.PH.data.data.series[0].points[0].sourceStatus).toBe("PROCESSING");
      expect(result.notice).toEqual({ progress: null, retained: null });
      expect(pending).toHaveLength(2);
    } finally { newHarness.unmount(); }
  });
});

for (const environment of ["test", "production"] as const) test(`${environment}未收到服务器异步分组时保持同步93列读取`, async () => {
  await withJobReads(async (harness, pending) => {
    const live = { ...reading(), dataEnvironment: environment };
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 2);
    expect(pending.every(read => read.path === "/api/bi/v2/queries/dashboards/daily-reading")).toBe(true);
    expect(pending.every(read => read.headers.get("x-ypbi-data-environment") === environment)).toBe(true);
    for (const read of pending) read.finish(success(read.body as unknown as DailyDashboardQuery, "PROCESSING", "2026-10-21T03:00:00Z"));
    await until(() => harness.render(live).notice.progress === null);
    const result = harness.render(live);
    expect(result.rows).toHaveLength(2);
    expect(result.rows!.every(row => row.values.length === 93)).toBe(true);
    expect(result.resources.PH.status === "success" && result.resources.PH.data.data.series[0].points[0].sourceStatus).toBe("PROCESSING");
  }, environment);
});

for (const rejection of [
  { status: 401, code: "AUTHENTICATION_REQUIRED" },
  { status: 403, code: "PID_ACCESS_DENIED" },
  { status: 409, code: "DATA_PREVIEW_SESSION_REQUIRED" },
  { status: 409, code: "QUERY_JOB_CONTEXT_CHANGED" },
  { status: 422, code: "QUERY_JOBS_DISABLED" }
]) test(`正式任务${rejection.code}失败保持原拒绝，不转同步请求`, async () => {
  await withJobReads(async (harness, pending) => {
    const live = asyncReading(["PH"], "production");
    harness.render(live); harness.flushEffects();
    await until(() => pending.length === 1);
    pending[0].finish({ success: false, error: { code: rejection.code, message: "查询任务拒绝", requestId: "fixture-rejected" } }, rejection.status);
    await until(() => harness.render(live).resources.PH?.status === "failure");
    expect(harness.render(live).resources.PH).toMatchObject({ status: "failure", code: rejection.code });
    expect(harness.render(live).notice.progress).toBeNull();
    expect(pending).toHaveLength(1);
    expect(pending[0].path).toBe("/api/bi/v2/queries/jobs");
  }, "production");
});

test("同一经营容器环境变化立即隐藏旧状态并取消旧创建，新环境独立创建任务", async () => {
  await withJobReads(async (harness, pending) => {
    const old = asyncReading(), current = asyncReading(["PH"], "production");
    harness.render(old); harness.flushEffects();
    await until(() => pending.length === 1);
    setDataEnvironmentPreference("production");
    expect(harness.render(current).resources.PH).toEqual({ status: "loading" });
    expect(harness.render(current).notice.progress).toBeNull();
    harness.flushEffects();
    await until(() => pending.length === 2);
    expect(pending[0].signal?.aborted).toBe(true);
    expect(pending[0].headers.get("x-ypbi-data-environment")).toBe("test");
    expect(pending[1].headers.get("x-ypbi-data-environment")).toBe("production");
    pending[0].finish({ success: true, data: { ...jobScope(old, "PH", "22222222-2222-4222-8222-222222222222"), reused: false } });
    await finishJob(pending, current, 1);
    await until(() => harness.render(current).resources.PH?.status === "success");
    const result = harness.render(current);
    expect(result.resources.PH.status === "success" && dailyDashboardEnvironment(result.resources.PH.data)).toBe("production");
    expect(result.rows![0].values).toHaveLength(93);
    expect(pending).toHaveLength(4);
    expect(pending.some(read => read.path.includes("22222222"))).toBe(false);
    expect(pending.every(read => read.path.startsWith("/api/bi/v2/queries/jobs"))).toBe(true);
  });
});
