import { afterEach, expect, test } from "bun:test";
import * as React from "react";
import type { DailyDashboardQuery, DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, OPERATING_SNAPSHOT_STATISTICS_REASON, operatingSnapshotDates } from "../../../contracts/operating-detail-projection";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { currentDataEnvironmentPreference, setDataEnvironmentPreference } from "../api/dataEnvironmentPreference";
import { useCohortReading } from "./ConnectedCohorts";
import { useOperatingLive } from "./useOperatingLive";
import { useOperatingResources } from "./useOperatingLive";
import { useDailyBoardResource, useDailyBoardResources } from "../features/dashboards/useDailyBoardResources";
import { V2RequestError } from "../api/client";
import { dailyDashboardEnvironment } from "../api/daily-dashboard-environment";

// The project has no DOM test runtime. This test-only dispatcher runs the real
// hooks and effects, including cleanup, without mocking resources or using a browser.
function hook<T>(read: () => T) {
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: any[] = [];
  let index = 0, queued = false, mounted = true, value: T;
  let effects: (() => void)[] = [];
  const changed = (left: unknown[] | undefined, right: unknown[] | undefined) => !left || !right || left.length !== right.length || left.some((item, i) => !Object.is(item, right[i]));
  const schedule = () => {
    if (queued || !mounted) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (mounted) render(); });
  };
  const dispatcher = {
    useState(initial: any) {
      const i = index++;
      if (!slots[i]) slots[i] = { value: typeof initial === "function" ? initial() : initial };
      slots[i].set ??= (next: any) => {
        const result = typeof next === "function" ? next(slots[i].value) : next;
        if (!Object.is(result, slots[i].value)) { slots[i].value = result; schedule(); }
      };
      return [slots[i].value, slots[i].set];
    },
    useRef(initial: unknown) { const i = index++; return slots[i] ??= { current: initial }; },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const i = index++, prior = slots[i];
      if (!prior || changed(prior.deps, deps)) {
        slots[i] = { deps, cleanup: prior?.cleanup };
        effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = effect(); });
      }
    },
    useCallback(callback: unknown, deps?: unknown[]) {
      const i = index++;
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, callback };
      return slots[i].callback;
    },
    useMemo(calculate: () => unknown, deps?: unknown[]) {
      const i = index++;
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: calculate() };
      return slots[i].value;
    }
  };
  function render() {
    index = 0;
    const prior = internals.H;
    internals.H = dispatcher;
    try { value = read(); } finally { internals.H = prior; }
    const pending = effects; effects = [];
    for (const effect of pending) effect();
    return value;
  }
  const result = { render, get value() { return value; }, dispose() { mounted = false; slots.forEach(slot => slot?.cleanup?.()); } };
  disposals.push(result.dispose);
  render();
  return result;
}

