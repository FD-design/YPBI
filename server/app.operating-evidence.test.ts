import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { dailyDashboardSuccessSchema } from "../contracts/daily-dashboard";
import { buildApp } from "./app";
import type { BiAuthService } from "./auth/service";
import type { AppEnv } from "./config/env";
import type { IdentityProvider, IdentityResolution, Principal } from "./identity/identity-provider";
import type { OperatingEvidenceBusinessRow, OperatingEvidenceCall } from "./v2/operating-evidence-collector";

const publicOrigin = "https://bi.example.test";
const maintenancePassword = "fake-operating-evidence-maintenance-password";
const primaryToken = "fake-operating-evidence-primary-token-0001";
const secondaryToken = "fake-operating-evidence-secondary-token-0002";
const previewToken = "fake-operating-evidence-preview-token-0003";
const ordinarySession = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const csrfToken = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ordinaryCookie = `__Host-ypbi_session=${ordinarySession}`;
const evidencePath = "/api/bi/admin/data-sources/operating-evidence";
const businessDate = "2026-10-12";
const principal: Principal = {
  subjectId: "fake-evidence-maintainer", roles: ["maintainer"],
  permissions: ["bi:read", "bi:data-source-maintenance:enter"], pidScope: "all", securityVersion: "1"
};
const openApps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];
const originalFetch = globalThis.fetch;

interface ObservedRequest { url: URL; token: string | null; userName: string | null }

