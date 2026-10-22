import { expect, test } from "bun:test";
import { UPSTREAM_READ_FAILURE_ORIGINS } from "./read-failure";
import {
  PhysicalReadTrace, UpstreamReadTrace, captureUpstreamReadObserver,
  recordUpstreamReadBoundaryFailure, runWithUpstreamReadContext, runWithUpstreamReadTrace
} from "./read-trace";

test("未启用时不创建观察器，诊断上下文保持原返回值及错误", async () => {
  expect(captureUpstreamReadObserver()).toBeUndefined();
  const original = Promise.resolve(7);
  expect(runWithUpstreamReadContext({ sourceId: "metrics" }, () => original)).toBe(original);
  const error = new Error("original failure");
  expect(() => runWithUpstreamReadTrace(new UpstreamReadTrace(), () => { throw error; })).toThrow(error);
  expect(captureUpstreamReadObserver()).toBeUndefined();
});

test("异步并行上下文独立，嵌套分组继承来源且返回后还原", async () => {
  const trace = new UpstreamReadTrace();
  await runWithUpstreamReadTrace(trace, () => Promise.all([
    runWithUpstreamReadContext({ sourceId: "metrics", groupId: "new" }, async () => {
      await Promise.resolve();
      runWithUpstreamReadContext({ groupId: "android" }, () => captureUpstreamReadObserver()!.settle());
      captureUpstreamReadObserver()!.settle();
    }),
    runWithUpstreamReadContext({ sourceId: "payment", groupId: "ali" }, async () => {
      await Promise.resolve();
      captureUpstreamReadObserver()!.settle();
    })
  ]));
  expect(trace.snapshot().logicalReads.map(read => [read.sourceId, read.groupId])).toEqual([
    ["metrics", "android"], ["metrics", "new"], ["payment", "ali"]
  ]);
  expect(captureUpstreamReadObserver()).toBeUndefined();
});

test("共享物理读取只累计一次队列与HTTP耗时，缓存独立计数", () => {
  let time = 10;
  const now = () => time;
  const trace = new UpstreamReadTrace({ now });
  runWithUpstreamReadTrace(trace, () => {
    const first = runWithUpstreamReadContext({ sourceId: "metrics", groupId: "overall" }, captureUpstreamReadObserver)!;
    const physical = new PhysicalReadTrace(900, { now });
    first.physicalCreated(physical);
    time = 20; physical.markStarted();
    time = 30;
    const second = runWithUpstreamReadContext({ sourceId: "monthly", groupId: "overall" }, captureUpstreamReadObserver)!;
    second.physicalReused(physical);
    time = 50; physical.markHeaders(200);
    time = 70; physical.markBody();
    time = 80; physical.markSettled(); first.settle(); second.settle();
    const cached = captureUpstreamReadObserver()!;
    cached.cacheHit(); cached.settle();
  });
  const result = trace.snapshot();
  expect(result.completed).toBe(true);
  expect(result.physicalReads).toHaveLength(1);
  expect(result.physicalReads[0]).toMatchObject({ id: 1, queueWaitMs: 10, httpWaitMs: 60, headersWaitMs: 30, bodyWaitMs: 20, completed: true, upstreamHttpStatus: 200 });
  expect(result.logicalReads.map(read => read.durationMs)).toEqual([70, 50, 0]);
  expect(result.summary).toMatchObject({ logicalReadCount: 3, successfulLogicalReadCount: 3, physicalReadCount: 1, physicalCreatedCount: 1, physicalReusedCount: 1, cacheHitCount: 1, queueWaitMs: 10, httpWaitMs: 60 });
  expect(result.byGroup.overall).toMatchObject({ logicalReadCount: 2, physicalReadCount: 1, httpWaitMs: 60 });
  expect(result.bySource.metrics?.physicalReadCount).toBe(1);
  expect(result.bySource.monthly?.physicalReadCount).toBe(1);
});