const disposals: (() => void)[] = [];
const requestCleanups = new Set<() => void>();
const originalFetch = globalThis.fetch;
const originalEnvironment = currentDataEnvironmentPreference();
afterEach(async () => {
  disposals.splice(0).forEach(dispose => dispose());
  requestCleanups.forEach(cleanup => cleanup());
  await flush();
  globalThis.fetch = originalFetch;
  setDataEnvironmentPreference(originalEnvironment);
});
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const day = (date: string, offset: number) => new Date(Date.parse(date) + offset * 86400000).toISOString().slice(0, 10);
function payload(query: DailyDashboardQuery, numerator = 8): DailyDashboardSuccess {
  if (query.projection === "operating_snapshot") return { success: true, data: {
    schemaVersion: "day-dashboard/v2", query, queryId: `${query.pid}:${numerator}`, fetchedAt: "2026-10-10T00:00:00Z",
    timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"],
    series: OPERATING_METRIC_IDS.map(id => ({
      metric: { id, name: id, unit: "%", definition: "生命周期测试定义", authorityVersion: "test-v1", referenceMetricId: id,
        sourceNote: "隔离生命周期测试", formula: "测试分子 / 测试分母", inputs: [{ key: "numerator", name: "测试分子", unit: "人" }, { key: "denominator", name: "测试分母", unit: "人" }] },
      points: operatingSnapshotDates(query.dateRange).map(date => ({ date, state: "available", sourceStatus: "READY", value: numerator / 10,
        inputs: [{ key: "numerator", value: numerator }, { key: "denominator", value: 10 }] })),
      periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: query.dateRange, dayCount: 8, state: "unsupported", values: [], reason: OPERATING_SNAPSHOT_STATISTICS_REASON }
    }))
  } };
  return { success: true, data: { schemaVersion: "day-dashboard/v1", query, queryId: `${query.pid}:${numerator}`, fetchedAt: "2026-10-10T00:00:00Z",
    timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"],
    series: [{ metric: { id: "M020", name: "注册用户D1留存率", unit: "%", definition: "测试定义", authorityVersion: "test-v1", referenceMetricId: "M020",
      sourceNote: "隔离测试", formula: "回访人数 / 注册人数", inputs: [{ key: "returned", name: "回访人数", unit: "人" }, { key: "registered", name: "注册人数", unit: "人" }] },
      points: Array.from({ length: (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1 }, (_, i) => ({
        date: day(query.dateRange[0], i), state: "available", sourceStatus: "READY", value: numerator / 10,
        inputs: [{ key: "returned", value: numerator }, { key: "registered", value: 10 }]
      })) }] } };
}
function reading(): LiveDashboardReading {
  const query: DailyDashboardQuery = { boardId: "5.8", pid: "PH", dateRange: ["2020-01-10", "2020-01-10"] };
  return { query, metricIds: ["M020"], state: { status: "loading" }, platformName: "PH", platforms: [{ pid: "PH", name: "PH" }, { pid: "TT", name: "TT" }],
    comparison: { label: "上一等长周期", query: { ...query, dateRange: ["2020-01-09", "2020-01-09"] }, state: { status: "loading" } },
    refreshRevision: 0, retry() {}, canExport: true,
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}
function requests({ ignoreAbort = false }: { ignoreAbort?: boolean } = {}) {
  const pending: { query: DailyDashboardQuery; signal: AbortSignal; succeed: (value?: number) => void; fail: () => void }[] = [];
  globalThis.fetch = (async (url, options) => {
    expect(url).toBe("/api/bi/v2/queries/dashboards/daily-reading");
    const query = JSON.parse(String(options!.body)) as DailyDashboardQuery;
    const signal = options!.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        requestCleanups.delete(cleanup);
        complete();
      };
      const abort = () => settle(() => reject(signal.reason));
      const cleanup = () => settle(() => reject(signal.reason ?? new DOMException("Test request disposed", "AbortError")));
      requestCleanups.add(cleanup);
      if (!ignoreAbort) {
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
      }
      pending.push({ query, signal,
        succeed: (value = 8) => settle(() => resolve(Response.json(payload(query, value)))),
        fail: () => settle(() => reject(new Error("isolated timeout")))
      });
    });
  }) as typeof fetch;
  return pending;
}
async function completeReads(pending: ReturnType<typeof requests>, start: number, values: readonly (number | "failure")[]) {
  for (const [offset, value] of values.entries()) {
    await flush();
    const index = start + offset;
    expect(pending.length).toBeGreaterThan(index);
    if (value === "failure") pending[index].fail();
    else pending[index].succeed(value);
    await flush();
  }
}
const success = (query: DailyDashboardQuery, value = 8) => ({ status: "success" as const, data: payload(query, value), refreshing: false, refreshError: null });
const range = { start: "2020-01-01", end: "2020-01-01" };

function stableBoard(live: LiveDashboardReading, compared: boolean) {
  const daily = useDailyBoardResources(live.query, ["M020"], compared);
  const state = daily.current.state;
  const reading: LiveDashboardReading = { ...live, state: state.status === "success"
    ? state.data ? { ...state, data: state.data } : { status: "loading" } : state,
    dataEnvironment: state.status === "success" ? dailyDashboardEnvironment(state.data) : undefined };
  return { daily, reading, operating: useOperatingResources(reading) };
}