afterEach(async () => {
  setSystemTime();
  await Promise.all(openApps.splice(0).map(app => app.close()));
  globalThis.fetch = originalFetch;
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function evidenceUrl(parameters: Partial<Record<"pid" | "date" | "view" | "environment", string>> = {}) {
  return `${evidencePath}?${new URLSearchParams({ pid: "PH", date: businessDate, view: "snapshot", environment: "production", ...parameters })}`;
}

function rawBusinessPayload(url: URL) {
  if (["/api/admin/bi/v1/metrics", "/api/admin/bi/v1/playback"].includes(url.pathname)) {
    const pid = url.searchParams.get("pid");
    const filters = JSON.parse(url.searchParams.get("dimensionFilters") ?? "{}") as Record<string, string>;
    const codes = (url.searchParams.get("metricCodes") ?? "").split(",").filter(Boolean);
    const rows = codes.flatMap(metricCode => {
      const row = {
        metricCode, dimensions: { pid, ...filters, ...(url.pathname.endsWith("/playback") ? { videoType: "long" } : {}) },
        value: null, numerator: 8, denominator: 10,
        unit: ["M058"].includes(metricCode) ? "currency" : metricCode === "M102" ? "seconds" : ["M020", "M034", "M061", "M064"].includes(metricCode) ? "ratio" : "count",
        dataStatus: metricCode === "M020" ? "SOURCE_INCOMPLETE" : "PROCESSING", metricVersion: "bi-v1", ruleVersion: "fixture_rule_v1",
        token: primaryToken, cookie: ordinaryCookie, authorization: `Bearer ${secondaryToken}`
      };
      return [{ ...row, businessDate: url.searchParams.get("startDate") }, row];
    });
    return {
      code: 200, token: primaryToken,
      msg: { metricVersion: "bi-v1", generatedAt: "2026-10-15T00:00:00.000Z", watermark: "2026-10-12T23:59:59+08:00", rows, password: maintenancePassword }
    };
  }
  return { code: 200, msg: { pageData: [], totalCount: 0 } };
}

async function createHarness(options: {
  env?: Partial<AppEnv>;
  resolution?: IdentityResolution;
  response?: (request: ObservedRequest) => Response | Promise<Response>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ypbi-operating-evidence-"));
  temporaryDirectories.push(directory);
  const observedRequests: ObservedRequest[] = [];
  let currentResolution = options.resolution ?? { status: "authenticated" as const, principal };
  const identityProvider: IdentityProvider = { resolve: async () => currentResolution };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    const observed = { url, token: headers.get("x-token"), userName: headers.get("name") };
    observedRequests.push(observed);
    if (!["primary.example.test", "secondary.example.test", "preview.example.test"].includes(url.hostname)) throw new Error("Unexpected fake upstream origin");
    return options.response?.(observed) ?? new Response(JSON.stringify(rawBusinessPayload(url)), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const env: AppEnv = {
    NODE_ENV: "production", HOST: "127.0.0.1", PORT: 3000,
    UPSTREAM_API_BASE_URL: "https://primary.example.test", UPSTREAM_X_TOKEN: primaryToken, UPSTREAM_USER_NAME: "fake-primary-user",
    UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.test", UPSTREAM_SECONDARY_X_TOKEN: secondaryToken, UPSTREAM_SECONDARY_USER_NAME: "fake-secondary-user",
    UPSTREAM_TEST_API_BASE_URL: "https://preview.example.test", UPSTREAM_TEST_USER_NAME: "fake-preview-user",
    UPSTREAM_CREDENTIALS_FILE: join(directory, "upstream-credentials.json"), WORKSPACE_FILE: join(directory, "workspace.json"),
    TOKEN_MAINTENANCE_KEY: maintenancePassword, BI_PUBLIC_ORIGIN: publicOrigin,
    BI_V2_CORE_OVERVIEW_QUERY_ENABLED: false, BI_LOCAL_DASHBOARD_READING_ENABLED: false,
    BI_PRODUCTION_DASHBOARD_READING_ENABLED: true, BI_TEST_DATA_PREVIEW_ENABLED: true,
    BI_PRODUCTION_OPERATING_ASYNC_ENABLED: false,
    REQUEST_TIMEOUT_MS: 1_000, MAX_PLATFORM_CONCURRENCY: 1, ...options.env
  };
  const authService = { csrfMatches: (session: string, csrf: string | undefined) => session === ordinarySession && csrf === csrfToken } as BiAuthService;
  const app = await buildApp(env, { identityProvider, authService });
  openApps.push(app);
  const request = (method: "GET" | "POST" | "HEAD", url: string, payload?: InjectOptions["payload"], headers: Record<string, string> = {}): Promise<LightMyRequestResponse> => app.inject({
    method, url, payload, remoteAddress: "127.0.0.1",
    headers: {
      "x-forwarded-proto": "https", "x-forwarded-for": "192.0.2.11", cookie: ordinaryCookie,
      ...(method === "POST" ? { origin: publicOrigin, "x-csrf-token": csrfToken } : {}), ...headers
    }
  });
  return {
    app, request, observedRequests, credentialsFile: env.UPSTREAM_CREDENTIALS_FILE,
    setResolution(resolution: IdentityResolution) { currentResolution = resolution; }
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

function cookieByName(header: string | string[] | undefined, name: string) {
  const matches = (Array.isArray(header) ? header : header ? [header] : []).filter(value => value.startsWith(`${name}=`));
  expect(matches).toHaveLength(1);
  return matches[0].split(";", 1)[0];
}

async function login(harness: Harness) {
  const response = await harness.request("POST", "/api/bi/admin/auth/login", { password: maintenancePassword });
  expect(response.statusCode).toBe(200);
  return { cookie: `${ordinaryCookie}; ${cookieByName(response.headers["set-cookie"], "bi_maintenance_session")}` };
}

async function activatePreview(harness: Harness) {
  const headers = await login(harness);
  const response = await harness.request("POST", "/api/bi/admin/data-preview/activate", { token: previewToken }, headers);
  expect(response.statusCode).toBe(200);
  expect(harness.observedRequests).toHaveLength(2);
  expect(harness.observedRequests.every(item => item.url.hostname === "preview.example.test" && item.token === previewToken && item.userName === "fake-preview-user")).toBe(true);
  harness.observedRequests.splice(0);
  return { cookie: `${headers.cookie}; ${cookieByName(response.headers["set-cookie"], "ypbi_data_preview")}` };
}

function assertNoSecrets(response: LightMyRequestResponse) {
  for (const secret of [maintenancePassword, primaryToken, secondaryToken, previewToken, ordinarySession, csrfToken, "fake-primary-user", "fake-secondary-user", "fake-preview-user", "primary.example.test", "secondary.example.test", "preview.example.test", "Bearer "]) {
    expect(response.body).not.toContain(secret);
  }
}

function assertRejected(response: LightMyRequestResponse, status: number, code?: string) {
  expect(response.statusCode).toBe(status);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toMatchObject({ success: false, error: { code: expect.any(String), message: expect.any(String) } });
  if (code) expect(response.json().error.code).toBe(code);
  assertNoSecrets(response);
}

describe("经营原始业务取证下载的路由边界", () => {
  for (const [name, resolution, status, code] of [
    ["匿名", { status: "unauthenticated" }, 401, "AUTHENTICATION_REQUIRED"],
    ["无维护入口权限", { status: "authenticated", principal: { ...principal, permissions: ["bi:read"] } }, 403, "ADMIN_ACCESS_DENIED"]
  ] as const) {
    test(`${name} 拒绝且零上游请求`, async () => {
      const harness = await createHarness({ resolution });
      assertRejected(await harness.request("GET", evidenceUrl()), status, code);
      expect(harness.observedRequests).toHaveLength(0);
    });
  }

  test("无维护二次认证时拒绝且零上游请求", async () => {
    const harness = await createHarness();
    assertRejected(await harness.request("GET", evidenceUrl()), 401, "MAINTENANCE_LOGIN_REQUIRED");
    expect(harness.observedRequests).toHaveLength(0);
  });

  test("维护二次认证不替代 bi:read 权限", async () => {
    const harness = await createHarness({ resolution: { status: "authenticated", principal: { ...principal, permissions: ["bi:data-source-maintenance:enter"] } } });
    const headers = await login(harness);
    assertRejected(await harness.request("GET", evidenceUrl(), undefined, headers), 403, "BI_READ_ACCESS_DENIED");
    expect(harness.observedRequests).toHaveLength(0);
  });

  for (const [name, pidScope, pid, status, code] of [
    ["跨PID", ["PH"], "FBI", 403, "PID_ACCESS_DENIED"],
    ["空PID范围", [], "PH", 403, "PID_ACCESS_DENIED"],
    ["未知PID", "all", "UNKNOWN", 422, "UPSTREAM_PID_NOT_AVAILABLE"]
  ] as const) {
    test(`${name} 拒绝且零上游请求`, async () => {
      const harness = await createHarness({ resolution: { status: "authenticated", principal: { ...principal, pidScope } } });
      const headers = await login(harness);
      assertRejected(await harness.request("GET", evidenceUrl({ pid }), undefined, headers), status, code);
      expect(harness.observedRequests).toHaveLength(0);
    });
  }

  for (const query of [
    "pid=PH&date=2026-10-12&view=snapshot",
    "pid=PH&date=2026-10-12&environment=production",
    "pid=PH&date=2026-10-12&view=snapshot&environment=production&url=https%3A%2F%2Funtrusted.example",
    "pid=PH&date=2026-10-12&view=snapshot&environment=production&token=not-accepted",
    "pid=PH&pid=FBI&date=2026-10-12&view=snapshot&environment=production",
    "pid=PH&date=2026-02-30&view=snapshot&environment=production",
    "pid=PH&date=2026-10-12&view=raw&environment=production",
    "pid=PH&date=2026-10-12&view=snapshot&environment=staging"
  ]) {
    test(`严格参数拒绝 ${query}`, async () => {
      const harness = await createHarness();
      const headers = await login(harness);
      assertRejected(await harness.request("GET", `${evidencePath}?${query}`, undefined, headers), 400);
      expect(harness.observedRequests).toHaveLength(0);
    });
  }

  test("环境头与显式环境query冲突时拒绝且零上游请求", async () => {
    const harness = await createHarness();
    const headers = await login(harness);
    assertRejected(await harness.request("GET", evidenceUrl(), undefined, { ...headers, "x-ypbi-data-environment": "test" }), 400);
    expect(harness.observedRequests).toHaveLength(0);
  });

  test("关闭正式读取门禁后维护会话也不能取证", async () => {
    const harness = await createHarness({ env: { BI_PRODUCTION_DASHBOARD_READING_ENABLED: false } });
    const headers = await login(harness);
    assertRejected(await harness.request("GET", evidenceUrl(), undefined, headers), 422, "DAILY_READING_DISABLED");
    expect(harness.observedRequests).toHaveLength(0);
  });

  test("测试意图缺少测试会话时不回退正式站点", async () => {
    const harness = await createHarness();
    const headers = await login(harness);
    assertRejected(await harness.request("GET", evidenceUrl({ environment: "test" }), undefined, headers), 409, "DATA_PREVIEW_SESSION_REQUIRED");
    expect(harness.observedRequests).toHaveLength(0);
  });

  test("HEAD不运行取证服务", async () => {
    const harness = await createHarness();
    const headers = await login(harness);
    const response = await harness.request("HEAD", evidenceUrl(), undefined, headers);
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(harness.observedRequests).toHaveLength(0);
  });

  test("GET下载不要求CSRF和Origin，生产HTTPS与代理仍强制", async () => {
    const harness = await createHarness();
    const headers = await login(harness);
    const noHttps = await harness.app.inject({ method: "GET", url: evidenceUrl(), headers });
    assertRejected(noHttps, 426, "HTTPS_REQUIRED");
    const noIp = await harness.app.inject({
      method: "GET", url: evidenceUrl(), remoteAddress: "127.0.0.1", headers: { ...headers, "x-forwarded-proto": "https" }
    });
    assertRejected(noIp, 503, "MAINTENANCE_PROXY_MISCONFIGURED");
    expect(harness.observedRequests).toHaveLength(0);
    const response = await harness.request("GET", evidenceUrl(), undefined, headers);
    expect(response.statusCode).toBe(200);
    assertNoSecrets(response);
  });

  for (const [pid, site, hostname, token, userName] of [
    ["PH", "primary", "primary.example.test", primaryToken, "fake-primary-user"],
    ["FBI", "secondary", "secondary.example.test", secondaryToken, "fake-secondary-user"]
  ] as const) {
    test(`${pid} 下载复用对应正式站点凭据并保留适配前非READY业务字段`, async () => {
      const harness = await createHarness();
      const headers = await login(harness);
      const response = await harness.request("GET", evidenceUrl({ pid }), undefined, headers);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["content-disposition"]).toContain("attachment;");
      const result = response.json();
      expect(result).toMatchObject({ success: true, data: { schemaVersion: "operating-evidence/v1", environment: "production", site, query: { boardId: "5.2", pid, dateRange: ["2026-10-05", businessDate], projection: "operating_snapshot" } } });
      expect(typeof result.data.observedAt).toBe("string");
      expect(result.data.boundary).toEqual({ kind: "upstream-client-business-field-projection", rawHttp: false, cacheSemantics: "existing-upstream-client-cache-and-inflight", httpStatusAvailable: false, metricAcceptanceGranted: false });
      expect(dailyDashboardSuccessSchema.safeParse(result.data.projection).success).toBe(true);
      expect(result.data.projection.data.series.some((series: { metric: { id: string } }) => series.metric.id === "M016")).toBe(true);
      const calls: OperatingEvidenceCall[] = result.data.calls;
      expect(Array.isArray(calls)).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(call => ["metrics", "playback"].includes(call.source) && call.params.pid === pid && call.state === "fulfilled" && call.httpStatus === null && call.cacheHit === null)).toBe(true);
      const rows = calls.flatMap(call => call.response?.rows ?? []).filter((row): row is OperatingEvidenceBusinessRow => row.scope === "in_scope");
      for (const [metricCode, dataStatus] of [["M016", "PROCESSING"], ["M020", "SOURCE_INCOMPLETE"]] as const) {
        for (const dateScope of ["dated", "undated"] as const) {
          const row = rows.find(item => item.metricCode === metricCode && item.dateScope === dateScope);
          expect(row).toBeDefined();
          expect(row).toMatchObject({ dimensions: { pid }, dataStatus, value: null, numerator: 8, denominator: 10, omittedFieldCount: 3 });
          expect(Object.hasOwn(row!, "businessDate")).toBe(dateScope === "dated");
        }
      }
      expect(harness.observedRequests.length).toBeGreaterThan(1);
      expect(harness.observedRequests.every(item => item.url.hostname === hostname && item.token === token && item.userName === userName && item.url.searchParams.get("pid") === pid)).toBe(true);
      expect(harness.observedRequests.some(item => item.url.pathname === "/api/admin/bi/v1/metrics")).toBe(true);
      expect(harness.observedRequests.some(item => item.url.pathname === "/api/admin/bi/v1/playback")).toBe(true);
      expect(existsSync(harness.credentialsFile)).toBe(false);
      assertNoSecrets(response);
    });
  }

  test("day只查询所选单日并保持原日看板契约", async () => {
    const harness = await createHarness();
    const headers = await login(harness);
    const response = await harness.request("GET", evidenceUrl({ view: "day" }), undefined, headers);
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.data.query).toEqual({ boardId: "5.2", pid: "PH", dateRange: [businessDate, businessDate] });
    expect(dailyDashboardSuccessSchema.safeParse(result.data.projection).success).toBe(true);
    const requests = harness.observedRequests.filter(item => item.url.pathname === "/api/admin/bi/v1/metrics" && item.url.searchParams.get("granularity") !== "summary");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(item => item.url.searchParams.get("startDate") === businessDate && item.url.searchParams.get("endDate") === "2026-10-13")).toBe(true);
    assertNoSecrets(response);
  });

  test("测试取证独立使用有效预览会话且不写凭据文件", async () => {
    const harness = await createHarness({ env: { BI_PRODUCTION_DASHBOARD_READING_ENABLED: false } });
    const headers = await activatePreview(harness);
    const response = await harness.request("GET", evidenceUrl({ pid: "FBI", environment: "test" }), undefined, headers);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ environment: "test", site: "test", query: { pid: "FBI" } });
    expect(harness.observedRequests.length).toBeGreaterThan(1);
    expect(harness.observedRequests.every(item => item.url.hostname === "preview.example.test" && item.token === previewToken && item.userName === "fake-preview-user")).toBe(true);
    expect(existsSync(harness.credentialsFile)).toBe(false);
    assertNoSecrets(response);
  });

  test("测试会话24小时到期后拒绝且不回退正式读取", async () => {
    const clockStart = Date.now();
    setSystemTime(new Date(clockStart));
    const harness = await createHarness();
    const headers = await activatePreview(harness);
    setSystemTime(new Date(clockStart + 24 * 60 * 60_000 + 1_000));
    assertRejected(await harness.request("GET", evidenceUrl({ environment: "test" }), undefined, headers), 409, "DATA_PREVIEW_SESSION_REQUIRED");
    expect(harness.observedRequests).toHaveLength(0);
  });

  test("同subject的60秒限流不扩大到其他subject", async () => {
    const harness = await createHarness();
    const headers = await login(harness);
    expect((await harness.request("GET", evidenceUrl(), undefined, headers)).statusCode).toBe(200);
    const completedCalls = harness.observedRequests.length;
    assertRejected(await harness.request("GET", evidenceUrl({ view: "day" }), undefined, headers), 429);
    expect(harness.observedRequests).toHaveLength(completedCalls);
    harness.setResolution({ status: "authenticated", principal: { ...principal, subjectId: "fake-independent-subject" } });
    const otherHeaders = await login(harness);
    expect((await harness.request("GET", evidenceUrl({ view: "day" }), undefined, otherHeaders)).statusCode).toBe(200);
    expect(harness.observedRequests.length).toBeGreaterThan(completedCalls);
  });

  test("一分钟冷却到期后当前subject可再次下载", async () => {
    const clockStart = Date.now();
    setSystemTime(new Date(clockStart));
    const harness = await createHarness();
    const headers = await login(harness);
    expect((await harness.request("GET", evidenceUrl(), undefined, headers)).statusCode).toBe(200);
    assertRejected(await harness.request("GET", evidenceUrl(), undefined, headers), 429, "OPERATING_EVIDENCE_RATE_LIMITED");
    setSystemTime(new Date(clockStart + 60_000));
    const response = await harness.request("GET", evidenceUrl(), undefined, headers);
    expect(response.statusCode).toBe(200);
    assertNoSecrets(response);
  });

  test("全局仅容纳两份并行取证且完成后释放容量", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let primaryStarted!: () => void, secondaryStarted!: () => void;
    const primaryRead = new Promise<void>(resolve => { primaryStarted = resolve; });
    const secondaryRead = new Promise<void>(resolve => { secondaryStarted = resolve; });
    const harness = await createHarness({ response: async ({ url }) => {
      if (url.pathname === "/api/admin/bi/v1/metrics") {
        if (url.searchParams.get("pid") === "PH") primaryStarted();
        if (url.searchParams.get("pid") === "FBI") secondaryStarted();
        await held;
      }
      return new Response(JSON.stringify(rawBusinessPayload(url)), { headers: { "content-type": "application/json" } });
    } });
    const firstHeaders = await login(harness);
    const first = harness.request("GET", evidenceUrl(), undefined, firstHeaders);
    try {
      await primaryRead;
      harness.setResolution({ status: "authenticated", principal: { ...principal, subjectId: "fake-second-concurrent-subject" } });
      const secondHeaders = await login(harness);
      const second = harness.request("GET", evidenceUrl({ pid: "FBI" }), undefined, secondHeaders);
      await secondaryRead;
      harness.setResolution({ status: "authenticated", principal: { ...principal, subjectId: "fake-third-concurrent-subject" } });
      const thirdHeaders = await login(harness);
      const activeCalls = harness.observedRequests.length;
      const denied = await harness.request("GET", evidenceUrl(), undefined, thirdHeaders);
      assertRejected(denied, 429, "OPERATING_EVIDENCE_RATE_LIMITED");
      expect(denied.headers["retry-after"]).toBe("60");
      expect(harness.observedRequests).toHaveLength(activeCalls);
      release();
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);
      const restored = await harness.request("GET", evidenceUrl(), undefined, thirdHeaders);
      expect(restored.statusCode).toBe(200);
      assertNoSecrets(restored);
    } finally {
      release();
      await first;
    }
  });

  test("上游错误正文中的凭据和认证头不会进入下载或来源错误", async () => {
    const harness = await createHarness({ response: ({ url }) => new Response(JSON.stringify(
      url.pathname.startsWith("/api/admin/bi/v1/")
        ? { code: 422, err: `x-token=${primaryToken}; cookie=${ordinaryCookie}; Authorization: Bearer ${secondaryToken}; password=${maintenancePassword}` }
        : rawBusinessPayload(url)
    ), { status: url.pathname.startsWith("/api/admin/bi/v1/") ? 422 : 200, headers: { "content-type": "application/json" } }) });
    const headers = await login(harness);
    const response = await harness.request("GET", evidenceUrl(), undefined, headers);
    expect(response.statusCode).toBe(200);
    const calls: OperatingEvidenceCall[] = response.json().data.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.state === "rejected" && call.response === null && typeof call.errorCode === "string")).toBe(true);
    expect(dailyDashboardSuccessSchema.safeParse(response.json().data.projection).success).toBe(true);
    assertNoSecrets(response);
  });

  test("未来业务日不能启动上游读取且错误保持安全结构", async () => {
    const harness = await createHarness();
    const headers = await login(harness);
    assertRejected(await harness.request("GET", evidenceUrl({ date: "2999-01-01" }), undefined, headers), 400, "INVALID_OPERATING_EVIDENCE_QUERY");
    expect(harness.observedRequests).toHaveLength(0);
  });

  test("本地读取仅在非生产loopback且原本地flag开启时可用", async () => {
    const harness = await createHarness({ env: {
      NODE_ENV: "test", HOST: "127.0.0.1", BI_PRODUCTION_DASHBOARD_READING_ENABLED: false, BI_LOCAL_DASHBOARD_READING_ENABLED: true
    } });
    const headers = await login(harness);
    const response = await harness.request("GET", evidenceUrl(), undefined, headers);
    expect(response.statusCode).toBe(200);
    assertNoSecrets(response);
  });

  test("非生产中的production flag不扩大本地读取范围", async () => {
    const harness = await createHarness({ env: {
      NODE_ENV: "test", HOST: "0.0.0.0", BI_PRODUCTION_DASHBOARD_READING_ENABLED: true, BI_LOCAL_DASHBOARD_READING_ENABLED: true
    } });
    const headers = await login(harness);
    assertRejected(await harness.request("GET", evidenceUrl(), undefined, headers), 422, "DAILY_READING_DISABLED");
    expect(harness.observedRequests).toHaveLength(0);
  });
});
