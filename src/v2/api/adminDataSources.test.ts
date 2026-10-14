import { afterEach, describe, expect, test } from "bun:test";
import {
  AdminRequestError,
  activateDataPreview,
  deactivateDataPreview,
  fetchDataPreviewStatus,
  fetchDataSourceStatus,
  loginMaintenance,
  logoutMaintenance,
  testDataSource,
  updateDataSourceToken
} from "./adminDataSources";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const CSRF_TOKEN = "fake-csrf-token-for-admin-tests";

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

function virtualClock() {
  let now = 0, nextId = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const delays: number[] = [];
  const cleared: number[] = [];
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const id = nextId++;
    delays.push(delay);
    timers.set(id, { due: now + delay, callback });
    return id;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    cleared.push(id);
    timers.delete(id);
  }) as typeof globalThis.clearTimeout;
  return {
    delays, cleared,
    get activeCount() { return timers.size; },
    advance(milliseconds: number) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((left, right) => left[1].due - right[1].due)[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = target;
    }
  };
}

function pendingFetch() {
  let signal: AbortSignal | undefined;
  let finish!: (response: Response) => void;
  globalThis.fetch = ((_input, init) => new Promise<Response>((resolve, reject) => {
    signal = init?.signal ?? undefined;
    finish = resolve;
    if (signal?.aborted) reject(new DOMException("request cancelled", "AbortError"));
    else signal?.addEventListener("abort", () => reject(new DOMException("request cancelled", "AbortError")), { once: true });
  })) as typeof fetch;
  return { finish: (response: Response) => finish(response), get signal() { return signal; } };
}