test("稳定日板数据容器在展示重挂与PID/开始日/对比切换时复用20份快照，显式刷新重读", async () => {
  let live: LiveDashboardReading = { ...reading(), query: { ...reading().query, boardId: "5.2" }, metricIds: OPERATING_METRIC_IDS,
    platforms: ["PH", "TT", ...Array.from({ length: 18 }, (_, index) => `QA${index + 1}`)].map(pid => ({ pid, name: pid })) };
  let compared = false;
  const pending = requests(), container = hook(() => stableBoard(live, compared));
  const finish = async (count: number) => {
    for (let i = 0; i < 50 && pending.length < count; i++) { pending.forEach(item => item.succeed()); await flush(); }
    pending.forEach(item => item.succeed()); await flush(); expect(pending).toHaveLength(count);
  };
  await finish(21);
  let presentation = hook(() => useOperatingLive(container.value.reading, "all", container.value.operating));
  expect(presentation.value.columns).toHaveLength(93);
  expect(presentation.value.rows).toHaveLength(20);
  const current = container.value.daily.current.state;
  compared = true; container.render(); await finish(23);
  expect(container.value.daily.current.state).toBe(current);
  expect(pending.filter(item => !item.query.projection).map(item => item.query.dateRange)).toEqual([
    ["2020-01-10", "2020-01-10"], ["2020-01-09", "2020-01-09"], ["2020-01-03", "2020-01-03"]
  ]);
  compared = false; container.render(); await flush();
  expect(pending).toHaveLength(23);
  expect(container.value.daily.current.state).toBe(current);
  for (const query of [
    { ...live.query, pid: "TT" },
    { ...live.query, pid: "TT", dateRange: ["2020-01-04", "2020-01-10"] as [string, string] }
  ]) {
    live = { ...live, query };
    const before = pending.length;
    expect(container.render().daily.current.state.status).toBe("loading");
    await finish(before + 1);
    presentation.dispose();
    presentation = hook(() => useOperatingLive(container.value.reading, "all", container.value.operating));
    await flush();
    expect(pending.filter(item => item.query.projection)).toHaveLength(20);
    expect(presentation.value.rows).toHaveLength(20);
    expect(presentation.value.columns).toHaveLength(93);
  }
  live = { ...live, refreshRevision: 1 };
  container.value.daily.current.retry(); container.value.daily.previous.retry(); container.render();
  await finish(46);
  expect(pending.filter(item => item.query.projection)).toHaveLength(40);
  expect(new Set(pending.filter(item => item.query.projection).map(item => JSON.stringify(item.query))).size).toBe(20);
});

test("日板同scope刷新保留旧结果及完整错误诊断，scope变化在effect前隐藏旧状态并隔离迟到结果", async () => {
  let key = "first";
  const pending: { key: string; signal: AbortSignal; resolve: (value: string) => void; reject: (error: unknown) => void }[] = [];
  const container = hook(() => useDailyBoardResource(key, signal => new Promise<string>((resolve, reject) => pending.push({ key, signal, resolve, reject }))));
  pending[0].resolve("first-result"); await flush();
  container.value.retry(); await flush();
  expect(container.value.state).toMatchObject({ status: "success", data: "first-result", refreshing: true });
  pending[1].reject(new V2RequestError("来源拒绝", { kind: "error", code: "UPSTREAM_REJECTED", status: 502, requestId: "scoped-request", upstreamBusinessCode: 400, upstreamHttpStatus: 200 }));
  await flush();
  expect(container.value.state).toMatchObject({ status: "success", data: "first-result", refreshing: false,
    refreshError: { message: "来源拒绝", code: "UPSTREAM_REJECTED", requestId: "scoped-request", upstreamBusinessCode: 400, upstreamHttpStatus: 200 } });
  container.value.retry(); await flush();
  key = "second";
  expect(container.render().state).toEqual({ status: "loading" });
  expect(pending[2].signal.aborted).toBe(true);
  pending[3].resolve("second-result"); await flush();
  pending[2].resolve("late-first-result"); await flush();
  expect(container.value.state).toEqual({ status: "success", data: "second-result", refreshing: false, refreshError: null });
});

