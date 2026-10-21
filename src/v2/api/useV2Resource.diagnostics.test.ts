import { expect, test } from "bun:test";
import * as React from "react";
import { V2RequestError } from "./client";
import { useV2Resource } from "./useV2Resource";

function hookHarness<T>(load: (signal: AbortSignal) => Promise<T>) {
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const states: unknown[] = [], refs: { current: unknown }[] = [], effects: { deps: readonly unknown[]; cleanup?: () => void }[] = [];
  let pending: Array<() => void> = [];
  return {
    render(key = "same-query") {
      let stateIndex = 0, refIndex = 0, effectIndex = 0;
      const prior = internals.H;
      internals.H = {
        useState(initial: unknown) {
          const index = stateIndex++;
          if (!(index in states)) states[index] = initial;
          return [states[index], (value: unknown) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
        },
        useRef(initial: unknown) { return refs[refIndex++] ??= { current: initial }; },
        useCallback: (callback: unknown) => callback,
        useEffect(effect: () => (() => void) | undefined, deps: readonly unknown[]) {
          const index = effectIndex++, previous = effects[index];
          if (!previous || previous.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
            const entry = { deps, cleanup: previous?.cleanup };
            effects[index] = entry;
            pending.push(() => { entry.cleanup?.(); entry.cleanup = effect(); });
          }
        }
      };
      try { return useV2Resource(key, load); } finally { internals.H = prior; }
    },
    flushEffects() { const batch = pending; pending = []; batch.forEach(run => run()); },
    unmount() { effects.forEach(effect => effect.cleanup?.()); pending = []; }
  };
}

function fixture() {
  const pending: { signal: AbortSignal; resolve: (value: { amount: number }) => void; reject: (reason: unknown) => void }[] = [];
  const harness = hookHarness(signal => new Promise<{ amount: number }>((resolve, reject) => { pending.push({ signal, resolve, reject }); }));
  return { harness, pending };
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const diagnostics = { code: "QUERY_JOB_UPSTREAM_REJECTED", requestId: "fixture-diagnostics", upstreamBusinessCode: 400, upstreamHttpStatus: 200 };
const rejection = () => new V2RequestError("查询任务被拒绝", { kind: "error", status: 400, ...diagnostics });

test("通用资源首次失败保留上游业务码和HTTP状态，重新读取成功清除全部失败诊断", async () => {
  const { harness, pending } = fixture();
  try {
    harness.render(); harness.flushEffects();
    pending[0].reject(rejection());
    await turn();
    expect(harness.render().state).toEqual({ status: "failure", kind: "error", message: "查询任务被拒绝", ...diagnostics });
    harness.render().retry(); harness.render(); harness.flushEffects();
    expect(harness.render().state).toEqual({ status: "loading" });
    pending[1].resolve({ amount: 0 });
    await turn();
    expect(harness.render().state).toEqual({ status: "success", data: { amount: 0 }, refreshing: false, refreshError: null });
  } finally { harness.unmount(); }
});

test("通用资源同条件刷新失败保留旧值及独立上游诊断，成功刷新清空诊断", async () => {
  const { harness, pending } = fixture();
  try {
    harness.render(); harness.flushEffects();
    const data = { amount: 7 };
    pending[0].resolve(data); await turn();
    harness.render().retry(); harness.render(); harness.flushEffects();
    pending[1].reject(rejection()); await turn();
    const failed = harness.render().state;
    expect(failed).toEqual({ status: "success", data, refreshing: false, refreshError: { message: "查询任务被拒绝", ...diagnostics } });
    expect(failed.status === "success" && failed.data).toBe(data);
    harness.render().retry(); harness.render(); harness.flushEffects();
    expect(harness.render().state).toEqual({ status: "success", data, refreshing: true, refreshError: null });
    pending[2].resolve({ amount: 0 }); await turn();
    expect(harness.render().state).toEqual({ status: "success", data: { amount: 0 }, refreshing: false, refreshError: null });
  } finally { harness.unmount(); }
});

test("通用资源403拒绝清除旧值与旧上游诊断，仅保留本次权限错误", async () => {
  const { harness, pending } = fixture();
  try {
    harness.render(); harness.flushEffects();
    pending[0].resolve({ amount: 7 }); await turn();
    harness.render().retry(); harness.render(); harness.flushEffects();
    pending[1].reject(rejection()); await turn();
    harness.render().retry(); harness.render(); harness.flushEffects();
    pending[2].reject(new V2RequestError("无权访问", { kind: "forbidden", status: 403, code: "PID_ACCESS_DENIED", requestId: "fixture-denied" }));
    await turn();
    expect(harness.render().state).toEqual({ status: "failure", kind: "forbidden", message: "无权访问", code: "PID_ACCESS_DENIED", requestId: "fixture-denied" });
  } finally { harness.unmount(); }
});
