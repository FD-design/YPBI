import { describe, expect, test } from "bun:test";
import type { IdentityProvider } from "./identity-provider";
import { resolveIdentity } from "./resolve-identity";
import { identityLookupFailureDiagnostics, markIdentityLookupPhase } from "./identity-lookup-diagnostics";

describe("resolveIdentity cancellation boundary", () => {
  const authenticated = {
    status: "authenticated",
    principal: { subjectId: "identity-unit-user", roles: ["reader"], permissions: ["bi:read"], pidScope: "all" }
  } as const;

  test("已取消请求不调用provider，也不接受立即返回的有效身份", async () => {
    const external = new AbortController();
    const reason = new Error("identity request already cancelled");
    external.abort(reason);
    let calls = 0;
    const provider: IdentityProvider = { resolve: async () => { calls++; return authenticated; } };

    await expect(resolveIdentity(provider, { headers: {}, ip: "127.0.0.1", signal: external.signal }))
      .rejects.toBe(reason);
    expect(calls).toBe(0);
    expect(identityLookupFailureDiagnostics(external.signal)).toMatchObject({ failureCode: "client_aborted", phase: "resolve" });
  });

  for (const timing of ["同步", "微任务"] as const) {
    test(`provider成功与${timing}取消竞争时仍失败关闭`, async () => {
      const external = new AbortController();
      const reason = new Error("identity request cancelled while resolving");
      const provider: IdentityProvider = { resolve: () => {
        if (timing === "同步") external.abort(reason);
        else queueMicrotask(() => external.abort(reason));
        return Promise.resolve(authenticated);
      } };

      await expect(resolveIdentity(provider, { headers: {}, ip: "127.0.0.1", signal: external.signal }))
        .rejects.toBe(reason);
      expect(identityLookupFailureDiagnostics(external.signal)).toMatchObject({ failureCode: "client_aborted", phase: "resolve" });
    });
  }

  test("将外层客户端取消传递给身份提供者", async () => {
    const external = new AbortController();
    let providerObservedAbort = false;
    const identityProvider: IdentityProvider = {
      resolve: ({ signal }) => new Promise((_resolve, reject) => {
        const onAbort = () => {
          providerObservedAbort = true;
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
    };

    const pending = resolveIdentity(
      identityProvider,
      { headers: {}, ip: "127.0.0.1", signal: external.signal },
      10_000
    );
    external.abort(new Error("test_client_disconnected"));

    await expect(pending).rejects.toThrow("test_client_disconnected");
    expect(providerObservedAbort).toBe(true);
  });

  test("身份结果仍由运行时契约校验", async () => {
    const invalidProvider: IdentityProvider = {
      resolve: async () => ({ status: "authenticated" } as never)
    };

    await expect(resolveIdentity(invalidProvider, { headers: {}, ip: "127.0.0.1" }))
      .rejects.toThrow("invalid_identity_resolution");
  });

  test("外层超时先冻结acquire阶段，迟到provider结果不覆盖诊断", async () => {
    let providerSignal: AbortSignal | undefined;
    let finish: (value: { status: "unauthenticated" }) => void = () => undefined;
    const provider: IdentityProvider = { resolve: ({ signal }) => {
      providerSignal = signal;
      markIdentityLookupPhase(signal, "acquire");
      return new Promise(resolve => { finish = resolve; });
    } };
    const error = await resolveIdentity(provider, { headers: {}, ip: "127.0.0.1" }, 5).catch(value => value);
    expect(error.message).toBe("identity_timeout");
    const before = identityLookupFailureDiagnostics(error);
    expect(before).toMatchObject({ failureCode: "deadline_exceeded", phase: "acquire", deadlineMs: 5 });
    expect(before.elapsedMs!).toBeGreaterThanOrEqual(0);
    expect(before.deadlineOverrunMs!).toBeGreaterThanOrEqual(0);
    markIdentityLookupPhase(providerSignal, "query");
    finish({ status: "unauthenticated" });
    await Promise.resolve();
    expect(identityLookupFailureDiagnostics(error)).toBe(before);
  });

  test("契约异常与客户端取消固定分类，不输出provider原文", async () => {
    const malformed: IdentityProvider = { resolve: async () => ({ status: "authenticated", secret: "secret-provider" } as never) };
    const invalid = await resolveIdentity(malformed, { headers: {}, ip: "127.0.0.1" }).catch(value => value);
    expect(identityLookupFailureDiagnostics(invalid)).toMatchObject({ failureCode: "invalid_resolution", phase: "resolve" });
    const external = new AbortController();
    const pending = resolveIdentity({ resolve: async () => new Promise(() => {}) }, { headers: {}, ip: "127.0.0.1", signal: external.signal });
    const reason = new Error("secret-client-reason");
    external.abort(reason);
    const cancelled = await pending.catch(value => value);
    expect(cancelled).toBe(reason);
    expect(identityLookupFailureDiagnostics(cancelled)).toMatchObject({ failureCode: "client_aborted", phase: "resolve" });
    expect(JSON.stringify(identityLookupFailureDiagnostics(cancelled))).not.toContain("secret");
  });

  test("并发请求复用同一异常对象时仍按各自外层signal读取阶段", async () => {
    const shared = new Error("secret-shared-error");
    let calls = 0;
    const provider: IdentityProvider = { resolve: async ({ signal }) => {
      markIdentityLookupPhase(signal, calls++ === 0 ? "acquire" : "query");
      await Promise.resolve();
      throw shared;
    } };
    const first = new AbortController(), second = new AbortController();
    const errors = await Promise.all([first, second].map(controller =>
      resolveIdentity(provider, { headers: {}, ip: "127.0.0.1", signal: controller.signal }).catch(error => error)));
    expect(errors).toEqual([shared, shared]);
    expect(identityLookupFailureDiagnostics(first.signal)).toMatchObject({ failureCode: "unknown", phase: "acquire" });
    expect(identityLookupFailureDiagnostics(second.signal)).toMatchObject({ failureCode: "unknown", phase: "query" });
    expect(JSON.stringify(identityLookupFailureDiagnostics(first.signal))).not.toContain("secret");
  });
});