test("来源预算结算保留仍在运行的物理读取，快照封存且不冻结其他消费者", () => {
  let time = 0;
  const now = () => time;
  const trace = new UpstreamReadTrace({ now });
  const physical = new PhysicalReadTrace(1, { now });
  const observer = runWithUpstreamReadTrace(trace, captureUpstreamReadObserver)!;
  observer.physicalCreated(physical);
  time = 5; physical.markStarted();
  time = 20; observer.settle({ code: "UPSTREAM_TIMEOUT", failure: { origin: "source_budget" } });
  time = 30;
  const frozen = trace.snapshot();
  const serialized = JSON.stringify(frozen);
  expect(frozen).toMatchObject({ completed: false, summary: { failedLogicalReadCount: 1, pendingPhysicalReadCount: 1, queueWaitMs: 5, httpWaitMs: 25 } });
  expect(frozen.physicalReads[0].result).toBe("pending");
  expect(frozen.logicalReads[0]).toMatchObject({ completed: true, origin: "source_budget", durationMs: 20 });
  time = 45; physical.markHeaders(200);
  time = 50; physical.markBody(); physical.markSettled(); observer.settle(); observer.cacheHit();
  expect(runWithUpstreamReadTrace(trace, captureUpstreamReadObserver)).toBeUndefined();
  expect(trace.snapshot()).toBe(frozen);
  expect(JSON.stringify(frozen)).toBe(serialized);
  expect(Object.isFrozen(frozen.logicalReads[0])).toBe(true);
  expect(Object.isFrozen(frozen.summary.failureOriginCounts)).toBe(true);
  const other = new UpstreamReadTrace({ now });
  const healthy = runWithUpstreamReadTrace(other, captureUpstreamReadObserver)!;
  healthy.physicalReused(physical); healthy.settle();
  expect(other.snapshot().physicalReads[0]).toMatchObject({ completed: true, httpWaitMs: 45 });
});