for (const scope of ["environment", "account"] as const) test(`稳定数据容器的${scope}作用域卸载清空主值和经营旧值并隔离旧请求`, async () => {
  let live = { ...reading(), query: { ...reading().query, boardId: "5.2" }, metricIds: OPERATING_METRIC_IDS };
  const pending = requests({ ignoreAbort: true });
  let container = hook(() => stableBoard(live, false));
  await completeReads(pending, 0, [8, 8, 8]);
  let presentation = hook(() => useOperatingLive(container.value.reading, "all", container.value.operating));
  expect(presentation.value.rows!.some(row => row.values.some(value => value.current !== null))).toBe(true);
  live = { ...live, refreshRevision: 1 }; container.value.daily.current.retry(); container.render(); await flush();
  expect(pending).toHaveLength(4);
  container.dispose(); presentation.dispose();
  if (scope === "environment") setDataEnvironmentPreference("test");
  live = { ...live, refreshRevision: 0 };
  container = hook(() => stableBoard(live, false));
  presentation = hook(() => useOperatingLive(container.value.reading, "all", container.value.operating));
  expect(container.value.daily.current.state.status).toBe("loading");
  expect(presentation.value.rows!.every(row => row.values.every(value => value.current === null))).toBe(true);
  await flush();
  expect(pending[3].signal.aborted).toBe(true);
  expect(pending).toHaveLength(4); // queued old snapshots were cancelled without HTTP
  pending[3].succeed(9); await flush();
  expect(container.value.daily.current.state.status).toBe("loading");
  presentation.render();
  expect(presentation.value.rows!.every(row => row.values.every(value => value.current === null))).toBe(true);
  await completeReads(pending, 4, [4, 4, 4]); presentation.render();
  expect(container.value.daily.current.state.status).toBe("success");
  expect(presentation.value.rows!.some(row => row.values.some(value => value.current === .4))).toBe(true);
});

for (const change of ["date", "ordered-pids", "test-groups"] as const) test(`经营${change}变更在effect前隐藏旧失败诊断和旧进度`, async () => {
  if (change === "test-groups") setDataEnvironmentPreference("test");
  let live: LiveDashboardReading = { ...reading(), query: { ...reading().query, boardId: "5.2" },
    ...(change === "test-groups" ? { operatingAsyncPidGroups: [["PH"], ["TT"]] } : {}) };
  let requestId = "old-scope-failure";
  globalThis.fetch = (async () => Response.json({ success: false,
    error: { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "身份暂不可用", requestId } }, { status: 503 })) as typeof fetch;
  const container = hook(() => useOperatingResources(live));
  await flush();
  expect(container.value.resources.PH).toMatchObject({ status: "failure", requestId: "old-scope-failure" });
  requestId = "new-scope-failure";
  live = change === "date" ? { ...live, query: { ...live.query, dateRange: ["2020-01-11", "2020-01-11"] } }
    : change === "ordered-pids" ? { ...live, platforms: [...live.platforms!].reverse() }
    : { ...live, operatingAsyncPidGroups: [["PH", "TT"]] };
  const firstRender = container.render();
  expect(firstRender.resources).toEqual({ PH: { status: "loading" }, TT: { status: "loading" } });
  expect(firstRender.progress).toBeNull();
  await flush();
  expect(container.value.resources.PH).toMatchObject({ status: "failure", requestId: "new-scope-failure" });
});

