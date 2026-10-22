import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp } from "./app";
import type { BiAuthService } from "./auth/service";
import type { AppEnv } from "./config/env";
import type { IdentityProvider, IdentityResolution, Principal } from "./identity/identity-provider";
import { dailyDashboardSuccessSchema } from "../contracts/daily-dashboard";
import type { QueryJobCreateRequest } from "./upstream/query-jobs";
import { OPERATING_METRIC_IDS } from "../contracts/operating-detail-projection";

const publicOrigin = "https://187.77.129.207.nip.io";
const maintenancePassword = "fake-maintenance-password-2026";
const primaryToken = "fake-production-primary-token-0001";
const secondaryToken = "fake-production-secondary-token-0002";
const previewToken = "fake-preview-token-0003";
const ordinarySession = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const csrfToken = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ordinaryCookie = `__Host-ypbi_session=${ordinarySession}`;
const query = { boardId: "5.14", pid: "PH", dateRange: ["2020-01-01", "2020-01-01"] };
const catalogPath = "/api/bi/v2/catalog/readable-dashboards";
const queryPath = "/api/bi/v2/queries/dashboards/daily-reading";
const openApps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];
const originalFetch = globalThis.fetch;

const viewer: Principal = { subjectId: "fake-viewer", roles: ["viewer"], permissions: ["bi:read"], pidScope: ["PH"] };
const maintainer: Principal = { subjectId: "fake-maintainer", roles: ["maintainer"], permissions: ["bi:read", "bi:data-source-maintenance:enter"], pidScope: "all", securityVersion: "1" };
const identity = (principal: Principal): IdentityProvider => ({ resolve: async () => ({ status: "authenticated", principal }) });
const resolutionIdentity = (resolution: IdentityResolution): IdentityProvider => ({ resolve: async () => resolution });