test("所有固定失败来源及安全数字分类可取证，原始输入不进入快照", () => {
  const trace = new UpstreamReadTrace();
  runWithUpstreamReadTrace(trace, () => {
    for (const origin of UPSTREAM_READ_FAILURE_ORIGINS) {
      const observer = captureUpstreamReadObserver()!;
      observer.noPhysical();
      observer.settle({ code: "UPSTREAM_TIMEOUT", failure: { origin, upstreamHttpStatus: 503, upstreamBusinessCode: 400 } });
    }
    runWithUpstreamReadContext({ sourceId: "https://secret.invalid?token=PRIVATE", groupId: "PID-PRIVATE" }, () => {
      const observer = captureUpstreamReadObserver()!;
      observer.settle({ code: "PRIVATE-ERROR", failure: { origin: "PRIVATE-ORIGIN", upstreamHttpStatus: "PRIVATE-HTTP", upstreamBusinessCode: "PRIVATE-CODE" } as never });
    });
  });
  const result = trace.snapshot();
  expect(result.summary.errorCodeCounts).toEqual({ UPSTREAM_TIMEOUT: 8, unknown: 1 });
  expect(result.summary.upstreamHttpStatusCounts).toEqual({ "503": 8 });
  expect(result.summary.upstreamBusinessCodeCounts).toEqual({ "400": 8 });
  expect(Object.keys(result.summary.failureOriginCounts).sort()).toEqual([...UPSTREAM_READ_FAILURE_ORIGINS].sort());
  expect(result.logicalReads[8]).toMatchObject({ sourceId: "unknown", groupId: "unknown", code: "unknown" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(JSON.stringify(result)).not.toContain("https:");
});

test("容量限制按逻辑读取与唯一物理读取计截断，重复引用不重复累计", () => {
  const trace = new UpstreamReadTrace({ maxLogicalReads: 4, maxPhysicalReads: 1 });
  const first = new PhysicalReadTrace(1), second = new PhysicalReadTrace(2);
  runWithUpstreamReadTrace(trace, () => {
    for (const [physical, reuse] of [[first, false], [second, false], [second, true]] as const) {
      const observer = captureUpstreamReadObserver()!;
      if (reuse) observer.physicalReused(physical); else observer.physicalCreated(physical);
      observer.settle();
    }
    const cached = captureUpstreamReadObserver()!;
    cached.cacheHit(); cached.settle();
    expect(captureUpstreamReadObserver()).toBeUndefined();
  });
  expect(trace.snapshot()).toMatchObject({ truncated: { logicalReads: 1, physicalReads: 1 }, summary: { logicalReadCount: 4, physicalReadCount: 1, physicalCreatedCount: 2, physicalReusedCount: 1, cacheHitCount: 1 } });
  const bounded = new UpstreamReadTrace({ maxLogicalReads: 999_999, maxPhysicalReads: 999_999 });
  runWithUpstreamReadTrace(bounded, () => {
    for (let i = 0; i < 260; i++) captureUpstreamReadObserver()?.settle();
  });
  expect(bounded.snapshot().logicalReads).toHaveLength(256);
  expect(bounded.snapshot().truncated.logicalReads).toBe(4);
});

test("排队失败保留等待耗时，未观察到的HTTP阶段保持缺省", () => {
  let time = 10;
  const now = () => time;
  const trace = new UpstreamReadTrace({ now });
  const observer = runWithUpstreamReadTrace(trace, captureUpstreamReadObserver)!;
  const physical = new PhysicalReadTrace(1, { now });
  observer.physicalCreated(physical);
  time = 40;
  const failure = { code: "UPSTREAM_TIMEOUT", failure: { origin: "queue_deadline" as const } };
  physical.markSettled(failure); observer.settle(failure);
  const snapshot = trace.snapshot();
  expect(snapshot.physicalReads[0]).toMatchObject({ queueWaitMs: 30, started: false, completed: true, origin: "queue_deadline" });
  expect(snapshot.physicalReads[0].httpWaitMs).toBeUndefined();
  expect(snapshot.summary.httpWaitMs).toBe(0);
});

test("观察器重复回调、异常时钟与异常分类输入不改变读取结果", () => {
  const trace = new UpstreamReadTrace({ now: () => { throw new Error("private clock"); } });
  expect(runWithUpstreamReadTrace(trace, () => {
    const observer = captureUpstreamReadObserver()!;
    observer.physicalReused();
    observer.cacheHit();
    observer.settle({ get code() { throw new Error("private diagnostic"); } });
    observer.settle();
    return "original result";
  })).toBe("original result");
  expect(trace.snapshot().logicalReads[0]).toMatchObject({ mode: "reused", result: "failure", code: "unknown", durationMs: 0 });
  expect(JSON.stringify(trace.snapshot())).not.toContain("private");
});

test("HTTP成功后的边界校验失败独立登记，保留原逻辑与物理成功", () => {
  const trace = new UpstreamReadTrace();
  runWithUpstreamReadTrace(trace, () => runWithUpstreamReadContext({ sourceId: "metrics", groupId: "android" }, () => {
    const observer = captureUpstreamReadObserver()!;
    const physical = new PhysicalReadTrace(1);
    observer.physicalCreated(physical);
    physical.markStarted(); physical.markHeaders(200); physical.markBody(); physical.markSettled(); observer.settle();
    recordUpstreamReadBoundaryFailure({ code: "BI_V1_RESPONSE_INVALID", failure: { origin: "validation" } });
  }));
  const snapshot = trace.snapshot();
  expect(snapshot.summary).toMatchObject({ logicalReadCount: 1, successfulLogicalReadCount: 1, failedLogicalReadCount: 0, physicalReadCount: 1 });
  expect(snapshot.physicalReads[0].result).toBe("success");
  expect(snapshot.boundaryFailures).toEqual([{ id: 1, sourceId: "metrics", groupId: "android", result: "failure", code: "BI_V1_RESPONSE_INVALID", origin: "validation" }]);
  runWithUpstreamReadTrace(trace, () => recordUpstreamReadBoundaryFailure({ code: "UPSTREAM_FAILED" }));
  expect(trace.snapshot().boundaryFailures).toBe(snapshot.boundaryFailures);
  expect(snapshot.boundaryFailures).toHaveLength(1);
  expect(Object.isFrozen(snapshot.boundaryFailures[0])).toBe(true);
});

test("边界取证未启用时不访问输入，启用时限制256条并安全投影", () => {
  let reads = 0;
  const input = { get code(): never { reads++; throw new Error("PRIVATE boundary"); } };
  expect(() => recordUpstreamReadBoundaryFailure(input)).not.toThrow();
  expect(reads).toBe(0);
  const trace = new UpstreamReadTrace();
  runWithUpstreamReadTrace(trace, () => {
    for (let i = 0; i < 260; i++) recordUpstreamReadBoundaryFailure(input);
  });
  const snapshot = trace.snapshot();
  expect(snapshot.boundaryFailures).toHaveLength(256);
  expect(snapshot.truncated.boundaryFailures).toBe(4);
  expect(reads).toBe(256);
  expect(snapshot.summary.logicalReadCount).toBe(0);
  expect(snapshot.summary.physicalReadCount).toBe(0);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
});