test("独立注册两期初次查询及整页重试不等待主查询成功", async () => {
  let live = reading();
  const pending = requests(), rendered = hook(() => useCohortReading(live, range)!);
  await Promise.resolve();
  expect(pending).toHaveLength(1);
  await completeReads(pending, 0, ["failure", "failure"]);
  expect(pending.map(item => item.query.dateRange)).toEqual([["2020-01-01", "2020-01-01"], ["2019-12-31", "2019-12-31"]]);
  expect(rendered.value.state.status).toBe("failure");
  live = { ...live, state: { status: "failure", kind: "error", code: "TIMEOUT", message: "主查询失败" }, refreshRevision: 1 };
  rendered.render(); await flush();
  expect(pending).toHaveLength(3);
  await completeReads(pending, 2, [7, 6]);
  expect(rendered.value.state).toMatchObject({ status: "success", data: { data: { series: [{ points: [{ value: .7 }] }] } } });
  expect(rendered.value.comparison!.state).toMatchObject({ status: "success", data: { data: { series: [{ points: [{ value: .6 }] }] } } });
});

test("同范围刷新失败保留两期旧值，主查询新结果不触发额外请求", async () => {
  let live = reading();
  const pending = requests(), rendered = hook(() => useCohortReading(live, range)!);
  await Promise.resolve();
  await completeReads(pending, 0, [8, 8]);
  live = { ...live, refreshRevision: 1, state: success(live.query, 9) }; rendered.render(); await flush();
  expect(pending).toHaveLength(3);
  expect(rendered.value.state).toMatchObject({ status: "success", refreshing: true });
  await completeReads(pending, 2, ["failure", "failure"]);
  expect(rendered.value.state).toMatchObject({ status: "success", refreshing: false, refreshError: { code: "NETWORK_ERROR" }, data: { data: { series: [{ points: [{ value: .8 }] }] } } });
  expect(rendered.value.comparison!.state).toMatchObject({ status: "success", refreshError: { code: "NETWORK_ERROR" } });
  live = { ...live, state: success(live.query, 3) }; rendered.render(); await flush();
  expect(pending).toHaveLength(4);
  rendered.value.retry(); await flush();
  expect(pending).toHaveLength(5);
  await completeReads(pending, 4, [8, 8]);
  expect(pending).toHaveLength(6);
});

test("主查询刷新失败保留相同queryId时，独立两期仍按整页刷新信号重试", async () => {
  let live = reading();
  const main = success(live.query);
  live = { ...live, state: main };
  const pending = requests(), rendered = hook(() => useCohortReading(live, range)!);
  await Promise.resolve();
  await completeReads(pending, 0, ["failure", "failure"]);
  live = { ...live, refreshRevision: 1, state: { ...main, refreshing: true } };
  rendered.render(); await flush();
  expect(pending).toHaveLength(3);
  live = { ...live, state: { ...main, refreshError: { code: "TIMEOUT", message: "主查询刷新失败" } } };
  rendered.render(); await flush();
  await completeReads(pending, 2, [9, 7]);
  expect(pending).toHaveLength(4);
  expect(rendered.value.state).toMatchObject({ status: "success", data: { data: { series: [{ points: [{ value: .9 }] }] } } });
  expect(rendered.value.comparison!.state).toMatchObject({ status: "success", data: { data: { series: [{ points: [{ value: .7 }] }] } } });
});

test("注册期等于主范围时复用主请求，转为独立范围时只请求对应两期", async () => {
  let live = reading(), selected = { start: live.query.dateRange[0], end: live.query.dateRange[1] };
  const pending = requests(), rendered = hook(() => useCohortReading(live, selected));
  expect(rendered.value).toBe(live); await flush();
  live = { ...live, refreshRevision: 1 }; rendered.render(); await flush();
  expect(pending).toHaveLength(0);
  // Only the parent range changes: the previously reused registration query
  // must now load even though its own PID and date did not change.
  live = { ...live, query: { ...live.query, dateRange: ["2020-01-11", "2020-01-11"] } };
  rendered.render(); await flush();
  expect(pending).toHaveLength(1);
  selected = { start: "2020-01-11", end: "2020-01-11" }; rendered.render(); await flush();
  expect(rendered.value).toBe(live);
  expect(pending.every(item => item.signal.aborted)).toBe(true);
  expect(pending).toHaveLength(1); // comparison cancelled while queued, without HTTP
});

