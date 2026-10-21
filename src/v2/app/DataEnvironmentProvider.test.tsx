import { afterEach, expect, test } from "bun:test";
import * as React from "react";
import type { V2DataEnvironmentSuccess } from "../../../contracts/bi-v2";
import { currentDataEnvironmentPreference, setDataEnvironmentPreference } from "../api/dataEnvironmentPreference";
import { DataEnvironmentProvider } from "./DataEnvironmentProvider";

type TestEnvironment = Extract<V2DataEnvironmentSuccess["data"], { mode: "test" }>;
type Context = { state: { status: string; mode: string; expiresAt?: string; userName?: string }; dataScopeKey: string;
  activateTest(data: TestEnvironment): void; useProduction(): void; refresh(): Promise<void> };
const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const disposals: (() => void)[] = [];
afterEach(() => {
  disposals.splice(0).forEach(dispose => dispose());
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
  setDataEnvironmentPreference("production");
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const testEnvironment = (userName = "current-session"): TestEnvironment => ({ mode: "test", testAvailable: true, expiresAt: "2099-01-01T00:00:00Z", userName });
const productionEnvironment: V2DataEnvironmentSuccess["data"] = { mode: "production", testAvailable: true, expiresAt: null, userName: null };

// Run the actual provider hooks and effect cleanup with the same test-only
// dispatcher approach used by connected-query-lifecycle.test.ts.
function provider(mode: "test" | "production" = "test") {
  const storage = new Map([["ypbi.data-environment.v1:in-memory-subject", mode]]);
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: "test" | "production") => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  } });
  const pending: { signal?: AbortSignal; succeed(data?: V2DataEnvironmentSuccess["data"]): void; fail(code?: string): void }[] = [];
  globalThis.fetch = (async (url, options) => {
    expect(url).toBe("/api/bi/v2/data-environment");
    return new Promise<Response>(resolve => pending.push({ signal: options?.signal ?? undefined,
      succeed: (data = testEnvironment("old-session")) => resolve(Response.json({ success: true, data })),
      fail: (code = "DATA_PREVIEW_SESSION_REQUIRED") => resolve(Response.json({ success: false, error: { code, message: "内存检查失败", requestId: "in-memory" } }, { status: 403 })) }));
  }) as typeof fetch;
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: any[] = [];
  let index = 0, queued = false, mounted = true, writes = 0, value: Context;
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
      slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      slots[i].set ??= (next: any) => {
        writes++;
        const result = typeof next === "function" ? next(slots[i].value) : next;
        if (!Object.is(result, slots[i].value)) { slots[i].value = result; schedule(); }
      };
      return [slots[i].value, slots[i].set];
    },
    useRef(initial: unknown) { const i = index++; return slots[i] ??= { current: initial }; },
    useReducer(reducer: (state: any, action: any) => any, initial: any) {
      const [state, setState] = dispatcher.useState(initial);
      return [state, (action: any) => setState((current: any) => reducer(current, action))];
    },
    useMemo(factory: () => unknown, deps?: unknown[]) {
      const i = index++;
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: factory() };
      return slots[i].value;
    },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const i = index++, prior = slots[i];
      if (!prior || changed(prior.deps, deps)) {
        slots[i] = { deps, cleanup: prior?.cleanup };
        effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = effect(); });
      }
    }
  };
  function render() {
    index = 0;
    const prior = internals.H;
    internals.H = dispatcher;
    try { value = DataEnvironmentProvider({ subjectId: "in-memory-subject", children: null }).props.value as Context; }
    finally { internals.H = prior; }
    const queuedEffects = effects; effects = [];
    queuedEffects.forEach(effect => effect());
  }
  const result = { pending, get value() { return value; }, get writes() { return writes; }, dispose() { mounted = false; slots.forEach(slot => slot?.cleanup?.()); } };
  disposals.push(result.dispose);
  render();
  return result;
}

