import { afterEach, expect, test } from "bun:test";
import type { DailyDashboardQuery, DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, OPERATING_SNAPSHOT_STATISTICS_REASON, operatingSnapshotDates } from "../../../contracts/operating-detail-projection";
import { fetchDailyDashboard } from "./client";
import { dailyDashboardEnvironment } from "./daily-dashboard-environment";
import { currentDataEnvironmentPreference, setDataEnvironmentPreference } from "./dataEnvironmentPreference";
import { V2_AUTHENTICATION_REQUIRED_EVENT } from "./authEvents";

const originalFetch = globalThis.fetch, originalEnvironment = currentDataEnvironmentPreference();
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const controllers: AbortController[] = [], requests: Promise<unknown>[] = [], cleanups: (() => void)[] = [];
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const snapshot = (pid: string): DailyDashboardQuery => ({ boardId: "5.2", pid, dateRange: ["2020-01-03", "2020-01-10"], projection: "operating_snapshot" });
const foreground = (pid: string): DailyDashboardQuery => ({ boardId: "5.8", pid, dateRange: ["2020-01-10", "2020-01-10"] });
const ids = (query: DailyDashboardQuery) => query.projection ? OPERATING_METRIC_IDS : ["M020"];
function body(query: DailyDashboardQuery): DailyDashboardSuccess {
  const dates = query.projection ? operatingSnapshotDates(query.dateRange) : [query.dateRange[1]];
  return { success: true, data: {
    schemaVersion: query.projection ? "day-dashboard/v2" : "day-dashboard/v1", query: structuredClone(query), queryId: "isolated-scheduling",
    fetchedAt: "2026-10-14T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"],
    series: ids(query).map(id => ({ metric: { id, name: id, unit: "%", definition: "隔离调度样例", authorityVersion: "isolated", formula: "分子 / 分母", referenceMetricId: id, sourceNote: "仅测试", inputs: [{ key: "n", name: "分子", unit: "人" }, { key: "d", name: "分母", unit: "人" }] },
      points: dates.map(date => ({ date, state: "available", sourceStatus: "READY", value: 0, inputs: [{ key: "n", value: 0 }, { key: "d", value: 3 }] })),
      ...(query.projection ? { periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: query.dateRange, dayCount: 8, state: "unsupported", values: [], reason: OPERATING_SNAPSHOT_STATISTICS_REASON } } : {})
    }))
  } } as DailyDashboardSuccess;
}
function issue(query: DailyDashboardQuery, metricIds: readonly string[] = ids(query)) {
  const controller = new AbortController(); controllers.push(controller);
  const promise = fetchDailyDashboard(query, metricIds, controller.signal);
  void promise.catch(() => {}); requests.push(promise);
  return { promise, controller };
}
function holdFetch() {
  const sent: { query: DailyDashboardQuery; headers: Headers; finish: () => void }[] = [];
  globalThis.fetch = (async (path, init) => {
    expect(path).toBe("/api/bi/v2/queries/dashboards/daily-reading");
    expect(init?.method).toBe("POST"); expect(init?.cache).toBe("no-store"); expect(init?.credentials).toBe("same-origin");
    const query = JSON.parse(String(init?.body)) as DailyDashboardQuery;
    return new Promise<Response>((resolve, reject) => {
      let done = false;
      const signal = init?.signal, cancel = () => { if (!done) { done = true; reject(signal?.reason); } };
      const finish = () => { if (!done) { done = true; signal?.removeEventListener("abort", cancel); resolve(Response.json(body(query))); } };
      signal?.addEventListener("abort", cancel, { once: true });
      cleanups.push(finish); sent.push({ query, headers: new Headers(init?.headers), finish });
    });
  }) as typeof fetch;
  return sent;
}
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort());
  cleanups.splice(0).forEach(finish => finish());
  await Promise.allSettled(requests.splice(0));
  globalThis.fetch = originalFetch; setDataEnvironmentPreference(originalEnvironment);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("主查询与经营快照共用6个槽，同批主查询先启动", async () => {
  const sent = holdFetch();
  const jobs = Array.from({ length: 6 }, (_, i) => issue(snapshot(`S${i}`)));
  const main = issue(foreground("PH"));
  await flush();
  expect(sent).toHaveLength(6);
  expect(sent[0].query).toEqual(foreground("PH"));
  expect(sent.slice(1).map(item => item.query.pid)).toEqual(["S0", "S1", "S2", "S3", "S4"]);
  sent[0].finish(); await main.promise; await flush();
  expect(sent).toHaveLength(7); expect(sent[6].query.pid).toBe("S5");
  sent.forEach(item => item.finish());
  const results = await Promise.all(jobs.map(job => job.promise));
  expect(results.every(result => result.data.series.length === OPERATING_METRIC_IDS.length)).toBe(true);
  expect(results.every(result => result.data.series.every(series => series.points.every(point => point.value === 0 && point.sourceStatus === "READY")))).toBe(true);
});

test("排队时冻结环境、请求范围及期望指标，后续偏好变化不改写结果", async () => {
  const sent = holdFetch(); Array.from({ length: 6 }, (_, i) => issue(foreground(`B${i}`)));
  await flush();
  setDataEnvironmentPreference("test");
  const query = foreground("PH"), expectedIds = ["M020"], waiting = issue(query, expectedIds);
  query.pid = "OTHER"; query.dateRange[1] = "2020-01-11"; expectedIds[0] = "M001";
  setDataEnvironmentPreference("production");
  expect(sent).toHaveLength(6);
  sent[0].finish(); await flush();
  const issued = sent[6]; expect(issued.query).toEqual(foreground("PH"));
  expect(issued.headers.get("x-ypbi-data-environment")).toBe("test");
  issued.finish(); const result = await waiting.promise;
  expect(result.data.query).toEqual(foreground("PH")); expect(dailyDashboardEnvironment(result)).toBe("test");
  sent.forEach(item => item.finish());
});

