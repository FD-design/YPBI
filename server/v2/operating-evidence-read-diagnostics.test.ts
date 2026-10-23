import { describe, expect, test } from "bun:test";
import { PhysicalReadTrace, UpstreamReadTrace } from "../upstream/read-trace";
import { createOperatingEvidenceReadDiagnostics, projectOperatingEvidenceReadDiagnostics } from "./operating-evidence-read-diagnostics";

function fixture() {
  let at = 0;
  const now = () => at;
  const trace = new UpstreamReadTrace({ now });
  const physical = new PhysicalReadTrace(951, { now });
  const logical = trace.observe("metrics", "new")!;
  logical.physicalCreated(physical);
  return { trace, physical, logical, at: (value: number) => { at = value; } };
}

describe("经营取证安全读取诊断", () => {
  test("排队预算到期但HTTP未启动时保留真实排队时长，HTTP字段缺席", () => {
    const current = fixture();
    current.at(20);
    const failure = { code: "UPSTREAM_TIMEOUT", failure: { origin: "queue_deadline" as const } };
    current.physical.markSettled(failure);
    current.logical.settle(failure);
    current.trace.recordBoundaryFailure("metrics", "new", { code: "UPSTREAM_TIMEOUT", failure: { origin: "source_budget" } });
    const result = projectOperatingEvidenceReadDiagnostics(current.trace.snapshot())!;
    expect(result.trace.physicalReads[0]).toMatchObject({ started: false, headersReceived: false, queueWaitMs: 20, origin: "queue_deadline" });
    for (const field of ["httpWaitMs", "headersWaitMs", "bodyWaitMs", "upstreamHttpStatus", "upstreamBusinessCode"]) {
      expect(result.trace.physicalReads[0]).not.toHaveProperty(field);
    }
    for (const value of [result.trace.summary, result.trace.bySource.metrics!, result.trace.byGroup.new!]) {
      expect(value.queueWaitMs).toBe(20);
      for (const field of ["httpWaitMs", "headersWaitMs", "bodyWaitMs"]) expect(value).not.toHaveProperty(field);
    }
    expect(result.trace.boundaryFailures[0]).toMatchObject({ sourceId: "metrics", groupId: "new", origin: "source_budget" });
  });

  test("HTTP已启动但尚无响应头时只提供已观测阶段和数值", () => {
    const current = fixture();
    current.at(4); current.physical.markStarted();
    current.at(20);
    const failure = { code: "UPSTREAM_TIMEOUT", failure: { origin: "http_deadline" as const } };
    current.physical.markSettled(failure); current.logical.settle(failure);
    const result = projectOperatingEvidenceReadDiagnostics(current.trace.snapshot())!;
    expect(result.trace.physicalReads[0]).toMatchObject({ started: true, headersReceived: false, queueWaitMs: 4, httpWaitMs: 16, headersWaitMs: 16 });
    expect(result.trace.physicalReads[0]).not.toHaveProperty("bodyWaitMs");
    expect(result.trace.physicalReads[0]).not.toHaveProperty("upstreamHttpStatus");
    expect(result.trace.summary).toMatchObject({ queueWaitMs: 4, httpWaitMs: 16, headersWaitMs: 16 });
    expect(result.trace.summary).not.toHaveProperty("bodyWaitMs");
  });

  test("真实数字HTTP和业务码保留在诊断，不提升为raw证据", () => {
    const current = fixture();
    current.at(2); current.physical.markStarted();
    current.at(8); current.physical.markHeaders(422);
    current.at(12); current.physical.markBody();
    current.at(16);
    const failure = { code: "UPSTREAM_INVALID_REQUEST", failure: { origin: "business" as const, upstreamHttpStatus: 422, upstreamBusinessCode: 400 } };
    current.physical.markSettled(failure); current.logical.settle(failure);
    const result = projectOperatingEvidenceReadDiagnostics(current.trace.snapshot())!;
    expect(result.schemaVersion).toBe("operating-evidence-safe-read-trace/v1");
    expect(result.boundary).toEqual({ kind: "upstream-read-trace-safe-projection", rawHttp: false, rawBody: false, metricAcceptanceGranted: false });
    expect(result.trace.physicalReads[0]).toMatchObject({ upstreamHttpStatus: 422, upstreamBusinessCode: 400, queueWaitMs: 2, headersWaitMs: 6, bodyWaitMs: 4, httpWaitMs: 14 });
    expect(result.trace.logicalReads[0]).toMatchObject({ upstreamHttpStatus: 422, upstreamBusinessCode: 400 });
    expect(result.trace.summary.upstreamHttpStatusCounts).toEqual({ "422": 1 });
    expect(result.trace.summary.upstreamBusinessCodeCounts).toEqual({ "400": 1 });
  });

  test("cache及未观测physical的reused不补造耗时或HTTP状态", () => {
    const trace = new UpstreamReadTrace({ now: () => 0 });
    const cached = trace.observe("monthly", "overall")!, reused = trace.observe("metrics", "old")!;
    cached.cacheHit(); cached.settle(); reused.physicalReused(); reused.settle();
    const result = projectOperatingEvidenceReadDiagnostics(trace.snapshot())!;
    expect(result.trace.logicalReads.map(read => read.mode)).toEqual(["cache", "reused"]);
    expect(result.trace.physicalReads).toEqual([]);
    expect(result.trace.summary).toMatchObject({ cacheHitCount: 1, physicalReusedCount: 1, physicalReadCount: 0 });
    for (const value of [result.trace.summary, ...Object.values(result.trace.bySource), ...Object.values(result.trace.byGroup)]) {
      for (const field of ["queueWaitMs", "httpWaitMs", "headersWaitMs", "bodyWaitMs"]) expect(value).not.toHaveProperty(field);
    }
    for (const read of result.trace.logicalReads) {
      expect(read).not.toHaveProperty("physicalId");
      expect(read).not.toHaveProperty("upstreamHttpStatus");
      expect(read).not.toHaveProperty("upstreamBusinessCode");
    }
  });

  test("pending快照封存后不被迟到阶段或结算改写", () => {
    const current = fixture();
    current.at(10);
    const snapshot = current.trace.snapshot(), result = projectOperatingEvidenceReadDiagnostics(snapshot)!;
    const before = JSON.stringify(result);
    current.at(20); current.physical.markStarted(); current.physical.markHeaders(200); current.physical.markBody();
    current.physical.markSettled(); current.logical.settle();
    expect(result.trace).toMatchObject({ completed: false, summary: { pendingLogicalReadCount: 1, pendingPhysicalReadCount: 1 } });
    expect(result.trace.logicalReads[0]).toMatchObject({ pending: true, completed: false, result: "pending" });
    expect(result.trace.physicalReads[0]).toMatchObject({ pending: true, completed: false, started: false });
    expect(JSON.stringify(result)).toBe(before);
    expect(current.trace.snapshot()).toBe(snapshot);
    expect(Object.isFrozen(result.trace.physicalReads[0])).toBe(true);
  });

  test("内部截断计数与已保留样本边界完整保留", () => {
    const trace = new UpstreamReadTrace({ now: () => 0, maxLogicalReads: 2, maxPhysicalReads: 1 });
    trace.observe("metrics", "new")!.physicalCreated(new PhysicalReadTrace(2, { now: () => 0 }));
    trace.observe("metrics", "old")!.physicalCreated(new PhysicalReadTrace(3, { now: () => 0 }));
    trace.observe("metrics", "overall");
    for (let index = 0; index < 257; index++) trace.recordBoundaryFailure("metrics", "new", { code: "UPSTREAM_TIMEOUT" });
    const result = projectOperatingEvidenceReadDiagnostics(trace.snapshot())!;
    expect(result.trace.truncated).toEqual({ logicalReads: 1, physicalReads: 1, boundaryFailures: 1 });
    expect(result.trace.logicalReads).toHaveLength(2);
    expect(result.trace.physicalReads).toHaveLength(1);
    expect(result.trace.boundaryFailures).toHaveLength(256);
  });

  test("所有层级未知字段和集合键被剥离，外层日志与原消息不进入输出", () => {
    const current = fixture(); current.logical.settle(); current.physical.markSettled();
    const snapshot = current.trace.snapshot(), secret = "private-token-name-cookie-url-query";
    const unknownSummary = { ...snapshot.summary, raw: secret,
      errorCodeCounts: { unknown: 1, [secret]: 1 }, failureOriginCounts: { http: 1, [secret]: 1 },
      upstreamHttpStatusCounts: { "500": 1, "0500": 1, [secret]: 1 }, upstreamBusinessCodeCounts: { "422": 1, "-1": 1, [secret]: 1 } };
    const enriched = { ...snapshot, queryId: secret, scopeTag: secret, url: secret, message: secret,
      logicalReads: snapshot.logicalReads.map(read => ({ ...read, token: secret, params: { secret }, response: secret })),
      physicalReads: snapshot.physicalReads.map(read => ({ ...read, headers: { secret }, rawBody: secret })),
      boundaryFailures: [{ id: 1, sourceId: "metrics", groupId: "new", result: "failure", error: secret }],
      summary: unknownSummary, bySource: { metrics: unknownSummary, [secret]: unknownSummary }, byGroup: { new: unknownSummary, [secret]: unknownSummary },
      truncated: { ...snapshot.truncated, reason: secret }
    };
    Object.defineProperty(enriched, "unrelatedGetter", { enumerable: true, get() { throw new Error(secret); } });
    const collector = createOperatingEvidenceReadDiagnostics();
    collector.logger.info({ readTrace: enriched, queryId: secret, scopeTag: secret, sources: [{ secret }] }, "daily dashboard read trace completed");
    const result = collector.snapshot()!;
    expect(result).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.trace.summary.upstreamHttpStatusCounts).toEqual({ "500": 1 });
    expect(result.trace.summary.upstreamBusinessCodeCounts).toEqual({ "422": 1 });
    expect(result.trace.summary.errorCodeCounts).toEqual({ unknown: 1 });
    expect(result.trace.summary.failureOriginCounts).toEqual({ http: 1 });
    expect(result.trace.bySource).toHaveProperty("metrics");
    expect(result.trace.byGroup).toHaveProperty("new");
  });

  test("只接受精确固定日志；诊断异常或非法值缺省，不抛错或回显", () => {
    const collector = createOperatingEvidenceReadDiagnostics();
    const unread = { get readTrace() { throw new Error("private getter"); } };
    expect(() => collector.logger.info(unread, "daily dashboard source reads completed")).not.toThrow();
    expect(collector.snapshot()).toBeUndefined();
    expect(() => collector.logger.info(unread, "daily dashboard read trace completed")).not.toThrow();
    expect(collector.snapshot()).toBeUndefined();
    const current = fixture(), snapshot = current.trace.snapshot();
    for (const invalid of [null, {}, { ...snapshot, physicalReads: [{ ...snapshot.physicalReads[0], durationMs: NaN }] },
      { ...snapshot, logicalReads: [{ ...snapshot.logicalReads[0], sourceId: "private-source" }] },
      { ...snapshot, logicalReads: [{ ...snapshot.logicalReads[0], code: "private-code" }] }]) {
      expect(projectOperatingEvidenceReadDiagnostics(invalid)).toBeUndefined();
    }
    collector.logger.info({ readTrace: snapshot }, "daily dashboard read trace completed");
    const before = collector.snapshot();
    collector.logger.info(unread, "daily dashboard read trace completed");
    expect(collector.snapshot()).toBe(before);
  });
});
