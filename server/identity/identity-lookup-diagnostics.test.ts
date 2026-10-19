import { describe, expect, test } from "bun:test";
import {
  associateIdentityLookupFailure, beginIdentityLookupDiagnostics, freezeIdentityLookupFailure,
  identityLookupFailureDiagnostics, markIdentityLookupPhase, recordIdentityStorageFailure
} from "./identity-lookup-diagnostics";

describe("身份失败内部诊断", () => {
  test("超时冻结当时阶段及数字耗时，晚到查询不改写", () => {
    const signal = new AbortController().signal;
    let now = 100;
    beginIdentityLookupDiagnostics(signal, 3000, () => now);
    now = 120;
    markIdentityLookupPhase(signal, "acquire");
    now = 3400;
    const frozen = freezeIdentityLookupFailure(signal, "deadline_exceeded");
    expect(frozen).toEqual({ failureCode: "deadline_exceeded", phase: "acquire", elapsedMs: 3300,
      phaseElapsedMs: 3280, deadlineMs: 3000, deadlineOverrunMs: 300 });
    now = 8000;
    markIdentityLookupPhase(signal, "query");
    recordIdentityStorageFailure(signal, { code: "57014", message: "not logged" });
    expect(freezeIdentityLookupFailure(signal, "storage_unavailable")).toBe(frozen);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  test("固定存储白名单不包含原错误、SQL或会话字段", () => {
    for (const [code, expected] of [["57014", "query_cancelled"], ["55P03", "lock_unavailable"], ["53300", "capacity_exceeded"],
      ["CONNECT_TIMEOUT", "connection_unavailable"], ["08006", "connection_unavailable"], ["secret-arbitrary-code", "unknown"]]) {
      const signal = new AbortController().signal;
      beginIdentityLookupDiagnostics(signal, 3000, () => 100);
      markIdentityLookupPhase(signal, "query");
      const error = { code, message: "secret-session-token", query: "secret-sql", parameters: ["secret-password"] };
      recordIdentityStorageFailure(signal, error);
      associateIdentityLookupFailure(signal, error);
      const actual = identityLookupFailureDiagnostics(error);
      expect(actual).toMatchObject({ failureCode: "storage_unavailable", phase: "query", storageFailureCode: expected });
      expect(JSON.stringify(actual)).not.toContain("secret");
      expect(JSON.stringify(actual)).not.toContain(code!);
    }
  });

  test("原始异常不变，无法读取code的错误保持unknown", () => {
    const signal = new AbortController().signal;
    beginIdentityLookupDiagnostics(signal, 3000);
    const error = Object.defineProperty(new Error("secret-message"), "code", { get() { throw new Error("secret-getter"); } });
    recordIdentityStorageFailure(signal, error);
    associateIdentityLookupFailure(signal, error);
    expect(identityLookupFailureDiagnostics(error)).toMatchObject({ failureCode: "storage_unavailable", storageFailureCode: "unknown" });
    expect(error.message).toBe("secret-message");
    expect(Object.keys(error)).toEqual([]);
    for (const target of [undefined, null, "secret-message", 42, {}])
      expect(identityLookupFailureDiagnostics(target)).toEqual({ failureCode: "unknown", phase: "unknown" });
  });

  test("不同信号独立，阶段与失败枚举无法注入自由文本", () => {
    const first = new AbortController().signal, second = new AbortController().signal;
    beginIdentityLookupDiagnostics(first, 3000, () => 1);
    beginIdentityLookupDiagnostics(second, 3000, () => 1);
    markIdentityLookupPhase(first, "secret-phase" as never);
    expect(freezeIdentityLookupFailure(first, "secret-code" as never)).toMatchObject({ failureCode: "unknown", phase: "resolve" });
    markIdentityLookupPhase(second, "map");
    expect(freezeIdentityLookupFailure(second, "invalid_resolution")).toMatchObject({ failureCode: "invalid_resolution", phase: "map" });
  });

  test("客户端取消与零超时超出量分开保留", () => {
    const signal = new AbortController().signal;
    let now = 20;
    beginIdentityLookupDiagnostics(signal, 3000, () => now);
    now = 30;
    expect(freezeIdentityLookupFailure(signal, "client_aborted")).toEqual({ failureCode: "client_aborted", phase: "resolve",
      elapsedMs: 10, phaseElapsedMs: 10, deadlineMs: 3000, deadlineOverrunMs: 0 });
  });

  test("诊断时钟异常不能抛出或替换认证结果", () => {
    const signal = new AbortController().signal;
    expect(() => beginIdentityLookupDiagnostics(signal, 3000, () => { throw new Error("private-clock"); })).not.toThrow();
    expect(() => markIdentityLookupPhase(signal, "query")).not.toThrow();
    expect(freezeIdentityLookupFailure(signal)).toEqual({ failureCode: "unknown", phase: "unknown" });
    let failed = false;
    beginIdentityLookupDiagnostics(signal, 3000, () => { if (failed) throw new Error("private-clock"); return 100; });
    failed = true;
    expect(() => markIdentityLookupPhase(signal, "query")).not.toThrow();
    expect(freezeIdentityLookupFailure(signal)).toEqual({ failureCode: "unknown", phase: "unknown" });
  });
});