test("共享槽保留至正文解析完成，不在收到响应头时提前释放", async () => {
  const sent: DailyDashboardQuery[] = [];
  const finishBodies: (() => void)[] = [];
  globalThis.fetch = (async (_path, init) => {
    const query = JSON.parse(String(init?.body)) as DailyDashboardQuery; sent.push(query);
    const response = new Response("", { status: 200 });
    Object.defineProperty(response, "json", { value: () => new Promise(resolve => {
      const finish = () => resolve(body(query)); finishBodies.push(finish); cleanups.push(finish);
    }) });
    return response;
  }) as typeof fetch;
  const jobs = Array.from({ length: 7 }, (_, i) => issue(foreground(`J${i}`)));
  await flush(); expect(sent).toHaveLength(6); expect(finishBodies).toHaveLength(6);
  finishBodies[0](); await jobs[0].promise; await flush(); expect(sent).toHaveLength(7);
  finishBodies.forEach(finish => finish()); await Promise.all(jobs.map(job => job.promise));
});

test("排队取消不发送HTTP，取消不影响其他平台的完整响应", async () => {
  const sent = holdFetch(); const jobs = Array.from({ length: 6 }, (_, i) => issue(foreground(`B${i}`)));
  await flush(); const waiting = issue(snapshot("CANCELLED")); waiting.controller.abort();
  await expect(waiting.promise).rejects.toMatchObject({ name: "AbortError" });
  sent.forEach(item => item.finish()); await Promise.all(jobs.map(job => job.promise)); await flush();
  expect(sent).toHaveLength(6); expect(sent.some(item => item.query.pid === "CANCELLED")).toBe(false);
});

test("排队后主查询优先，HTTP异常释放容量且保持原错误分类", async () => {
  const sent = holdFetch(); const blockers = Array.from({ length: 6 }, (_, i) => issue(snapshot(`B${i}`)));
  await flush(); const waitingSnapshot = issue(snapshot("NEXT")); const waitingMain = issue(foreground("MAIN"));
  blockers[0].controller.abort(); await flush();
  expect(sent[6].query.pid).toBe("MAIN");
  sent[6].finish(); await waitingMain.promise; await flush();
  expect(sent[7].query.pid).toBe("NEXT");
  sent.forEach(item => item.finish()); await Promise.all(blockers.map(job => job.promise.catch(error => error))); await waitingSnapshot.promise;
  globalThis.fetch = (async () => Response.json({ success: false, error: { code: "PID_ACCESS_DENIED", message: "无权访问", requestId: "isolated-denied" } }, { status: 403 })) as typeof fetch;
  await expect(issue(foreground("DENIED")).promise).rejects.toMatchObject({ code: "PID_ACCESS_DENIED", status: 403, kind: "forbidden" });
  globalThis.fetch = (async () => Response.json(body(foreground("RECOVERED")))) as typeof fetch;
  expect((await issue(foreground("RECOVERED")).promise).data.query.pid).toBe("RECOVERED");
});

for (const failure of ["json_parse", "success_schema", "query_match"] as const) test(`${failure}失败释放共享槽，后续合法平台仍能完成`, async () => {
  const sent = holdFetch(); const blockers = Array.from({ length: 6 }, (_, i) => issue(foreground(`B${i}`)));
  await flush(); const failed = issue(foreground("BAD")), next = issue(foreground("AFTER"));
  const issued: string[] = [];
  globalThis.fetch = (async (_path, init) => {
    const query = JSON.parse(String(init?.body)) as DailyDashboardQuery; issued.push(query.pid);
    if (query.pid !== "BAD") return Response.json(body(query));
    if (failure === "json_parse") return new Response("{", { status: 200 });
    if (failure === "success_schema") return Response.json({ success: true, data: {} });
    return Response.json(body(foreground("OTHER")));
  }) as typeof fetch;
  sent[0].finish();
  await expect(failed.promise).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE", status: 200 });
  expect((await next.promise).data.query.pid).toBe("AFTER"); expect(issued).toEqual(["BAD", "AFTER"]);
  sent.forEach(item => item.finish()); await Promise.all(blockers.map(job => job.promise));
});

test("排队中的401在收到响应头后仍立即通知，不等待正文完成", async () => {
  const target = new EventTarget(); let notifications = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  target.addEventListener(V2_AUTHENTICATION_REQUIRED_EVENT, () => notifications++);
  let finish!: () => void;
  globalThis.fetch = (async () => {
    const response = new Response("", { status: 401 });
    Object.defineProperty(response, "json", { value: () => new Promise(resolve => {
      finish = () => resolve({ success: false, error: { code: "AUTHENTICATION_REQUIRED", message: "需要登录", requestId: "isolated-auth" } });
      cleanups.push(finish);
    }) });
    return response;
  }) as typeof fetch;
  const pending = issue(foreground("AUTH")); await flush();
  expect(notifications).toBe(1); finish();
  await expect(pending.promise).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED", status: 401 });
  expect(notifications).toBe(1);
});