for (const outcome of ["success", "failure"] as const) test(`切回正式后旧测试检查${outcome}不能恢复测试模式`, async () => {
  const rendered = provider();
  rendered.value.useProduction(); await flush();
  const key = rendered.value.dataScopeKey;
  if (outcome === "success") rendered.pending[0].succeed();
  else rendered.pending[0].fail();
  await flush();
  expect(rendered.value.state).toMatchObject({ status: "ready", mode: "production" });
  expect(currentDataEnvironmentPreference()).toBe("production");
  expect(rendered.value.dataScopeKey).toBe(key);
});

for (const outcome of ["success", "failure"] as const) test(`test→production→test后旧检查${outcome}不能覆盖新会话`, async () => {
  const rendered = provider();
  rendered.value.useProduction(); rendered.value.activateTest(testEnvironment()); await flush();
  if (outcome === "success") rendered.pending[0].succeed();
  else rendered.pending[0].fail();
  await flush();
  expect(rendered.value.state).toMatchObject({ status: "ready", mode: "test", userName: "current-session" });
  expect(currentDataEnvironmentPreference()).toBe("test");
});

for (const outcome of ["success", "failure"] as const) test(`重叠检查仅接收最后一次，旧${outcome}不覆盖新结果`, async () => {
  const rendered = provider();
  const current = rendered.value.refresh();
  rendered.pending[1].succeed(testEnvironment()); await current; await flush();
  if (outcome === "success") rendered.pending[0].succeed(productionEnvironment);
  else rendered.pending[0].fail();
  await flush();
  expect(rendered.value.state).toMatchObject({ status: "ready", mode: "test", userName: "current-session" });
});

for (const outcome of ["success", "failure"] as const) test(`卸载后正在进行的主动检查${outcome}不写状态`, async () => {
  const rendered = provider();
  rendered.pending[0].succeed(); await flush();
  const current = rendered.value.refresh();
  rendered.dispose();
  const writes = rendered.writes;
  if (outcome === "success") rendered.pending[1].succeed(testEnvironment());
  else rendered.pending[1].fail();
  await current; await flush();
  expect(rendered.writes).toBe(writes);
});

test("当前有效测试检查失败仍进入失效状态，正常正式检查继续可用", async () => {
  const rendered = provider();
  rendered.pending[0].fail(); await flush();
  expect(rendered.value.state).toMatchObject({ status: "expired", mode: "test" });
  rendered.value.useProduction(); await flush();
  const current = rendered.value.refresh();
  rendered.pending[1].succeed(productionEnvironment); await current; await flush();
  expect(rendered.value.state).toMatchObject({ status: "ready", mode: "production" });
});

function browserLifecycle() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const windowTarget = new EventTarget(), documentTarget = new EventTarget();
  let visibility = "visible";
  Object.defineProperty(documentTarget, "visibilityState", { get: () => visibility });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentTarget });
  const restore = () => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
  };
  return { visibility(value: string) { visibility = value; }, focus() { windowTarget.dispatchEvent(new Event("focus")); },
    show() { windowTarget.dispatchEvent(new Event("pageshow")); }, visible() { documentTarget.dispatchEvent(new Event("visibilitychange")); }, restore };
}