describe("只读凭证探针期限与维护请求边界", () => {
  for (const candidate of [false, true]) test(`${candidate ? "候选" : "当前"}凭证的20秒正常探针不被维护客户端提前取消`, async () => {
    const clock = virtualClock();
    const request = pendingFetch();
    const data = { site: "secondary", valid: true, checkedAt: "2026-10-14T08:00:00.000Z" };
    const outcome = testDataSource("secondary", CSRF_TOKEN, candidate ? "fake-candidate-token-0002" : undefined)
      .then(value => ({ success: true, value }), error => ({ success: false, error }));
    clock.advance(20_000);
    request.finish(jsonResponse({ success: true, data }));
    expect(await outcome).toEqual({ success: true, value: data });
    expect(clock.delays).toEqual([75_000]);
    expect(clock.activeCount).toBe(0);
    expect(clock.cleared).toHaveLength(1);
  });

  test("挂起探针在75秒仍返回原维护超时码并清理计时器", async () => {
    const clock = virtualClock();
    const request = pendingFetch();
    const outcome = testDataSource("secondary", CSRF_TOKEN).catch(error => error);
    clock.advance(74_999);
    expect(request.signal?.aborted).toBe(false);
    clock.advance(1);
    expect(await outcome).toMatchObject({ code: "ADMIN_REQUEST_TIMEOUT", kind: "error", status: 0 });
    expect(clock.activeCount).toBe(0);
    expect(clock.cleared).toHaveLength(1);
  });

  test("探针JSON读取仍受75秒期限约束", async () => {
    const clock = virtualClock();
    let reading = false;
    globalThis.fetch = (async (_input, init) => {
      const response = new Response("", { status: 200 });
      response.json = () => {
        reading = true;
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("body cancelled", "AbortError")), { once: true }));
      };
      return response;
    }) as typeof fetch;
    const outcome = testDataSource("secondary", CSRF_TOKEN).catch(error => error);
    await Promise.resolve();
    expect(reading).toBe(true);
    clock.advance(75_000);
    expect(await outcome).toMatchObject({ code: "ADMIN_REQUEST_TIMEOUT", kind: "error", status: 0 });
    expect(clock.activeCount).toBe(0);
    expect(clock.cleared).toHaveLength(1);
  });

  for (const [status, code] of [[504, "UPSTREAM_TIMEOUT"], [401, "UPSTREAM_AUTH_FAILED"]] as const)
    test(`探针保留HTTP${status}上游分类、错误码与请求编号`, async () => {
      const clock = virtualClock();
      globalThis.fetch = (async () => jsonResponse({ success: false, error: { code, message: "fixture upstream failure", requestId: "fixture-probe-request" } }, status)) as typeof fetch;
      await expect(testDataSource("secondary", CSRF_TOKEN)).rejects.toMatchObject({ code, kind: "upstream", status, requestId: "fixture-probe-request" });
      expect(clock.delays).toEqual([75_000]);
      expect(clock.activeCount).toBe(0);
      expect(clock.cleared).toHaveLength(1);
    });

  test("登录、保存、状态与测试环境操作全部保留原15秒期限", async () => {
    const clock = virtualClock();
    globalThis.fetch = (async input => {
      const path = input.toString();
      if (path === "/api/bi/admin/data-sources/status") return jsonResponse({ success: true, data: statuses });
      if (path === "/api/bi/admin/auth/login") return jsonResponse({ success: true, data: { expiresAt: "2026-10-29T08:00:00.000Z" } });
      if (path === "/api/bi/admin/auth/logout") return jsonResponse({ success: true, data: { loggedOut: true } });
      if (path === "/api/bi/admin/data-sources/token") return jsonResponse({ success: true, data: statuses[0] });
      if (path === "/api/bi/admin/data-preview/status") return jsonResponse({ success: true, data: { enabled: true, active: false, userName: "fixture-test-user", expiresAt: null } });
      if (path === "/api/bi/admin/data-preview/activate") return jsonResponse({ success: true, data: { mode: "test", userName: "fixture-test-user", expiresAt: "2026-10-15T08:00:00.000Z", checkedAt: "2026-10-14T08:00:00.000Z" } });
      if (path === "/api/bi/admin/data-preview/deactivate") return jsonResponse({ success: true, data: { mode: "production" } });
      throw new Error("Unexpected maintenance fixture operation");
    }) as typeof fetch;
    await fetchDataSourceStatus();
    await loginMaintenance("fake-password-long-enough", CSRF_TOKEN);
    await logoutMaintenance(CSRF_TOKEN);
    await updateDataSourceToken("primary", "fake-candidate-token-0002", CSRF_TOKEN);
    await fetchDataPreviewStatus();
    await activateDataPreview("fake-preview-token-0001", CSRF_TOKEN);
    await deactivateDataPreview(CSRF_TOKEN);
    expect(clock.delays).toEqual(Array(7).fill(15_000));
    expect(clock.activeCount).toBe(0);
    expect(clock.cleared).toHaveLength(7);
  });

  test("其他维护请求在15秒仍有界失败", async () => {
    const clock = virtualClock();
    pendingFetch();
    const outcome = loginMaintenance("fake-password-long-enough", CSRF_TOKEN).catch(error => error);
    clock.advance(15_000);
    expect(await outcome).toMatchObject({ code: "ADMIN_REQUEST_TIMEOUT", kind: "error", status: 0 });
    expect(clock.activeCount).toBe(0);
    expect(clock.cleared).toHaveLength(1);
  });

  test("调用方取消挂起读取保留AbortError并清理维护计时器", async () => {
    const clock = virtualClock();
    const request = pendingFetch();
    const controller = new AbortController();
    const outcome = fetchDataSourceStatus(controller.signal).catch(error => error);
    controller.abort();
    const failure = await outcome;
    expect(failure).toBeInstanceOf(DOMException);
    expect(failure.name).toBe("AbortError");
    expect(request.signal?.aborted).toBe(true);
    expect(clock.activeCount).toBe(0);
    expect(clock.cleared).toHaveLength(1);
  });

  test("调用方取消JSON读取保留AbortError而不改为超时", async () => {
    const clock = virtualClock();
    let reading = false;
    globalThis.fetch = (async (_input, init) => {
      const response = new Response("", { status: 200 });
      response.json = () => {
        reading = true;
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("body cancelled", "AbortError")), { once: true }));
      };
      return response;
    }) as typeof fetch;
    const controller = new AbortController();
    const outcome = fetchDataSourceStatus(controller.signal).catch(error => error);
    await Promise.resolve();
    expect(reading).toBe(true);
    controller.abort();
    const failure = await outcome;
    expect(failure).toBeInstanceOf(DOMException);
    expect(failure.name).toBe("AbortError");
    expect(clock.activeCount).toBe(0);
    expect(clock.cleared).toHaveLength(1);
  });
});

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const statuses = [
  { site: "primary", configured: true, tokenHint: "••••0001", updatedAt: null, userName: "primary-user" },
  { site: "secondary", configured: false, tokenHint: "未配置", updatedAt: null, userName: "secondary-user" }
] as const;

describe("V2 数据源维护客户端", () => {
  test("测试数据会话使用独立接口，响应与浏览器请求均不回显或持久化 Token", async () => {
    const observed: Array<{ path: string; body: string; csrfToken: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      observed.push({ path: input.toString(), body: String(init?.body ?? ""), csrfToken: new Headers(init?.headers).get("x-csrf-token") });
      if (input.toString().endsWith("/status")) return jsonResponse({ success: true, data: { enabled: true, active: false, userName: "test-user", expiresAt: null } });
      if (input.toString().endsWith("/activate")) return jsonResponse({ success: true, data: { mode: "test", userName: "test-user", expiresAt: "2026-09-08T01:30:00.000Z", checkedAt: "2026-09-08T01:00:00.000Z" } });
      return jsonResponse({ success: true, data: { mode: "production" } });
    }) as typeof fetch;

    await fetchDataPreviewStatus();
    const activated = await activateDataPreview("temporary-test-token-0001", CSRF_TOKEN);
    await deactivateDataPreview(CSRF_TOKEN);

    expect(activated).toMatchObject({ mode: "test", userName: "test-user" });
    expect(observed).toEqual([
      { path: "/api/bi/admin/data-preview/status", body: "", csrfToken: null },
      { path: "/api/bi/admin/data-preview/activate", body: JSON.stringify({ token: "temporary-test-token-0001" }), csrfToken: CSRF_TOKEN },
      { path: "/api/bi/admin/data-preview/deactivate", body: "", csrfToken: CSRF_TOKEN }
    ]);
  });

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
