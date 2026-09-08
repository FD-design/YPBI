import { describe, expect, test } from "bun:test";
import type { IdentityProvider } from "./identity-provider";
import { resolveIdentity } from "./resolve-identity";

describe("resolveIdentity cancellation boundary", () => {
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
});