function controlledClock() {
  const originalNow = Date.now, originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let now = Date.parse("2026-10-21T02:00:00Z"), next = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  Date.now = () => now;
  globalThis.setTimeout = ((callback: () => void, delay = 0) => { const id = ++next; timers.set(id, { due: now + delay, callback }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  return { expiry(milliseconds: number) { return new Date(now + milliseconds).toISOString(); },
    advance(milliseconds: number) { now += milliseconds; for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.callback(); } },
    restore() { Date.now = originalNow; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; } };
}

test("可见focus、pageshow、visibility事件合并单飞，重启失效只读复核且不切正式", async () => {
  const browser = browserLifecycle(), rendered = provider();
  try {
    rendered.pending[0].succeed(); await flush();
    const scope = rendered.value.dataScopeKey;
    browser.focus(); browser.show(); browser.visible(); browser.focus();
    expect(rendered.pending).toHaveLength(2);
    rendered.pending[1].fail(); await flush();
    expect(rendered.value.state).toMatchObject({ status: "expired", mode: "test" });
    expect(rendered.value.dataScopeKey).toBe(scope);
    expect(currentDataEnvironmentPreference()).toBe("test");
  } finally { rendered.dispose(); browser.restore(); }
});

test("后台不发复核请求，恢复前台成功不改变scope或期限", async () => {
  const browser = browserLifecycle(), rendered = provider();
  try {
    rendered.pending[0].succeed(); await flush();
    const scope = rendered.value.dataScopeKey, expiresAt = rendered.value.state.expiresAt;
    browser.visibility("hidden"); browser.focus(); browser.show(); browser.visible();
    expect(rendered.pending).toHaveLength(1);
    browser.visibility("visible"); browser.visible();
    expect(rendered.pending).toHaveLength(2);
    rendered.pending[1].succeed(); await flush();
    expect(rendered.value.state).toMatchObject({ status: "ready", mode: "test", expiresAt });
    expect(rendered.value.dataScopeKey).toBe(scope);
  } finally { rendered.dispose(); browser.restore(); }
});

test("复核网络失败是待确认而非成功，保留原期限并在到期后失效", async () => {
  const browser = browserLifecycle(), clock = controlledClock(), rendered = provider();
  try {
    const expiresAt = clock.expiry(1_000);
    rendered.pending[0].succeed({ ...testEnvironment(), expiresAt }); await flush();
    browser.focus(); rendered.pending[1].fail("V2_UPSTREAM_TIMEOUT"); await flush();
    expect(rendered.value.state).toMatchObject({ status: "unconfirmed", mode: "test", expiresAt });
    browser.visibility("hidden"); clock.advance(1_001); await flush();
    expect(rendered.value.state).toMatchObject({ status: "expired", mode: "test" });
    expect(rendered.pending).toHaveLength(2);
    browser.visibility("visible"); browser.show();
    expect(rendered.pending).toHaveLength(3);
    rendered.pending[2].fail("V2_UPSTREAM_TIMEOUT"); await flush();
    expect(rendered.value.state.status).toBe("expired");
  } finally { rendered.dispose(); clock.restore(); browser.restore(); }
});

test("已到期期限不能由成功响应恢复ready，当前可见期限只触发一次GET", async () => {
  const browser = browserLifecycle(), clock = controlledClock(), rendered = provider();
  try {
    const expiresAt = clock.expiry(1_000);
    rendered.pending[0].succeed({ ...testEnvironment(), expiresAt }); await flush();
    clock.advance(1_001); await flush();
    expect(rendered.pending).toHaveLength(2);
    expect(rendered.value.state.status).toBe("expired");
    rendered.pending[1].succeed({ ...testEnvironment(), expiresAt }); await flush();
    expect(rendered.value.state.status).toBe("expired");
    clock.advance(60_000); await flush();
    expect(rendered.pending).toHaveLength(2);
  } finally { rendered.dispose(); clock.restore(); browser.restore(); }
});

test("前台旧检查在新会话激活、切生产、卸载后均取消且不能回写", async () => {
  const browser = browserLifecycle(), rendered = provider();
  try {
    rendered.pending[0].succeed(); await flush();
    browser.focus();
    rendered.value.activateTest(testEnvironment("new-session")); await flush();
    expect(rendered.pending[1].signal?.aborted).toBe(true);
    rendered.pending[1].fail(); await flush();
    expect(rendered.value.state).toMatchObject({ status: "ready", userName: "new-session" });
    browser.focus(); rendered.value.useProduction(); await flush();
    rendered.pending[2].succeed(); await flush();
    expect(rendered.value.state).toMatchObject({ status: "ready", mode: "production" });
    const count = rendered.pending.length; browser.focus(); expect(rendered.pending).toHaveLength(count);
    rendered.value.activateTest(testEnvironment()); await flush(); browser.show();
    rendered.dispose(); const writes = rendered.writes;
    rendered.pending[3].succeed(); await flush();
    expect(rendered.pending[3].signal?.aborted).toBe(true); expect(rendered.writes).toBe(writes);
  } finally { rendered.dispose(); browser.restore(); }
});
