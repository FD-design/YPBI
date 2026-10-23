import { afterEach, expect, test } from "bun:test";
import { DAILY_STATISTICS_VERSION, dailyDashboardSuccessSchema } from "../../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, OPERATING_SNAPSHOT_STATISTICS_REASON, operatingSnapshotDates } from "../../../contracts/operating-detail-projection";
import { operatingQueryDateRange } from "../../../contracts/operating-query-jobs";
import { OPERATING_QUERY_VALIDATION_PATH as path } from "../../../contracts/operating-query-validation";
import { setDataEnvironmentPreference } from "./dataEnvironmentPreference";
import { createOperatingValidationRunner, validationSafeError } from "./operating-query-validation";

const date = "2026-10-21", csrf = "synthetic-csrf-not-for-evidence";
const groups = [{ site: "primary", pids: ["PH", "TT"] }, { site: "secondary", pids: ["FBI", "XH"] }] as const;
const handle = (index: number) => `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`;
function dashboard(pid: string) {
  const dateRange = operatingQueryDateRange(date);
  return dailyDashboardSuccessSchema.parse({ success: true, data: { schemaVersion: "day-dashboard/v2", query: { boardId: "5.2", pid, dateRange, projection: "operating_snapshot" },
    queryId: "synthetic-" + pid, fetchedAt: "2026-10-23T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["synthetic"],
    series: OPERATING_METRIC_IDS.map((id, index) => ({ metric: { id, name: id, unit: "人", definition: "合成测试", authorityVersion: "synthetic", formula: null, referenceMetricId: id, sourceNote: null, inputs: [{ key: "n", name: "人数", unit: "人" }] },
      points: operatingSnapshotDates(dateRange).map(date => ({ date, state: index === 1 ? "no_value" : "available", sourceStatus: index === 1 ? "PROCESSING" : "READY", value: index === 1 ? null : 0, inputs: [{ key: "n", value: index === 1 ? 2 : 0 }] })),
      periodStatistics: { aggregationVersion: DAILY_STATISTICS_VERSION, dateRange, dayCount: 8, state: "unsupported", values: [], reason: OPERATING_SNAPSHOT_STATISTICS_REASON } })) } });
}
const cap = () => Response.json({ success: true, data: { environment: "production", enabled: true, groups } });
const progress = (index: number, phase = "query", status = "SUCCEEDED") => ({ kind: "operating-snapshot", pids: [...groups[index].pids], date, handle: handle(index), phase, status, completedUnits: 14, totalUnits: 14, attempts: 1 });
afterEach(() => setDataEnvironmentPreference("production"));