test("PID/注册日期切换立即屏蔽旧值并隔离迟到响应", async () => {
  let live = reading(), selected = range;
  const pending = requests({ ignoreAbort: true }), rendered = hook(() => useCohortReading(live, selected)!);
  await Promise.resolve();
  await completeReads(pending, 0, [8, 8]);
  rendered.value.retry(); await flush();
  live = { ...live, query: { ...live.query, pid: "TT" }, refreshRevision: 1 };
  selected = { start: "2020-01-02", end: "2020-01-02" };
  expect(rendered.render().state.status).toBe("loading"); await flush();
  expect(pending).toHaveLength(3); // Old queued comparison never starts after scope cancellation.
  expect(pending[2].signal.aborted).toBe(true);
  pending[2].succeed(9); await flush();
  await completeReads(pending, 3, [4, 3]);
  expect(pending).toHaveLength(5); // Key change plus page refresh does not duplicate the new pair.
  pending[2].succeed(9); await flush();
  expect(rendered.value.state).toMatchObject({ status: "success", data: { data: { query: { pid: "TT", dateRange: ["2020-01-02", "2020-01-02"] }, series: [{ points: [{ value: .4 }] }] } } });
});

test("独立注册期启用对比只补比较请求，关闭时取消比较不重查当前期", async () => {
  let live = { ...reading(), comparison: undefined } as LiveDashboardReading;
  const pending = requests(), rendered = hook(() => useCohortReading(live, range)!);
  await Promise.resolve();
  expect(pending).toHaveLength(1); pending[0].succeed(); await flush();
  live = { ...live, comparison: reading().comparison }; rendered.render(); await flush();
  expect(pending).toHaveLength(2);
  live = { ...live, comparison: undefined }; rendered.render(); await flush();
  expect(pending[1].signal.aborted).toBe(true); expect(pending).toHaveLength(2);
  expect(rendered.value.state.status).toBe("success");
});

test("经营分PID独立读取与刷新，主查询失败不阻止恢复且单组失败保留旧值", async () => {
  let live = { ...reading(), query: { ...reading().query, boardId: "5.2" } };
  const pending = requests(), rendered = hook(() => useOperatingLive(live));
  await Promise.resolve();
  expect(pending.map(item => item.query.pid)).toEqual(["PH"]);
  await completeReads(pending, 0, [8, 8]);
  expect(pending.map(item => item.query.pid)).toEqual(["PH", "TT"]);
  expect(pending.every(item => item.query.projection === "operating_snapshot")).toBe(true);
  expect(pending.map(item => item.query.dateRange)).toEqual([["2020-01-03", "2020-01-10"], ["2020-01-03", "2020-01-10"]]);
  const initial = rendered.value.resources.PH;
  expect(initial.status).toBe("success");
  if (initial.status === "success") {
    expect(initial.data.data.series.map(series => series.metric.id)).toEqual(OPERATING_METRIC_IDS);
    expect(initial.data.data.series[0].points.map(point => point.date)).toEqual(["2020-01-03", "2020-01-09", "2020-01-10"]);
  }
  live = { ...live, refreshRevision: 1, state: { status: "failure", kind: "error", code: "TIMEOUT", message: "主查询失败" } };
  rendered.render(); await flush(); expect(pending).toHaveLength(3);
  await completeReads(pending, 2, ["failure", 4]);
  expect(rendered.value.resources.PH).toMatchObject({ status: "success", refreshError: { code: "OPERATING_READ_FAILED" } });
  expect(rendered.value.resources.TT).toMatchObject({ status: "success", refreshError: null });
  const tt = rendered.value.resources.TT;
  expect(tt.status === "success" && tt.data.data.series[0].points.every(point => point.value === .4)).toBe(true);
  live = { ...live, state: success(live.query, 6) }; rendered.render(); await flush();
  expect(pending).toHaveLength(4);
});

