import { describe, expect, test } from "bun:test";
import type { AppEnv } from "../config/env";
import { UpstreamClient, UpstreamError } from "./client";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { runWithUpstreamRequestProfile } from "./request-profile";
import { isBiV1MetricSelectionRejection } from "./bi-v1.request-isolation";

const env: AppEnv = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3000,
  UPSTREAM_API_BASE_URL: "https://example.com",
  UPSTREAM_X_TOKEN: "test-token",
  UPSTREAM_USER_NAME: "primary-user",
  UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.com",
  UPSTREAM_SECONDARY_X_TOKEN: "secondary-token",
  UPSTREAM_SECONDARY_USER_NAME: "secondary-user",
  UPSTREAM_CREDENTIALS_FILE: join(tmpdir(), "bi-upstream-client-test-unused.json"),
  WORKSPACE_FILE: join(tmpdir(), "bi-workspace-client-test-unused.json"),
  BI_V2_CORE_OVERVIEW_QUERY_ENABLED: false,
  BI_LOCAL_DASHBOARD_READING_ENABLED: false,
  BI_PRODUCTION_DASHBOARD_READING_ENABLED: false,
  BI_TEST_DATA_PREVIEW_ENABLED: false,
  REQUEST_TIMEOUT_MS: 1000,
  MAX_PLATFORM_CONCURRENCY: 1
};