test("维护前缀与CSRF严格隔离，先两组异步完成再同步，保留空值和safe阶段证据", async () => {
  setDataEnvironmentPreference("production");
  const calls: string[] = [], completed = new Set<number>();
  let ticks = 0, activeSync = 0, maxSync = 0;
  const run = createOperatingValidationRunner({ now: () => ticks++, sleep: async () => {}, fetch: async (url, init) => {
    calls.push(url);
    expect(url.startsWith(path)).toBe(true);
    expect(url.includes("/api/bi/v2/queries/jobs")).toBe(false);
    expect(new Headers(init.headers).get("x-ypbi-data-environment")).toBe("production");
    if (init.method === "POST") expect(new Headers(init.headers).get("x-csrf-token")).toBe(csrf);
    else expect(new Headers(init.headers).has("x-csrf-token")).toBe(false);
    if (url.endsWith("/capabilities")) return cap();
    if (init.method === "POST") {
      const input = JSON.parse(String(init.body));
      const index = groups.findIndex(group => group.pids[0] === input.pids[0]);
      expect(input).toEqual({ kind: "operating-snapshot", pids: [...groups[index].pids], date });
      return Response.json({ success: true, data: { ...input, handle: handle(index), reused: index === 1 } });
    }
    const index = url.includes(handle(0)) ? 0 : 1;
    if (!url.endsWith("/result")) return Response.json({ success: true, data: progress(index) });
    completed.add(index);
    return Response.json({ success: true, data: { ...progress(index, "complete"), dashboards: groups[index].pids.map(dashboard) } });
  }, fetchDashboard: async (query, metricIds, signal) => {
    expect(completed.size).toBe(2); expect(signal?.aborted).toBe(false);
    expect(metricIds).toEqual(OPERATING_METRIC_IDS);
    expect(query.dateRange).toEqual(operatingQueryDateRange(date));
    activeSync++; maxSync = Math.max(maxSync, activeSync);
    await new Promise(resolve => setTimeout(resolve, 1)); activeSync--;
    return dashboard(query.pid);
  } });
  const result = await run(date, csrf);
  expect(result.status).toBe("complete"); expect(result.groups.map(group => group.reused)).toEqual([false, true]);
  expect(result.candidate).toHaveLength(4); expect(result.baseline).toHaveLength(4); expect(maxSync).toBeLessThanOrEqual(6);
  expect(result.groups.every(group => group.createMs !== undefined && group.queryMs !== undefined && group.projectionMs !== undefined && group.asyncMs !== undefined)).toBe(true);
  expect(result.comparison).toMatchObject({ totalCells: 1108, matchedCells: 1108, notApplicableCells: 8, differences: [], scopeErrors: [] });
  expect(result.candidate[0].data.series[1].points[0]).toMatchObject({ value: null, sourceStatus: "PROCESSING", inputs: [{ key: "n", value: 2 }] });
  expect(result.events.some(event => event.operation === "create" && event.reused === true)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(csrf); expect(calls.filter(url => url === path)).toHaveLength(2);
});

test("任务FAILED只保留安全错误码，仍读取同步基线且由冻结范围报告缺失PID", async () => {
  let creates = 0;
  const run = createOperatingValidationRunner({ sleep: async () => {}, fetch: async (url, init) => {
    if (url.endsWith("/capabilities")) return cap();
    if (init.method === "POST") { const input = JSON.parse(String(init.body)), index = creates++; return Response.json({ success: true, data: { ...input, handle: handle(index), reused: false } }); }
    const index = url.includes(handle(0)) ? 0 : 1;
    return Response.json({ success: true, data: { ...progress(index, "query", "FAILED"), errorCode: "EXECUTION_FAILED" } });
  }, fetchDashboard: async query => dashboard(query.pid) });
  const result = await run(date, csrf);
  expect(result.groups.every(group => group.state === "failed")).toBe(true);
  expect(result.groups[0].error).toEqual({ code: "QUERY_JOB_FAILED", queryJobErrorCode: "EXECUTION_FAILED" });
  expect(result.candidate).toHaveLength(0); expect(result.baseline).toHaveLength(4);
  expect(result.comparison?.scopeErrors).toContain("async:MISSING_EXPECTED_PID:PH");
  expect(result.events.filter(event => event.operation === "result" && event.httpStatus)).toHaveLength(0);
});

test("维护401交回既有维护入口，不读取同步且不回显raw错误", async () => {
  let accessCode = "", sync = 0;
  const run = createOperatingValidationRunner({ fetch: async () => Response.json({ success: false, error: {
    code: "MAINTENANCE_LOGIN_REQUIRED", requestId: "safe-request-1", message: "raw-secret-must-not-escape"
  } }, { status: 401 }), fetchDashboard: async query => { sync++; return dashboard(query.pid); } });
  const result = await run(date, csrf, { onMaintenanceError: error => { accessCode = error.code; } });
  expect(accessCode).toBe("MAINTENANCE_LOGIN_REQUIRED"); expect(sync).toBe(0); expect(result.status).toBe("failed");
  expect(result.error).toEqual({ code: "MAINTENANCE_LOGIN_REQUIRED", requestId: "safe-request-1" });
  expect(JSON.stringify(result)).not.toContain("raw-secret");
});

test("测试环境不发送联调请求；能力返回后切环境也不创建任务", async () => {
  let calls = 0;
  const run = createOperatingValidationRunner({ fetch: async () => { calls++; setDataEnvironmentPreference("test"); return cap(); } });
  setDataEnvironmentPreference("test");
  expect((await run(date, csrf)).error?.code).toBe("VALIDATION_PRODUCTION_REQUIRED"); expect(calls).toBe(0);
  setDataEnvironmentPreference("production");
  expect((await run(date, csrf)).error?.code).toBe("VALIDATION_PRODUCTION_REQUIRED"); expect(calls).toBe(1);
});

test("取消创建后不投递晚结果、不读同步、不重建任务", async () => {
  const controller = new AbortController();
  let release: (() => void) | undefined, sync = 0, createCount = 0, updates = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const run = createOperatingValidationRunner({ fetch: async (url, init) => {
    if (url.endsWith("/capabilities")) return cap();
    createCount++; await pending;
    return Response.json({ success: true, data: { ...JSON.parse(String(init.body)), handle: handle(createCount - 1), reused: false } });
  }, fetchDashboard: async query => { sync++; return dashboard(query.pid); } });
  const task = run(date, csrf, { signal: controller.signal, onUpdate: () => { updates++; } });
  while (!createCount) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(); const result = await task; const finalUpdates = updates;
  release!(); await new Promise(resolve => setTimeout(resolve, 5));
  expect(result.status).toBe("cancelled"); expect(sync).toBe(0); expect(createCount).toBe(2); expect(updates).toBe(finalUpdates);
  expect(result.candidate).toHaveLength(0);
});

test("错误证据白名单丢弃raw文本和不安全字段", () => {
  expect(validationSafeError({ code: "UPSTREAM_REJECTED", requestId: "safe-id", message: "secret", upstreamBusinessCode: 400, upstreamHttpStatus: 503, token: "secret" }))
    .toEqual({ code: "UPSTREAM_REJECTED", requestId: "safe-id", upstreamBusinessCode: 400, upstreamHttpStatus: 503 });
  expect(validationSafeError({ code: "raw body with secret", requestId: "raw\nsecret" })).toEqual({ code: "VALIDATION_REQUEST_FAILED" });
});

test("空范围或关闭能力不创建任务，也不触发普通异步开关或同步读取", async () => {
  for (const data of [{ environment: "production", enabled: false, groups: [] }, { environment: "production", enabled: true, groups: [] }]) {
    const calls: string[] = [];
    const run = createOperatingValidationRunner({ fetch: async url => { calls.push(url); return Response.json({ success: true, data }); }, fetchDashboard: async () => { throw new Error("must not run"); } });
    const result = await run(date, csrf);
    expect(result.error?.code).toBe("VALIDATION_DISABLED"); expect(calls).toEqual([`${path}/capabilities`]);
  }
});
