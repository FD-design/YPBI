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
function body(query: DailyDashboardQuery, metricIds: readonly string[] = ids(query)): DailyDashboardSuccess {
  const dates = query.projection ? operatingSnapshotDates(query.dateRange) : [query.dateRange[1]];
  return { success: true, data: {
    schemaVersion: query.projection ? "day-dashboard/v2" : "day-dashboard/v1", query: structuredClone(query), queryId: "isolated-scheduling",
    fetchedAt: "2026-10-14T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"],
    series: metricIds.map(id => ({ metric: { id, name: id, unit: "%", definition: "隔离调度样例", authorityVersion: "isolated", formula: "分子 / 分母", referenceMetricId: id, sourceNote: "仅测试", inputs: [{ key: "n", name: "分子", unit: "人" }, { key: "d", name: "分母", unit: "人" }] },
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
async function completeHeld(sent: ReturnType<typeof holdFetch>, total: number) {
  for (let index = 0; index < total; index++) {
    await flush(); expect(sent.length).toBeGreaterThan(index);
    sent[index].finish();
  }
  await flush();
}
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort());
  cleanups.splice(0).forEach(finish => finish());
  await Promise.allSettled(requests.splice(0));
  globalThis.fetch = originalFetch; setDataEnvironmentPreference(originalEnvironment);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("20个平台93列与121系列主板共用串行容量，完整正文结算后才发下一项", async () => {
  // The isolated series fixture tests the existing 121/93 transport cardinalities,
  // not metric authority or source mapping, which remain service-contract tests.
  const mainIds = Array.from({ length: 121 }, (_, index) => `series-${index}`);
  const mainQuery: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2020-01-10", "2020-01-10"] };
  let active = 0, peak = 0;
  const sent: { query: DailyDashboardQuery; headers: () => void; body: () => void }[] = [];
  globalThis.fetch = (async (_path, init) => {
    const query = JSON.parse(String(init?.body)) as DailyDashboardQuery;
    active++; peak = Math.max(peak, active);
    return new Promise<Response>((resolve, reject) => {
      let settled = false, finishBody!: (value: unknown) => void;
      const settle = () => { if (!settled) { settled = true; active--; init?.signal?.removeEventListener("abort", cancel); } };
      const cancel = () => { settle(); finishBody?.(null); reject(init?.signal?.reason); };
      init?.signal?.addEventListener("abort", cancel, { once: true });
      const payload = body(query, query.projection ? OPERATING_METRIC_IDS : mainIds);
      const index = sent.filter(item => item.query.projection).length;
      if (query.projection && index < 2) for (const series of payload.data.series) for (const point of series.points) {
        point.sourceStatus = index ? "SOURCE_INCOMPLETE" : "PROCESSING"; point.state = "no_value"; point.value = null;
      }
      const response = new Response("", { status: 200 });
      Object.defineProperty(response, "json", { value: () => new Promise(resolveBody => { finishBody = resolveBody; }) });
      const headers = () => resolve(response);
      const finish = () => { if (!settled) { settle(); finishBody?.(payload); } };
      cleanups.push(() => { headers(); finish(); });
      sent.push({ query, headers, body: finish });
    });
  }) as typeof fetch;
  const snapshots = Array.from({ length: 20 }, (_, index) => issue(snapshot(`S${index}`)));
  const main = issue(mainQuery, mainIds);
  await flush(); expect(sent).toHaveLength(1); expect(sent[0].query).toEqual(mainQuery);
  for (let index = 0; index < 21; index++) {
    expect(sent).toHaveLength(index + 1);
    sent[index].headers(); await flush();
    expect(sent).toHaveLength(index + 1); // headers alone do not release the slot
    sent[index].body(); await flush();
  }
  const results = await Promise.all(snapshots.map(job => job.promise));
  expect((await main.promise).data.series).toHaveLength(121);
  expect(results.every(result => result.data.series.length === 93)).toBe(true);
  expect(results[0].data.series[0].points[0]).toMatchObject({ value: null, sourceStatus: "PROCESSING", state: "no_value" });
  expect(results[1].data.series[0].points[0]).toMatchObject({ value: null, sourceStatus: "SOURCE_INCOMPLETE", state: "no_value" });
  expect(sent.slice(1).map(item => item.query.pid)).toEqual(Array.from({ length: 20 }, (_, index) => `S${index}`));
  expect(peak).toBe(1); expect(active).toBe(0);
});

test("主查询与经营快照共用一个槽，同批主查询先启动", async () => {
  const sent = holdFetch();
  const jobs = Array.from({ length: 6 }, (_, i) => issue(snapshot(`S${i}`)));
  const main = issue(foreground("PH"));
  await flush();
  expect(sent).toHaveLength(1);
  expect(sent[0].query).toEqual(foreground("PH"));
  sent[0].finish(); await main.promise; await flush();
  expect(sent).toHaveLength(2); expect(sent[1].query.pid).toBe("S0");
  await completeHeld(sent, 7);
  expect(sent.slice(1).map(item => item.query.pid)).toEqual(["S0", "S1", "S2", "S3", "S4", "S5"]);
  const results = await Promise.all(jobs.map(job => job.promise));
  expect(results.every(result => result.data.series.length === OPERATING_METRIC_IDS.length)).toBe(true);
  expect(results.every(result => result.data.series.every(series => series.points.every(point => point.value === 0 && point.sourceStatus === "READY")))).toBe(true);
});

test("排队时冻结环境、请求范围及期望指标，后续偏好变化不改写结果", async () => {
  const sent = holdFetch(); issue(foreground("BLOCKER"));
  await flush();
  setDataEnvironmentPreference("test");
  const query = foreground("PH"), expectedIds = ["M020"], waiting = issue(query, expectedIds);
  query.pid = "OTHER"; query.dateRange[1] = "2020-01-11"; expectedIds[0] = "M001";
  setDataEnvironmentPreference("production");
  expect(sent).toHaveLength(1);
  sent[0].finish(); await flush();
  const issued = sent[1]; expect(issued.query).toEqual(foreground("PH"));
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
  const jobs = Array.from({ length: 2 }, (_, i) => issue(foreground(`J${i}`)));
  await flush(); expect(sent).toHaveLength(1); expect(finishBodies).toHaveLength(1);
  finishBodies[0](); await jobs[0].promise; await flush(); expect(sent).toHaveLength(2);
  finishBodies.forEach(finish => finish()); await Promise.all(jobs.map(job => job.promise));
});

test("排队取消不发送HTTP，取消不影响其他平台的完整响应", async () => {
  const sent = holdFetch(); const jobs = [issue(foreground("BLOCKER"))];
  await flush(); const waiting = issue(snapshot("CANCELLED")); waiting.controller.abort();
  await expect(waiting.promise).rejects.toMatchObject({ name: "AbortError" });
  sent.forEach(item => item.finish()); await Promise.all(jobs.map(job => job.promise)); await flush();
  expect(sent).toHaveLength(1); expect(sent.some(item => item.query.pid === "CANCELLED")).toBe(false);
});

test("排队后主查询优先，HTTP异常释放容量且保持原错误分类", async () => {
  const sent = holdFetch(); const blockers = [issue(snapshot("BLOCKER"))];
  await flush(); const waitingSnapshot = issue(snapshot("NEXT")); const waitingMain = issue(foreground("MAIN"));
  blockers[0].controller.abort(); await flush();
  expect(sent[1].query.pid).toBe("MAIN");
  sent[1].finish(); await waitingMain.promise; await flush();
  expect(sent[2].query.pid).toBe("NEXT");
  sent.forEach(item => item.finish()); await Promise.all(blockers.map(job => job.promise.catch(error => error))); await waitingSnapshot.promise;
  globalThis.fetch = (async () => Response.json({ success: false, error: { code: "PID_ACCESS_DENIED", message: "无权访问", requestId: "isolated-denied" } }, { status: 403 })) as typeof fetch;
  await expect(issue(foreground("DENIED")).promise).rejects.toMatchObject({ code: "PID_ACCESS_DENIED", status: 403, kind: "forbidden" });
  globalThis.fetch = (async () => Response.json(body(foreground("RECOVERED")))) as typeof fetch;
  expect((await issue(foreground("RECOVERED")).promise).data.query.pid).toBe("RECOVERED");
});

for (const failure of ["json_parse", "success_schema", "query_match"] as const) test(`${failure}失败释放共享槽，后续合法平台仍能完成`, async () => {
  const sent = holdFetch(); const blockers = [issue(foreground("BLOCKER"))];
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