describe("UpstreamClient business errors", () => {
  test("取证文本检查屏蔽配置凭据与当前测试会话，不返回凭据值", async () => {
    const client = new UpstreamClient({
      ...env,
      TOKEN_MAINTENANCE_KEY: "fake-maintenance-protected-value",
      BI_AUTH_CSRF_SECRET: "fake-csrf-protected-value-000000000",
      DATABASE_URL: "postgres://fake-database-protected-value",
      BI_AUTH_DATABASE_URL: "postgres://fake-auth-database-protected-value"
    });
    for (const text of ["PH", "M016", "bi-v1", "effective_play_v3", "2026-10-12"]) {
      expect(client.isProtectedDiagnosticText(text)).toBe(false);
    }
    for (const text of ["test-token", "prefix-secondary-token-suffix", "primary-user", "https://example.com",
      "fake-maintenance-protected-value", "fake-csrf-protected-value-000000000",
      "postgres://fake-database-protected-value", "postgres://fake-auth-database-protected-value"]) {
      expect(client.isProtectedDiagnosticText(text)).toBe(true);
    }
    expect(client.isProtectedDiagnosticText("ephemeral-preview-token-7777")).toBe(false);
    await runWithUpstreamRequestProfile({
      environment: "test", baseUrl: "https://ephemeral.example.test", userName: "ephemeral-preview-user",
      token: "ephemeral-preview-token-7777", cachePartition: "ephemeral-preview-partition"
    }, async () => {
      for (const text of ["ephemeral-preview-token-7777", "ephemeral-preview-user", "ephemeral-preview-partition", "https://ephemeral.example.test"]) {
        expect(client.isProtectedDiagnosticText(text)).toBe(true);
      }
    });
    expect(client.isProtectedDiagnosticText("ephemeral-preview-token-7777")).toBe(false);
  });

  test("按 PID 选择备用后台及其匹配凭证", async () => {
    let requestUrl = "";
    let requestHeaders: RequestInit["headers"];
    const client = new UpstreamClient(env, async (input, init) => {
      requestUrl = input.toString();
      requestHeaders = init?.headers;
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await client.get("/api/test", { pid: "TJD" });

    expect(requestUrl).toStartWith("https://secondary.example.com/api/test");
    expect(requestHeaders).toEqual({ "x-token": "secondary-token", name: "secondary-user" });
  });

  test("平台目录中归属站1的 PID 使用主后台", async () => {
    let requestUrl = "";
    let requestHeaders: RequestInit["headers"];
    const client = new UpstreamClient(env, async (input, init) => {
      requestUrl = input.toString();
      requestHeaders = init?.headers;
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await client.get("/api/test", { pid: "PH" });

    expect(requestUrl).toStartWith("https://example.com/api/test");
    expect(requestHeaders).toEqual({ "x-token": "test-token", name: "primary-user" });
  });

  test("显式测试请求对主站和备用站 PID 使用同一临时测试凭据且请求结束后恢复正式路由", async () => {
    const requests: Array<{ url: string; headers: RequestInit["headers"] }> = [];
    const client = new UpstreamClient(env, async (input, init) => {
      requests.push({ url: input.toString(), headers: init?.headers });
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await runWithUpstreamRequestProfile({
      environment: "test",
      baseUrl: "https://test.example.com",
      token: "temporary-test-token",
      userName: "temporary-test-user",
      cachePartition: "preview-session-1"
    }, async () => {
      await client.get("/api/test", { pid: "PH" });
      await client.get("/api/test", { pid: "TJD" });
    });
    await client.get("/api/test", { pid: "PH" });

    expect(requests[0]).toMatchObject({ url: "https://test.example.com/api/test?pid=PH", headers: { "x-token": "temporary-test-token", name: "temporary-test-user" } });
    expect(requests[1]).toMatchObject({ url: "https://test.example.com/api/test?pid=TJD", headers: { "x-token": "temporary-test-token", name: "temporary-test-user" } });
    expect(requests[2]).toMatchObject({ url: "https://example.com/api/test?pid=PH", headers: { "x-token": "test-token", name: "primary-user" } });
  });

  test("正式与测试请求缓存严格分区，不会复用另一环境的返回值", async () => {
    let fetchCount = 0;
    const client = new UpstreamClient(env, async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ code: 200, msg: { fetchCount } }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await client.get("/api/test", { pid: "PH" });
    await runWithUpstreamRequestProfile({ environment: "test", baseUrl: "https://example.com", token: "test-token", userName: "primary-user", cachePartition: "preview-session-1" }, () => client.get("/api/test", { pid: "PH" }));
    await client.get("/api/test", { pid: "PH" });

    expect(fetchCount).toBe(2);
  });

  test("主数据源未配置 Token 时失败关闭且绝不发出匿名请求", async () => {
    let fetchCount = 0;
    const client = new UpstreamClient({ ...env, UPSTREAM_X_TOKEN: undefined }, async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    });

    await expect(client.get("/api/test", { pid: "PH" })).rejects.toMatchObject({
      code: "UPSTREAM_NOT_CONFIGURED",
      statusCode: 503
    });
    expect(fetchCount).toBe(0);
  });

  test("命中备用 PID 但备用路由不完整时失败关闭且不回落主后台", async () => {
    let fetchCount = 0;
    const client = new UpstreamClient({
      ...env,
      UPSTREAM_SECONDARY_API_BASE_URL: undefined,
      UPSTREAM_SECONDARY_USER_NAME: undefined,
      UPSTREAM_SECONDARY_X_TOKEN: undefined
    }, async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    });

    await expect(client.get("/api/test", { pid: "FBI" })).rejects.toMatchObject({
      code: "UPSTREAM_NOT_CONFIGURED",
      statusCode: 503
    });
    expect(fetchCount).toBe(0);
  });

  test("未知 PID 在网络请求前失败关闭且不会默认回落主后台", async () => {
    let fetchCount = 0;
    const client = new UpstreamClient(env, async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    });

    await expect(client.get("/api/test", { pid: "UNKNOWN" })).rejects.toMatchObject({
      code: "UPSTREAM_PID_NOT_AVAILABLE",
      statusCode: 422
    });
    expect(fetchCount).toBe(0);
  });

  test("将重新登录业务码映射为认证失败", async () => {
    const client = new UpstreamClient(env, async () => new Response(JSON.stringify({ code: 2002, err: "请重新登陆" }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.get("/api/test", {})).rejects.toMatchObject({ code: "UPSTREAM_AUTH_FAILED", statusCode: 401 });
  });

  test("将 IP 限制业务码映射为明确错误", async () => {
    const client = new UpstreamClient(env, async () => new Response(JSON.stringify({ code: 2002, err: "ip限制，请联系管理员" }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.get("/api/test", {})).rejects.toMatchObject({ code: "UPSTREAM_IP_RESTRICTED", statusCode: 403 });
  });

  test("将上游业务参数错误映射为 422 而不是内部 500", async () => {
    const client = new UpstreamClient(env, async () => new Response(JSON.stringify({ code: 400, err: ["请选择完整实验条件"] }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.get("/api/test", {})).rejects.toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422 });
  });

  test("留存接口无当日数据时归一化为空结果", async () => {
    const client = new UpstreamClient(env, async () => new Response(JSON.stringify({ code: 400, err: "没有该平台当日数据" }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.get("/api/admin/statistics/reletionsStatPlus/getDays", {})).resolves.toEqual({ code: 200, data: [] });
  });

  test("新 Token 验证成功后即时用于后续请求且状态不回显原文", async () => {
    const file = join(tmpdir(), `bi-upstream-credentials-${Date.now()}.json`);
    const requestTokens: string[] = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_input, init) => {
      requestTokens.push(String((init?.headers as Record<string, string>)["x-token"]));
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const status = await client.updateCredential("primary", "new-primary-token-1234");
    await client.get("/api/test", { pid: "PH" });

    expect(requestTokens).toEqual(["new-primary-token-1234", "new-primary-token-1234"]);
    expect(status.tokenHint).toBe("••••1234");
    expect(JSON.stringify(status)).not.toContain("new-primary-token");
    await unlink(file).catch(() => undefined);
  });

  test("并发更新两个站点时串行合并凭证且不遗留临时文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bi-upstream-credentials-concurrent-"));
    const file = join(directory, "credentials.json");
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async () =>
      new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } })
    );

    try {
      await Promise.all([
        client.updateCredential("primary", "concurrent-primary-token"),
        client.updateCredential("secondary", "concurrent-secondary-token")
      ]);

      const persisted = JSON.parse(await readFile(file, "utf8")) as {
        primary?: { token: string; updatedAt: string };
        secondary?: { token: string; updatedAt: string };
      };
      expect(persisted.primary?.token).toBe("concurrent-primary-token");
      expect(persisted.secondary?.token).toBe("concurrent-secondary-token");
      expect(persisted.primary?.updatedAt).toBeString();
      expect(persisted.secondary?.updatedAt).toBeString();
      expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("候选凭证验证失败时保留原凭证且不创建临时文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bi-upstream-credentials-rejected-"));
    const file = join(directory, "credentials.json");
    const requestTokens: string[] = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_input, init) => {
      const token = String((init?.headers as Record<string, string>)["x-token"]);
      requestTokens.push(token);
      if (token === "rejected-primary-token") {
        return new Response(JSON.stringify({ code: 2002, err: "请重新登陆" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    try {
      await client.updateCredential("primary", "accepted-primary-token");
      const persistedBeforeFailure = await readFile(file, "utf8");

      await expect(client.updateCredential("primary", "rejected-primary-token")).rejects.toMatchObject({
        code: "UPSTREAM_AUTH_FAILED",
        statusCode: 401
      });
      await client.get("/api/test", { pid: "PH" });

      expect(await readFile(file, "utf8")).toBe(persistedBeforeFailure);
      expect(requestTokens.at(-1)).toBe("accepted-primary-token");
      expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("持久化失败时保留原活动凭证并清理已写入的临时文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bi-upstream-credentials-write-failure-"));
    const file = join(directory, "credentials.json");
    await mkdir(file);
    const requestTokens: string[] = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_input, init) => {
      requestTokens.push(String((init?.headers as Record<string, string>)["x-token"]));
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    try {
      await expect(client.updateCredential("primary", "unpersisted-primary-token")).rejects.toBeInstanceOf(Error);
      await client.get("/api/test", { pid: "PH" });

      expect(requestTokens).toEqual(["unpersisted-primary-token", "test-token"]);
      expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("UpstreamClient HTTP 参数拒绝兼容", () => {
  const metricMessage = "Unsupported metricCodes: M007";
  const jsonResponse = (payload: unknown, status: number) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  const readError = async (response: Response, path = "/api/admin/bi/v1/metrics") => {
    const client = new UpstreamClient(env, async () => response);
    try {
      await client.get(path, {});
    } catch (error) {
      return error;
    }
    throw new Error("拒绝响应必须保持失败");
  };

  for (const httpStatus of [200, 400, 422]) for (const code of [400, 422]) for (const array of [false, true]) {
    test(`HTTP ${httpStatus} / 业务 ${code} / ${array ? "字符串数组" : "字符串"}指标拒绝保留隔离依据`, async () => {
      const err = array ? [metricMessage, "请调整指标编码"] : metricMessage;
      const error = await readError(jsonResponse({ code, err }, httpStatus));
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422, message: array ? `${metricMessage}；请调整指标编码` : metricMessage });
      expect(isBiV1MetricSelectionRejection(error)).toBe(true);
    });
  }

  const invalidPayloads = [
    ["成功业务码", { code: 200, err: metricMessage }],
    ["其他业务码", { code: 500, err: metricMessage }],
    ["字符串业务码", { code: "422", err: metricMessage }],
    ["缺业务码", { err: metricMessage }],
    ["缺错误说明", { code: 422 }],
    ["空错误说明", { code: 422, err: "" }],
    ["空白错误说明", { code: 422, err: "   " }],
    ["空错误数组", { code: 400, err: [] }],
    ["空白错误数组项", { code: 400, err: [metricMessage, " "] }],
    ["混合类型错误数组", { code: 400, err: [metricMessage, 1] }],
    ["对象错误说明", { code: 422, err: { message: metricMessage } }],
    ["空响应", null]
  ] as const;
  for (const status of [400, 422]) {
    for (const [label, payload] of invalidPayloads) test(`HTTP ${status} ${label}保持HTTP失败`, async () => {
      const error = await readError(jsonResponse(payload, status));
      expect(error).toMatchObject({ code: "UPSTREAM_FAILED", statusCode: 502, message: `后台接口返回 ${status}` });
      expect(isBiV1MetricSelectionRejection(error)).toBe(false);
    });
    test(`HTTP ${status} 非JSON错误体保持HTTP失败`, async () => {
      const error = await readError(new Response("upstream rejected request", { status }));
      expect(error).toMatchObject({ code: "UPSTREAM_FAILED", statusCode: 502, message: `后台接口返回 ${status}` });
      expect(isBiV1MetricSelectionRejection(error)).toBe(false);
    });
    for (const err of ["Unsupported metricCodes: M007; permission denied", "指标查询没有权限，token无效", "endDate必须晚于startDate"]) {
      test(`HTTP ${status} ${err}保持参数失败且不触发指标隔离`, async () => {
        const error = await readError(jsonResponse({ code: 422, err }, status));
        expect(error).toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422, message: err });
        expect(isBiV1MetricSelectionRejection(error)).toBe(false);
      });
    }
    test(`HTTP ${status} 留存无当日数据说明不转为成功空结果`, async () => {
      const error = await readError(jsonResponse({ code: 400, err: "没有该平台当日数据" }, status), "/api/admin/statistics/reletionsStatPlus/getDays");
      expect(error).toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422 });
      expect(isBiV1MetricSelectionRejection(error)).toBe(false);
    });
  }

  for (const status of [200, 400, 422]) for (const ipRestricted of [false, true]) {
    test(`HTTP ${status} 业务2002保持${ipRestricted ? "IP限制" : "认证"}错误`, async () => {
      const error = await readError(jsonResponse({ code: 2002, err: ipRestricted ? "ip限制，请联系管理员" : "请重新登陆" }, status));
      expect(error).toMatchObject({ code: ipRestricted ? "UPSTREAM_IP_RESTRICTED" : "UPSTREAM_AUTH_FAILED", statusCode: ipRestricted ? 403 : 401 });
      expect(isBiV1MetricSelectionRejection(error)).toBe(false);
    });
  }

  for (const [status, code, statusCode] of [
    [401, "UPSTREAM_AUTH_FAILED", 401], [403, "UPSTREAM_AUTH_FAILED", 403],
    [429, "UPSTREAM_RATE_LIMITED", 429], [500, "UPSTREAM_FAILED", 502]
  ] as const) test(`HTTP ${status} 优先保留原错误边界`, async () => {
    const error = await readError(jsonResponse({ code: 422, err: metricMessage }, status));
    expect(error).toMatchObject({ code, statusCode });
    expect(isBiV1MetricSelectionRejection(error)).toBe(false);
  });

  test("网络错误保持来源失败且不触发指标隔离", async () => {
    const client = new UpstreamClient(env, async () => { throw new TypeError(metricMessage); });
    const error = await client.get("/api/admin/bi/v1/metrics", {}).catch(error => error);
    expect(error).toMatchObject({ code: "UPSTREAM_NETWORK_ERROR", statusCode: 502 });
    expect(isBiV1MetricSelectionRejection(error)).toBe(false);
  });
  test("请求超时保持504且不触发指标隔离", async () => {
    const client = new UpstreamClient({ ...env, REQUEST_TIMEOUT_MS: 5 }, async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("request aborted", "AbortError")), { once: true });
    }));
    const error = await client.get("/api/admin/bi/v1/metrics", {}).catch(error => error);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
    expect(isBiV1MetricSelectionRejection(error)).toBe(false);
  });
});