interface ObservedRequest { url: URL; token: string | null; userName: string | null; method: string; body?: unknown }

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  globalThis.fetch = originalFetch;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createHarness(options: { env?: Partial<AppEnv>; identityProvider?: IdentityProvider | null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ypbi-production-daily-reading-"));
  temporaryDirectories.push(directory);
  const observedRequests: ObservedRequest[] = [];
  const jobs = new Map<string, QueryJobCreateRequest>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    observedRequests.push({ url, token: headers.get("x-token"), userName: headers.get("name"), method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (!["primary.example.test", "secondary.example.test", "preview.example.test"].includes(url.hostname)) {
      throw new Error("Unexpected fake upstream origin");
    }
    if (url.pathname.startsWith("/api/admin/bi/v1/queryJobs")) {
      const taskId = url.hostname === "secondary.example.test" ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        : url.hostname === "preview.example.test" ? "cccccccccccccccccccccccccccccccc" : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      if (init?.method === "POST") {
        jobs.set(url.hostname, JSON.parse(String(init.body)) as QueryJobCreateRequest);
        return Response.json({ code: 200, msg: { taskId, reused: false } });
      }
      const body = jobs.get(url.hostname);
      if (!body || !url.pathname.includes(taskId)) throw new Error("Unbound fake upstream task");
      return Response.json({ code: 200, msg: { taskId, status: "SUCCEEDED", totalUnits: body.queries.length, completedUnits: body.queries.length,
        ...(url.pathname.endsWith("/result") ? { results: body.queries.map(() => ({ generatedAt: new Date().toISOString(), rows: [] })) } : {}) } });
    }
    const value = url.hostname === "preview.example.test" ? 31 : url.hostname === "secondary.example.test" ? 23 : 17;
    const payload = url.pathname === "/api/admin/dataDashboard/overview"
      ? { code: 200, msg: { date: url.searchParams.get("date"), pid: url.searchParams.get("pid"), signInRate: { raw: { signed: value } } } }
      : { code: 200, msg: { pageData: [], totalCount: 0 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const env: AppEnv = {
    NODE_ENV: "production", HOST: "127.0.0.1", PORT: 3000,
    UPSTREAM_API_BASE_URL: "https://primary.example.test", UPSTREAM_X_TOKEN: primaryToken, UPSTREAM_USER_NAME: "fake-primary-user",
    UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.test", UPSTREAM_SECONDARY_X_TOKEN: secondaryToken, UPSTREAM_SECONDARY_USER_NAME: "fake-secondary-user",
    UPSTREAM_CREDENTIALS_FILE: join(directory, "upstream-credentials.json"), WORKSPACE_FILE: join(directory, "workspace.json"),
    TOKEN_MAINTENANCE_KEY: maintenancePassword, BI_PUBLIC_ORIGIN: publicOrigin,
    BI_V2_CORE_OVERVIEW_QUERY_ENABLED: false, BI_LOCAL_DASHBOARD_READING_ENABLED: false,
    BI_PRODUCTION_DASHBOARD_READING_ENABLED: true, BI_TEST_DATA_PREVIEW_ENABLED: false,
    BI_PRODUCTION_OPERATING_ASYNC_ENABLED: false,
    REQUEST_TIMEOUT_MS: 1_000, MAX_PLATFORM_CONCURRENCY: 1,
    ...options.env
  };
  const authService = { csrfMatches: (session: string, csrf: string | undefined) => session === ordinarySession && csrf === csrfToken } as BiAuthService;
  const app = await buildApp(env, {
    identityProvider: options.identityProvider === null ? undefined : options.identityProvider ?? identity(viewer),
    authService: options.identityProvider === null ? undefined : authService
  });
  openApps.push(app);
  const request = (method: "GET" | "POST", url: string, payload?: InjectOptions["payload"], headers: Record<string, string> = {}): Promise<LightMyRequestResponse> => app.inject({
    method, url, payload, remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-proto": "https", "x-forwarded-for": "192.0.2.11", origin: publicOrigin, cookie: ordinaryCookie, "x-csrf-token": csrfToken, ...headers }
  });
  return { app, request, observedRequests, credentialsFile: env.UPSTREAM_CREDENTIALS_FILE };
}

function cookieByName(header: string | string[] | undefined, name: string) {
  const matches = (Array.isArray(header) ? header : header ? [header] : []).filter(value => value.startsWith(`${name}=`));
  expect(matches).toHaveLength(1);
  return matches[0].split(";", 1)[0];
}

async function activatePreview(harness: Awaited<ReturnType<typeof createHarness>>) {
  const login = await harness.request("POST", "/api/bi/admin/auth/login", { password: maintenancePassword });
  expect(login.statusCode).toBe(200);
  const maintenanceCookie = cookieByName(login.headers["set-cookie"], "bi_maintenance_session");
  const activated = await harness.request("POST", "/api/bi/admin/data-preview/activate", { token: previewToken }, { cookie: `${ordinaryCookie}; ${maintenanceCookie}` });
  expect(activated.statusCode).toBe(200);
  expect(activated.body).not.toContain(previewToken);
  expect(harness.observedRequests).toHaveLength(2);
  expect(harness.observedRequests.every(item => item.url.hostname === "preview.example.test" && item.token === previewToken && item.userName === "fake-preview-user")).toBe(true);
  expect(existsSync(harness.credentialsFile)).toBe(false);
  harness.observedRequests.splice(0);
  return { cookie: `${ordinaryCookie}; ${maintenanceCookie}; ${cookieByName(activated.headers["set-cookie"], "ypbi_data_preview")}`, "x-ypbi-data-environment": "test" };
}

function assertValue(response: LightMyRequestResponse, value: number) {
  expect(response.statusCode).toBe(200);
  const parsed = dailyDashboardSuccessSchema.parse(response.json());
  expect(parsed.data.series).toHaveLength(1);
  expect(parsed.data.series[0].metric.id).toBe("M075");
  expect(parsed.data.series[0].points[0]).toMatchObject({ date: "2020-01-01", state: "available", value });
  expect(response.body).not.toContain(primaryToken);
  expect(response.body).not.toContain(secondaryToken);
  expect(response.body).not.toContain(previewToken);
}

describe("buildApp 正式日看板读取装配", () => {
  for (const previewEnabled of [false, true]) {
    test(`正式 flag=false、测试预览 ${previewEnabled} 时目录关闭且查询零上游`, async () => {
      const harness = await createHarness({ env: {
        BI_PRODUCTION_DASHBOARD_READING_ENABLED: false, BI_TEST_DATA_PREVIEW_ENABLED: previewEnabled,
        UPSTREAM_TEST_API_BASE_URL: "https://preview.example.test", UPSTREAM_TEST_USER_NAME: "fake-preview-user"
      } });
      const catalog = await harness.request("GET", catalogPath);
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json().data.enabled).toBe(false);
      expect(catalog.json().data.items.some((item: { id: string; metricIds: string[] }) => item.id === "5.2" && item.metricIds.length > 0)).toBe(true);
      const result = await harness.request("POST", queryPath, query);
      expect(result.statusCode).toBe(422);
      expect(result.json().error.code).toBe("DAILY_READING_DISABLED");
      expect(harness.observedRequests).toHaveLength(0);
    });
  }

  for (const [pid, value, hostname, token, userName] of [
    ["PH", 17, "primary.example.test", primaryToken, "fake-primary-user"],
    ["FBI", 23, "secondary.example.test", secondaryToken, "fake-secondary-user"]
  ] as const) {
    test(`开启后 viewer 的 ${pid} 查询使用对应正式站点并经过真实日看板服务`, async () => {
      const harness = await createHarness({ identityProvider: identity({ ...viewer, pidScope: [pid] }) });
      const catalog = await harness.request("GET", catalogPath);
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json().data.enabled).toBe(true);
      expect(harness.observedRequests).toHaveLength(0);
      assertValue(await harness.request("POST", queryPath, { ...query, pid }), value);
      expect(harness.observedRequests).toHaveLength(1);
      expect(harness.observedRequests[0]).toMatchObject({ token, userName });
      expect(harness.observedRequests[0].url.hostname).toBe(hostname);
      expect(harness.observedRequests[0].url.searchParams.get("pid")).toBe(pid);
      expect(existsSync(harness.credentialsFile)).toBe(false);
    });
  }

  for (const nodeEnv of ["test", "development"] as const) {
    test(`${nodeEnv} 中正式 flag 不扩大本地读取权限`, async () => {
      const harness = await createHarness({ env: { NODE_ENV: nodeEnv } });
      expect((await harness.request("GET", catalogPath)).json().data.enabled).toBe(false);
      const response = await harness.request("POST", queryPath, query);
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("DAILY_READING_DISABLED");
      expect(harness.observedRequests).toHaveLength(0);
    });
  }

  test("非生产 loopback 的既有本地读取入口保持可用", async () => {
    const harness = await createHarness({ env: { NODE_ENV: "test", BI_PRODUCTION_DASHBOARD_READING_ENABLED: false, BI_LOCAL_DASHBOARD_READING_ENABLED: true } });
    expect((await harness.request("GET", catalogPath)).json().data.enabled).toBe(true);
    assertValue(await harness.request("POST", queryPath, query), 17);
  });

  test("缺少身份装配时正式开关保持失败关闭", async () => {
    const harness = await createHarness({ identityProvider: null });
    for (const response of [await harness.request("GET", catalogPath), await harness.request("POST", queryPath, query)]) {
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
    }
    expect(harness.observedRequests).toHaveLength(0);
  });

  for (const [name, provider, status, code] of [
    ["未登录", resolutionIdentity({ status: "unauthenticated" }), 401, "AUTHENTICATION_REQUIRED"],
    ["身份来源不可用", resolutionIdentity({ status: "unavailable" }), 503, "IDENTITY_PROVIDER_UNAVAILABLE"],
    ["身份来源异常", { resolve: async () => { throw new Error("fake identity failure"); } }, 503, "IDENTITY_PROVIDER_UNAVAILABLE"],
    ["无 bi:read", identity({ ...viewer, permissions: [] }), 403, "BI_READ_ACCESS_DENIED"]
  ] as const) {
    test(`${name} 时正式目录和查询均失败关闭且零上游`, async () => {
      const harness = await createHarness({ identityProvider: provider });
      for (const response of [await harness.request("GET", catalogPath), await harness.request("POST", queryPath, query)]) {
        expect(response.statusCode).toBe(status);
        expect(response.json().error.code).toBe(code);
      }
      expect(harness.observedRequests).toHaveLength(0);
    });
  }

  for (const [name, pidScope, pid] of [
    ["跨 PID", ["PH"], "FBI"], ["未知 PID", "all", "UNKNOWN"], ["空 PID 范围", [], "PH"]
  ] as const) {
    test(`${name} 请求返回 PID_ACCESS_DENIED 且零上游`, async () => {
      const harness = await createHarness({ identityProvider: identity({ ...viewer, pidScope }) });
      const response = await harness.request("POST", queryPath, { ...query, pid });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("PID_ACCESS_DENIED");
      expect(harness.observedRequests).toHaveLength(0);
    });
  }

  test("正式开关不绕过 HTTPS 与可信代理边界", async () => {
    const harness = await createHarness();
    const noHttps = await harness.app.inject({ method: "POST", url: queryPath, payload: query });
    expect(noHttps.statusCode).toBe(426);
    expect(noHttps.json().error.code).toBe("HTTPS_REQUIRED");
    const noClientIp = await harness.app.inject({ method: "POST", url: queryPath, payload: query, remoteAddress: "127.0.0.1", headers: { "x-forwarded-proto": "https" } });
    expect(noClientIp.statusCode).toBe(503);
    expect(noClientIp.json().error.code).toBe("AUTH_PROXY_MISCONFIGURED");
    expect(harness.observedRequests).toHaveLength(0);
  });

  test("正式关闭后现有有效测试会话仍可独立读取", async () => {
    const harness = await createHarness({ identityProvider: identity(maintainer), env: {
      BI_PRODUCTION_DASHBOARD_READING_ENABLED: false, BI_TEST_DATA_PREVIEW_ENABLED: true,
      UPSTREAM_TEST_API_BASE_URL: "https://preview.example.test", UPSTREAM_TEST_USER_NAME: "fake-preview-user"
    } });
    const headers = await activatePreview(harness);
    expect((await harness.request("GET", catalogPath, undefined, headers)).json().data.enabled).toBe(true);
    assertValue(await harness.request("POST", queryPath, query, headers), 31);
    expect(harness.observedRequests).toHaveLength(1);
    const production = await harness.request("POST", queryPath, query, { cookie: headers.cookie });
    expect(production.statusCode).toBe(422);
    expect(production.json().error.code).toBe("DAILY_READING_DISABLED");
    expect(harness.observedRequests).toHaveLength(1);
    expect(harness.observedRequests[0]).toMatchObject({ token: previewToken, userName: "fake-preview-user" });
  });

  test("正式与测试读取隔离上游 profile、凭据和同查询缓存", async () => {
    const harness = await createHarness({ identityProvider: identity(maintainer), env: {
      BI_TEST_DATA_PREVIEW_ENABLED: true, UPSTREAM_TEST_API_BASE_URL: "https://preview.example.test", UPSTREAM_TEST_USER_NAME: "fake-preview-user"
    } });
    const testHeaders = await activatePreview(harness);
    assertValue(await harness.request("POST", queryPath, query, { cookie: testHeaders.cookie }), 17);
    assertValue(await harness.request("POST", queryPath, query, testHeaders), 31);
    assertValue(await harness.request("POST", queryPath, { ...query, pid: "FBI" }, testHeaders), 31);
    assertValue(await harness.request("POST", queryPath, query, { cookie: testHeaders.cookie, "x-ypbi-data-environment": "production" }), 17);
    expect(harness.observedRequests).toHaveLength(3);
    expect(harness.observedRequests.map(item => [item.url.hostname, item.token, item.userName])).toEqual([
      ["primary.example.test", primaryToken, "fake-primary-user"],
      ["preview.example.test", previewToken, "fake-preview-user"],
      ["preview.example.test", previewToken, "fake-preview-user"]
    ]);
    expect((await harness.request("GET", "/api/bi/v2/data-environment", undefined, testHeaders)).json().data.mode).toBe("test");
    expect((await harness.request("GET", "/api/bi/v2/data-environment", undefined, { cookie: testHeaders.cookie })).json().data.mode).toBe("production");
    expect(existsSync(harness.credentialsFile)).toBe(false);
  });

  test("正式异步独立关闭时保留同步，测试预览仍可独立装配经营异步", async () => {
    const harness = await createHarness({ identityProvider: identity(maintainer), env: {
      BI_TEST_DATA_PREVIEW_ENABLED: true, UPSTREAM_TEST_API_BASE_URL: "https://preview.example.test", UPSTREAM_TEST_USER_NAME: "fake-preview-user"
    } });
    const productionCatalog = await harness.request("GET", catalogPath);
    expect(productionCatalog.json().data.enabled).toBe(true);
    expect(productionCatalog.json().data.operatingAsyncEnabled).toBe(false);
    expect(productionCatalog.json().data.operatingAsyncPidGroups).toBeUndefined();
    const production = await harness.request("POST", "/api/bi/v2/queries/jobs", { kind: "operating-snapshot", pids: ["PH"], date: "2026-10-17" });
    expect(production.statusCode).toBe(422); expect(production.json().error.code).toBe("QUERY_JOBS_DISABLED");
    expect(harness.observedRequests).toHaveLength(0);
    const headers = await activatePreview(harness);
    const testCatalog = await harness.request("GET", catalogPath, undefined, headers);
    expect(testCatalog.json().data.operatingAsyncEnabled).toBe(true);
    expect(testCatalog.json().data.operatingAsyncPidGroups.flat()).toContain("PH");
    expect(testCatalog.json().data.operatingAsyncPidGroups.flat()).toContain("FBI");
    // Invalid input reaches the assembled service without issuing any upstream request.
    for (const payload of [{}, { kind: "operating-snapshot", pids: ["PH"], date: "invalid" }]) {
      const response = await harness.request("POST", "/api/bi/v2/queries/jobs", payload, headers);
      expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe("QUERY_JOB_INVALID");
    }
    expect(harness.observedRequests).toHaveLength(0);
    expect(existsSync(harness.credentialsFile)).toBe(false);
  });

  test("正式异步及测试预览关闭时异步入口和目录信号同时关闭", async () => {
    const harness = await createHarness();
    expect((await harness.request("GET", catalogPath)).json().data.operatingAsyncEnabled).toBe(false);
    for (const headers of [{}, { "x-ypbi-data-environment": "test" }] as Record<string, string>[]) {
      const response = await harness.request("POST", "/api/bi/v2/queries/jobs", { kind: "operating-snapshot", pids: ["PH"], date: "2026-10-17" }, headers);
      expect(response.json().error.code).toBe("x-ypbi-data-environment" in headers ? "DATA_PREVIEW_DISABLED" : "QUERY_JOBS_DISABLED");
    }
    expect(harness.observedRequests).toHaveLength(0);
  });

  for (const [pid, hostname, token, userName] of [
    ["PH", "primary.example.test", primaryToken, "fake-primary-user"],
    ["FBI", "secondary.example.test", secondaryToken, "fake-secondary-user"]
  ] as const) test(`正式${pid}独立于测试预览装配真实三步与93列投影，全部调用使用本站凭据`, async () => {
    const harness = await createHarness({ env: { BI_PRODUCTION_OPERATING_ASYNC_ENABLED: true }, identityProvider: identity({ ...viewer, pidScope: [pid] }) });
    const catalog = (await harness.request("GET", catalogPath)).json().data;
    expect(catalog.operatingAsyncEnabled).toBe(true); expect(catalog.operatingAsyncPidGroups).toEqual([[pid]]);
    const created = await harness.request("POST", "/api/bi/v2/queries/jobs", { kind: "operating-snapshot", pids: [pid], date: "2026-10-17" });
    expect(created.statusCode).toBe(200);
    const handle = created.json().data.handle;
    const status = await harness.request("GET", `/api/bi/v2/queries/jobs/${handle}`);
    expect(status.statusCode).toBe(200); expect(status.json().data.status).toBe("SUCCEEDED");
    let result = await harness.request("GET", `/api/bi/v2/queries/jobs/${handle}/result`);
    for (let attempt = 0; attempt < 4 && result.json().data.phase !== "complete"; attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      result = await harness.request("GET", `/api/bi/v2/queries/jobs/${handle}/result`);
    }
    expect(result.statusCode).toBe(200); expect(result.json().data.phase).toBe("complete");
    const dashboard = dailyDashboardSuccessSchema.parse(result.json().data.dashboards[0]);
    expect(dashboard.data.query.pid).toBe(pid);
    expect(dashboard.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
    const jobCalls = harness.observedRequests.filter(item => item.url.pathname.startsWith("/api/admin/bi/v1/queryJobs"));
    expect(jobCalls.map(item => [item.method, item.url.pathname.endsWith("/result")])).toContainEqual(["POST", false]);
    expect(jobCalls.some(item => item.method === "GET" && !item.url.pathname.endsWith("/result"))).toBe(true);
    expect(jobCalls.some(item => item.url.pathname.endsWith("/result"))).toBe(true);
    const body = jobCalls.find(item => item.method === "POST")!.body as QueryJobCreateRequest;
    expect(body.queries.every(unit => unit.query.pid === pid)).toBe(true);
    expect(harness.observedRequests.every(item => item.url.hostname === hostname && item.token === token && item.userName === userName)).toBe(true);
    expect(harness.observedRequests.every(item => !/bi\/v1\/(metrics|playback)/.test(item.url.pathname))).toBe(true);
    expect(result.body).not.toContain(token); expect(existsSync(harness.credentialsFile)).toBe(false);
  });

  for (const env of [
    { BI_PRODUCTION_DASHBOARD_READING_ENABLED: false }, { NODE_ENV: "test" as const }, { NODE_ENV: "development" as const, BI_LOCAL_DASHBOARD_READING_ENABLED: true }
  ]) test(`正式异步flag不越过正式日读取与运行环境准入${JSON.stringify(env)}`, async () => {
    const harness = await createHarness({ env: { BI_PRODUCTION_OPERATING_ASYNC_ENABLED: true, ...env } });
    expect((await harness.request("GET", catalogPath)).json().data.operatingAsyncEnabled).toBe(false);
    const response = await harness.request("POST", "/api/bi/v2/queries/jobs", { kind: "operating-snapshot", pids: ["PH"], date: "2026-10-17" });
    expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe("QUERY_JOBS_DISABLED");
    expect(harness.observedRequests).toHaveLength(0);
  });

  test("正式异步与有效测试会话分别绑定来源，跨环境句柄和失效测试意图零回退", async () => {
    const harness = await createHarness({ identityProvider: identity(maintainer), env: {
      BI_PRODUCTION_OPERATING_ASYNC_ENABLED: true, BI_TEST_DATA_PREVIEW_ENABLED: true,
      UPSTREAM_TEST_API_BASE_URL: "https://preview.example.test", UPSTREAM_TEST_USER_NAME: "fake-preview-user"
    } });
    const headers = await activatePreview(harness);
    const payload = { kind: "operating-snapshot", pids: ["PH"], date: "2026-10-17" };
    const production = await harness.request("POST", "/api/bi/v2/queries/jobs", payload);
    const preview = await harness.request("POST", "/api/bi/v2/queries/jobs", payload, headers);
    expect(production.statusCode).toBe(200); expect(preview.statusCode).toBe(200);
    await new Promise<void>(resolve => setImmediate(resolve));
    const count = harness.observedRequests.length;
    for (const [handle, environmentHeaders] of [[production.json().data.handle, headers], [preview.json().data.handle, {}]] as const) {
      for (const suffix of ["", "/result"]) {
        const response = await harness.request("GET", `/api/bi/v2/queries/jobs/${handle}${suffix}`, undefined, environmentHeaders);
        expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe("QUERY_JOB_CONTEXT_CHANGED");
      }
    }
    const missing = await harness.request("POST", "/api/bi/v2/queries/jobs", payload, { "x-ypbi-data-environment": "test" });
    expect(missing.statusCode).toBe(409); expect(missing.json().error.code).toBe("DATA_PREVIEW_SESSION_REQUIRED");
    expect(harness.observedRequests).toHaveLength(count);
    expect(harness.observedRequests.some(item => item.url.hostname === "primary.example.test" && item.token === primaryToken)).toBe(true);
    expect(harness.observedRequests.some(item => item.url.hostname === "preview.example.test" && item.token === previewToken)).toBe(true);
    expect(harness.observedRequests.every(item => item.url.hostname === "primary.example.test" ? item.token === primaryToken : item.url.hostname === "preview.example.test" && item.token === previewToken)).toBe(true);
  });

  test("测试会话缺失、更换普通会话或撤销后绝不回退正式读取", async () => {
    const harness = await createHarness({ identityProvider: identity(maintainer), env: {
      BI_TEST_DATA_PREVIEW_ENABLED: true, UPSTREAM_TEST_API_BASE_URL: "https://preview.example.test", UPSTREAM_TEST_USER_NAME: "fake-preview-user"
    } });
    const testHeaders = await activatePreview(harness);
    for (const headers of [
      { "x-ypbi-data-environment": "test" },
      { ...testHeaders, cookie: testHeaders.cookie.replace(ordinarySession, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB") }
    ]) {
      for (const response of [await harness.request("GET", catalogPath, undefined, headers), await harness.request("POST", queryPath, query, headers)]) {
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("DATA_PREVIEW_SESSION_REQUIRED");
      }
    }
    const deactivate = await harness.request("POST", "/api/bi/admin/data-preview/deactivate", undefined, { cookie: testHeaders.cookie });
    expect(deactivate.statusCode).toBe(200);
    const revoked = await harness.request("POST", queryPath, query, testHeaders);
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().error.code).toBe("DATA_PREVIEW_SESSION_REQUIRED");
    expect(harness.observedRequests).toHaveLength(0);
    assertValue(await harness.request("POST", queryPath, query), 17);
  });
});