test("经营日期切换不显示旧日值，旧请求迟到不能覆盖新日期", async () => {
  let live = { ...reading(), query: { ...reading().query, boardId: "5.2" } };
  const pending = requests({ ignoreAbort: true }), rendered = hook(() => useOperatingLive(live));
  await Promise.resolve();
  await completeReads(pending, 0, [8, 8]);
  live = { ...live, refreshRevision: 1 }; rendered.render(); await flush();
  live = { ...live, query: { ...live.query, dateRange: ["2020-01-11", "2020-01-11"] } };
  expect(rendered.render().rows!.every(row => row.values.every(value => value.current === null))).toBe(true); await flush();
  expect(pending).toHaveLength(3); expect(pending[2].signal.aborted).toBe(true);
  pending[2].succeed(9); await flush();
  await completeReads(pending, 3, [4, 3]);
  expect(pending).toHaveLength(5);
  pending[2].succeed(9); await flush();
  expect(rendered.value.resources.PH).toMatchObject({ status: "success", data: { data: { query: { dateRange: ["2020-01-04", "2020-01-11"] } } } });
  const ph = rendered.value.resources.PH;
  expect(ph.status === "success" && ph.data.data.series[0].points.every(point => point.value === .4)).toBe(true);
});

test("经营20PID快照逐平台串行，退出时取消在途且不继续启动后续平台", async () => {
  const live: LiveDashboardReading = { ...reading(), query: { ...reading().query, boardId: "5.2" }, metricIds: [...OPERATING_METRIC_IDS],
    platforms: Array.from({ length: 20 }, (_, index) => ({ pid: `QA${index + 1}`, name: `隔离平台${index + 1}` })) };
  const pending = requests(), rendered = hook(() => useOperatingLive(live));
  await Promise.resolve();
  expect(pending.map(item => item.query.pid)).toEqual(["QA1"]);
  pending[0].succeed(); await flush();
  expect(pending.map(item => item.query.pid)).toEqual(["QA1", "QA2"]);
  pending[1].fail(); await flush();
  expect(pending.map(item => item.query.pid)).toEqual(["QA1", "QA2", "QA3"]);
  expect(pending.every(item => item.query.projection === "operating_snapshot")).toBe(true);
  expect(rendered.value.resources.QA1.status).toBe("success");
  expect(rendered.value.resources.QA2.status).toBe("failure");
  rendered.dispose();
  expect(pending.every(item => item.signal.aborted)).toBe(true);
  pending.slice(2).forEach(item => item.succeed(4)); await flush();
  expect(pending).toHaveLength(3);
});

test("经营快照展示名称和主指标列表变化保留在途队列，20PID各读取一次", async () => {
  let live: LiveDashboardReading = { ...reading(), query: { ...reading().query, boardId: "5.2" }, metricIds: [...OPERATING_METRIC_IDS],
    platforms: Array.from({ length: 20 }, (_, index) => ({ pid: `QA${index + 1}`, name: `隔离平台${index + 1}` })) };
  let selected = "all";
  const pending = requests(), rendered = hook(() => useOperatingLive(live, selected));
  await Promise.resolve();
  expect(pending).toHaveLength(1);
  live = { ...live, platforms: live.platforms!.map(platform => ({ ...platform, name: platform.name + "更新" })) };
  rendered.render(); await flush();
  expect(pending).toHaveLength(1);
  expect(pending.every(item => !item.signal.aborted)).toBe(true);
  expect(rendered.value.rows!.map(row => row.name)).toEqual(live.platforms!.map(platform => platform.name));
  live = { ...live, metricIds: [...live.metricIds, "M098"] };
  rendered.render(); await flush();
  expect(pending).toHaveLength(1);
  selected = "QA1";
  rendered.render(); await flush();
  expect(pending).toHaveLength(1);
  for (let completed = 0; completed < 20; completed++) {
    expect(pending.length - completed).toBe(1);
    pending[completed].succeed(); await flush();
  }
  expect(pending.map(item => item.query.pid)).toEqual(live.platforms!.map(platform => platform.pid));
  expect(pending).toHaveLength(20);
  expect(pending.every(item => !item.signal.aborted)).toBe(true);
  expect(pending.every(item => item.query.projection === "operating_snapshot" && item.query.dateRange.join() === "2020-01-03,2020-01-10")).toBe(true);
  for (const resource of Object.values(rendered.value.resources)) {
    expect(resource.status).toBe("success");
    if (resource.status === "success") {
      expect(resource.data.data.series.map(series => series.metric.id)).toEqual(OPERATING_METRIC_IDS);
      expect(resource.data.data.series[0].points.map(point => point.date)).toEqual(["2020-01-03", "2020-01-09", "2020-01-10"]);
    }
  }
});

