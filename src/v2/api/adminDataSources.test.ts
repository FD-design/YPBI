import { afterEach, describe, expect, test } from "bun:test";
import {
  AdminRequestError,
  fetchDataSourceStatus,
  loginMaintenance,
  testDataSource,
  updateDataSourceToken
} from "./adminDataSources";

const originalFetch = globalThis.fetch;
const CSRF_TOKEN = "fake-csrf-token-for-admin-tests";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const statuses = [
  { site: "primary", configured: true, tokenHint: "••••0001", updatedAt: null, userName: "primary-user" },
  { site: "secondary", configured: false, tokenHint: "未配置", updatedAt: null, userName: "secondary-user" }
] as const;

describe("V2 数据源维护客户端", () => {
  test("状态请求禁止缓存、携带同源会话并只接受闭合脱敏响应", async () => {
    let request: { input: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = { input: input.toString(), init };
      return jsonResponse({ success: true, data: statuses });
    }) as typeof fetch;

    await expect(fetchDataSourceStatus()).resolves.toEqual(statuses);
    expect(request?.input).toBe("/api/bi/admin/data-sources/status");
    expect(request?.init?.cache).toBe("no-store");
    expect(request?.init?.credentials).toBe("same-origin");
  });

  test("状态响应一旦意外包含 Token 原文就拒绝进入 UI", async () => {
    globalThis.fetch = (async () => jsonResponse({
      success: true,
      data: [{ ...statuses[0], token: "fake-raw-token-never-render" }, statuses[1]]
    })) as typeof fetch;

    await expect(fetchDataSourceStatus()).rejects.toMatchObject({
      code: "INVALID_ADMIN_RESPONSE"
    });
  });

  test("tokenHint 若不是固定掩码也拒绝进入 UI", async () => {
    globalThis.fetch = (async () => jsonResponse({
      success: true,
      data: [{ ...statuses[0], tokenHint: "fake-raw-token-never-render" }, statuses[1]]
    })) as typeof fetch;

    await expect(fetchDataSourceStatus()).rejects.toMatchObject({
      code: "INVALID_ADMIN_RESPONSE"
    });
  });

  test("当前测试、候选测试与保存使用三个明确请求", async () => {
    const observed: Array<{ path: string; method?: string; body?: string; csrfToken: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      observed.push({
        path: input.toString(),
        method: init?.method,
        body: String(init?.body ?? ""),
        csrfToken: new Headers(init?.headers).get("x-csrf-token")
      });
      if (input.toString().endsWith("/test")) {
        return jsonResponse({ success: true, data: { site: "primary", valid: true, checkedAt: "2026-09-08T01:00:00.000Z" } });
      }
      return jsonResponse({ success: true, data: { ...statuses[0], tokenHint: "••••0002", updatedAt: "2026-09-08T01:01:00.000Z" } });
    }) as typeof fetch;

    await testDataSource("primary", CSRF_TOKEN);
    await testDataSource("primary", CSRF_TOKEN, "fake-candidate-token-0002");
    await updateDataSourceToken("primary", "fake-candidate-token-0002", CSRF_TOKEN);

    expect(observed).toEqual([
      { path: "/api/bi/admin/data-sources/test", method: "POST", body: JSON.stringify({ site: "primary" }), csrfToken: CSRF_TOKEN },
      { path: "/api/bi/admin/data-sources/test", method: "POST", body: JSON.stringify({ site: "primary", token: "fake-candidate-token-0002" }), csrfToken: CSRF_TOKEN },
      { path: "/api/bi/admin/data-sources/token", method: "PUT", body: JSON.stringify({ site: "primary", token: "fake-candidate-token-0002" }), csrfToken: CSRF_TOKEN }
    ]);
  });

  test("登录锁定和维护会话失效保留不同错误类型", async () => {
    globalThis.fetch = (async () => jsonResponse({
      success: false,
      error: { code: "MAINTENANCE_LOCKED", message: "验证失败次数过多，请稍后重试" }
    }, 429)) as typeof fetch;
    await expect(loginMaintenance("fake-password-long-enough", CSRF_TOKEN)).rejects.toMatchObject({ kind: "locked", status: 429 });

    globalThis.fetch = (async () => jsonResponse({
      success: false,
      error: { code: "MAINTENANCE_LOGIN_REQUIRED", message: "维护登录已失效，请重新登录" }
    }, 401)) as typeof fetch;
    try {
      await fetchDataSourceStatus();
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AdminRequestError);
      expect((error as AdminRequestError).kind).toBe("login_required");
    }
  });

  test("上游 429 不会被误判为维护登录锁定", async () => {
    globalThis.fetch = (async () => jsonResponse({
      success: false,
      error: { code: "UPSTREAM_RATE_LIMITED", message: "后台接口请求过于频繁" }
    }, 429)) as typeof fetch;

    await expect(testDataSource("primary", CSRF_TOKEN)).rejects.toMatchObject({ kind: "upstream", status: 429 });
  });
});
