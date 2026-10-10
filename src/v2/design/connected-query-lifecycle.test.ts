import { afterEach, expect, test } from "bun:test";
import * as React from "react";
import type { DailyDashboardQuery, DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { useCohortReading } from "./ConnectedCohorts";
import { useOperatingLive } from "./useOperatingLive";

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
const originalFetch = globalThis.fetch;
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); globalThis.fetch = originalFetch; });
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const day = (date: string, offset: number) => new Date(Date.parse(date) + offset * 86400000).toISOString().slice(0, 10);
function payload(query: DailyDashboardQuery, numerator = 8): DailyDashboardSuccess {
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
function requests() {
  const pending: { query: DailyDashboardQuery; signal: AbortSignal; succeed: (value?: number) => void; fail: () => void }[] = [];
  globalThis.fetch = (async (url, options) => {
    expect(url).toBe("/api/bi/v2/queries/dashboards/daily-reading");
    const query = JSON.parse(String(options!.body)) as DailyDashboardQuery;
    return new Promise<Response>((resolve, reject) => pending.push({ query, signal: options!.signal as AbortSignal,
      succeed: (value = 8) => resolve(Response.json(payload(query, value))), fail: () => reject(new Error("isolated timeout")) }));
  }) as typeof fetch;
  return pending;
}
const success = (query: DailyDashboardQuery, value = 8) => ({ status: "success" as const, data: payload(query, value), refreshing: false, refreshError: null });
const range = { start: "2020-01-01", end: "2020-01-01" };

test("独立注册两期初次查询及整页重试不等待主查询成功", async () => {
  let live = reading();
  const pending = requests(), rendered = hook(() => useCohortReading(live, range)!);
  expect(pending.map(item => item.query.dateRange)).toEqual([["2020-01-01", "2020-01-01"], ["2019-12-31", "2019-12-31"]]);
  pending.forEach(item => item.fail()); await flush();
  expect(rendered.value.state.status).toBe("failure");
  live = { ...live, state: { status: "failure", kind: "error", code: "TIMEOUT", message: "主查询失败" }, refreshRevision: 1 };
  rendered.render(); await flush();
  expect(pending).toHaveLength(4);
  pending[2].succeed(7); pending[3].succeed(6); await flush();
  expect(rendered.value.state).toMatchObject({ status: "success", data: { data: { series: [{ points: [{ value: .7 }] }] } } });
  expect(rendered.value.comparison!.state).toMatchObject({ status: "success", data: { data: { series: [{ points: [{ value: .6 }] }] } } });
});

test("同范围刷新失败保留两期旧值，主查询新结果不触发额外请求", async () => {
  let live = reading();
  const pending = requests(), rendered = hook(() => useCohortReading(live, range)!);
  pending.forEach(item => item.succeed()); await flush();
  live = { ...live, refreshRevision: 1, state: success(live.query, 9) }; rendered.render(); await flush();
  expect(pending).toHaveLength(4);
  expect(rendered.value.state).toMatchObject({ status: "success", refreshing: true });
  pending[2].fail(); pending[3].fail(); await flush();
  expect(rendered.value.state).toMatchObject({ status: "success", refreshing: false, refreshError: { code: "NETWORK_ERROR" }, data: { data: { series: [{ points: [{ value: .8 }] }] } } });
  expect(rendered.value.comparison!.state).toMatchObject({ status: "success", refreshError: { code: "NETWORK_ERROR" } });
  live = { ...live, state: success(live.query, 3) }; rendered.render(); await flush();
  expect(pending).toHaveLength(4);
  rendered.value.retry(); await flush();
  expect(pending).toHaveLength(6);
});

test("主查询刷新失败保留相同queryId时，独立两期仍按整页刷新信号重试", async () => {
  let live = reading();
  const main = success(live.query);
  live = { ...live, state: main };
  const pending = requests(), rendered = hook(() => useCohortReading(live, range)!);
  pending.forEach(item => item.fail()); await flush();
  live = { ...live, refreshRevision: 1, state: { ...main, refreshing: true } };
  rendered.render(); await flush();
  expect(pending).toHaveLength(4);
  live = { ...live, state: { ...main, refreshError: { code: "TIMEOUT", message: "主查询刷新失败" } } };
  rendered.render(); await flush();
  pending[2].succeed(9); pending[3].succeed(7); await flush();
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
  expect(pending).toHaveLength(2);
  selected = { start: "2020-01-11", end: "2020-01-11" }; rendered.render(); await flush();
  expect(rendered.value).toBe(live);
  expect(pending.every(item => item.signal.aborted)).toBe(true);
  expect(pending).toHaveLength(2);
});

test("PID/注册日期切换立即屏蔽旧值并隔离迟到响应", async () => {
  let live = reading(), selected = range;
  const pending = requests(), rendered = hook(() => useCohortReading(live, selected)!);
  pending.forEach(item => item.succeed(8)); await flush();
  rendered.value.retry(); await flush();
  live = { ...live, query: { ...live.query, pid: "TT" }, refreshRevision: 1 };
  selected = { start: "2020-01-02", end: "2020-01-02" };
  expect(rendered.render().state.status).toBe("loading"); await flush();
  expect(pending).toHaveLength(6); // Key change and page refresh cannot duplicate requests.
  expect(pending[2].signal.aborted).toBe(true); expect(pending[3].signal.aborted).toBe(true);
  pending[4].succeed(4); pending[5].succeed(3); await flush();
  pending[2].succeed(9); pending[3].succeed(9); await flush();
  expect(rendered.value.state).toMatchObject({ status: "success", data: { data: { query: { pid: "TT", dateRange: ["2020-01-02", "2020-01-02"] }, series: [{ points: [{ value: .4 }] }] } } });
});

test("独立注册期启用对比只补比较请求，关闭时取消比较不重查当前期", async () => {
  let live = { ...reading(), comparison: undefined } as LiveDashboardReading;
  const pending = requests(), rendered = hook(() => useCohortReading(live, range)!);
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
  expect(pending.map(item => item.query.pid)).toEqual(["PH", "TT"]);
  pending.forEach(item => item.succeed(8)); await flush();
  live = { ...live, refreshRevision: 1, state: { status: "failure", kind: "error", code: "TIMEOUT", message: "主查询失败" } };
  rendered.render(); await flush(); expect(pending).toHaveLength(4);
  pending[2].fail(); pending[3].succeed(4); await flush();
  expect(rendered.value.resources.PH).toMatchObject({ status: "success", refreshError: { code: "OPERATING_READ_FAILED" } });
  expect(rendered.value.resources.TT).toMatchObject({ status: "success", refreshError: null });
  const tt = rendered.value.resources.TT;
  expect(tt.status === "success" && tt.data.data.series[0].points.every(point => point.value === .4)).toBe(true);
  live = { ...live, state: success(live.query, 6) }; rendered.render(); await flush();
  expect(pending).toHaveLength(4);
});

test("经营日期切换不显示旧日值，旧请求迟到不能覆盖新日期", async () => {
  let live = { ...reading(), query: { ...reading().query, boardId: "5.2" } };
  const pending = requests(), rendered = hook(() => useOperatingLive(live));
  pending.forEach(item => item.succeed(8)); await flush();
  live = { ...live, refreshRevision: 1 }; rendered.render(); await flush();
  live = { ...live, query: { ...live.query, dateRange: ["2020-01-11", "2020-01-11"] } };
  expect(rendered.render().rows!.every(row => row.values.every(value => value.current === null))).toBe(true); await flush();
  expect(pending).toHaveLength(6); expect(pending[2].signal.aborted).toBe(true);
  pending[4].succeed(4); pending[5].succeed(3); await flush();
  pending[2].succeed(9); pending[3].succeed(9); await flush();
  expect(rendered.value.resources.PH).toMatchObject({ status: "success", data: { data: { query: { dateRange: ["2020-01-04", "2020-01-11"] } } } });
  const ph = rendered.value.resources.PH;
  expect(ph.status === "success" && ph.data.data.series[0].points.every(point => point.value === .4)).toBe(true);
});