test("经营有序PID范围切换取消旧队列，退出真实读取停止并隔离迟到结果", async () => {
  const initial: LiveDashboardReading = { ...reading(), query: { ...reading().query, boardId: "5.2" }, metricIds: [...OPERATING_METRIC_IDS],
    platforms: Array.from({ length: 20 }, (_, index) => ({ pid: `QA${index + 1}`, name: `隔离平台${index + 1}` })) };
  let live: LiveDashboardReading | null = initial;
  const pending = requests({ ignoreAbort: true }), rendered = hook(() => useOperatingLive(live));
  await Promise.resolve();
  expect(pending.map(item => item.query.pid)).toEqual(["QA1"]);
  live = { ...initial, platforms: [...initial.platforms!].reverse() };
  rendered.render(); await flush();
  expect(pending[0].signal.aborted).toBe(true);
  expect(pending).toHaveLength(1);
  pending[0].succeed(4); await flush();
  expect(pending.slice(1).map(item => item.query.pid)).toEqual(["QA20"]);
  live = { ...live, platforms: live.platforms!.slice(1) };
  rendered.render(); await flush();
  expect(pending[1].signal.aborted).toBe(true);
  expect(pending).toHaveLength(2);
  pending[1].succeed(4); await flush();
  expect(pending.slice(2).map(item => item.query.pid)).toEqual(["QA19"]);
  live = null;
  expect(rendered.render().rows).toBeNull(); await flush();
  expect(pending.every(item => item.signal.aborted)).toBe(true);
  pending.forEach(item => item.succeed(4)); await flush();
  expect(rendered.value.rows).toBeNull();
  expect(pending).toHaveLength(3);
});

for (const status of ["loading", "failure"] as const) test(`页头${status}明确正式环境时，经营刷新失败不保留测试环境旧结果`, async () => {
  setDataEnvironmentPreference("test");
  let live: LiveDashboardReading = { ...reading(), query: { ...reading().query, boardId: "5.2" }, dataEnvironment: "test" };
  const pending = requests(), rendered = hook(() => useOperatingLive(live));
  await Promise.resolve();
  await completeReads(pending, 0, [8, 8]);
  expect(rendered.value.resources.PH.status).toBe("success");
  setDataEnvironmentPreference("production");
  live = { ...live, dataEnvironment: "production", refreshRevision: 1, state: status === "loading" ? { status }
    : { status, kind: "error", code: "TIMEOUT", message: "正式主查询失败" } };
  rendered.render(); await flush();
  expect(pending).toHaveLength(3);
  expect(rendered.value.resources.PH.status).toBe("loading");
  expect(rendered.value.rows!.every(row => row.values.every(value => value.current === null))).toBe(true);
  await completeReads(pending, 2, ["failure", "failure"]);
  expect(rendered.value.resources.PH).toMatchObject({ status: "failure", code: "OPERATING_READ_FAILED" });
  expect(rendered.value.resources.TT.status).toBe("failure");
  expect(rendered.value.rows!.every(row => row.values.every(value => value.current === null))).toBe(true);
});
