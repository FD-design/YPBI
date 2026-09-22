import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { loadEnv, type AppEnv } from "./config/env";
import type { BiAuthService } from "./auth/service";
import type { IdentityProvider } from "./identity/identity-provider";
import { permissionsByRole } from "./auth/roles";

const MAINTENANCE_PASSWORD = "Fake-maintenance-password-2026";
const CURRENT_PRIMARY_TOKEN = "fake-current-primary-token-0001";
const CANDIDATE_PRIMARY_TOKEN = "fake-candidate-primary-token-0002";
const REJECTED_PRIMARY_TOKEN = "fake-rejected-primary-token-0003";
const SECOND_PREVIEW_TOKEN = "fake-second-preview-token-0005";
const PUBLIC_ORIGIN = "https://bi.example.test";
const NORMAL_SESSION_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NORMAL_CSRF_TOKEN = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const NORMAL_SESSION_COOKIE = `__Host-ypbi_session=${NORMAL_SESSION_TOKEN}`;

const maintainerIdentity: IdentityProvider = {
  resolve: async () => ({
    status: "authenticated",
    principal: {
      subjectId: "maintainer-test-user",
      displayName: "维护测试用户",
      roles: ["maintainer"],
      permissions: ["bi:read", "bi:data-source-maintenance:enter"],
      pidScope: "all",
      securityVersion: "1"
    }
  })
};

const originalFetch = globalThis.fetch;
const openApps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

interface ObservedUpstreamRequest {
  url: string;
  token: string | null;
  userName: string | null;
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createHarness(options: {
  maintenanceEnabled?: boolean;
  nodeEnv?: AppEnv["NODE_ENV"];
  identityProvider?: IdentityProvider;
  upstreamResponse?: (request: ObservedUpstreamRequest) => Response;
  envOverrides?: Partial<AppEnv>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ypbi-admin-data-sources-"));
  temporaryDirectories.push(directory);
  const credentialsFile = join(directory, "upstream-credentials.json");
  const observedRequests: ObservedUpstreamRequest[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const request = {
      url: input.toString(),
      token: headers.get("x-token"),
      userName: headers.get("name")
    };
    observedRequests.push(request);
    return options.upstreamResponse?.(request)
      ?? new Response(JSON.stringify({ code: 200, msg: { pageData: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
  }) as typeof fetch;

  const env: AppEnv = {
    NODE_ENV: options.nodeEnv ?? "test",
    HOST: "127.0.0.1",
    PORT: 3000,
    UPSTREAM_API_BASE_URL: "https://primary.example.test",
    UPSTREAM_X_TOKEN: CURRENT_PRIMARY_TOKEN,
    UPSTREAM_USER_NAME: "fake-primary-user",
    UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.test",
    UPSTREAM_SECONDARY_X_TOKEN: "fake-current-secondary-token-0004",
    UPSTREAM_SECONDARY_USER_NAME: "fake-secondary-user",
    UPSTREAM_CREDENTIALS_FILE: credentialsFile,
    WORKSPACE_FILE: join(directory, "workspace.json"),
    TOKEN_MAINTENANCE_KEY: options.maintenanceEnabled === false ? undefined : MAINTENANCE_PASSWORD,
    BI_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    BI_V2_CORE_OVERVIEW_QUERY_ENABLED: false,
    BI_LOCAL_DASHBOARD_READING_ENABLED: false,
    BI_TEST_DATA_PREVIEW_ENABLED: false,
    REQUEST_TIMEOUT_MS: 1_000,
    MAX_PLATFORM_CONCURRENCY: 1,
    ...options.envOverrides
  };

  const authService = options.nodeEnv === "production"
    ? ({
        csrfMatches: (sessionToken: string, csrfToken: string | undefined) => (
          sessionToken === NORMAL_SESSION_TOKEN && csrfToken === NORMAL_CSRF_TOKEN
        )
      } as BiAuthService)
    : undefined;
  const app = await buildApp(env, {
    identityProvider: options.identityProvider ?? maintainerIdentity,
    authService
  });
  openApps.push(app);
  return { app, credentialsFile, observedRequests };
}

const forwardedRequest = (clientIp: string, protocol = "https") => ({
  remoteAddress: "127.0.0.1",
  headers: {
    "x-forwarded-for": clientIp,
    "x-forwarded-proto": protocol,
    origin: PUBLIC_ORIGIN,
    cookie: NORMAL_SESSION_COOKIE,
    "x-csrf-token": NORMAL_CSRF_TOKEN
  }
});

function maintenanceSetCookie(header: string | string[] | undefined) {
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const matches = cookies.filter((value) => value.startsWith("bi_maintenance_session="));
  expect(matches).toHaveLength(1);
  return matches[0];
}

function previewSetCookie(header: string | string[] | undefined) {
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const matches = cookies.filter((value) => value.startsWith("ypbi_data_preview="));
  expect(matches).toHaveLength(1);
  return matches[0];
}

async function login(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/api/bi/admin/auth/login",
    payload: { password: MAINTENANCE_PASSWORD }
  });
  expect(response.statusCode).toBe(200);
  return maintenanceSetCookie(response.headers["set-cookie"]).split(";", 1)[0];
}

describe("数据源维护管理接口", () => {
  test("临时测试 Token 验证后只进入当前用户内存会话，正式默认路径保持不变", async () => {
    const { app, observedRequests, credentialsFile } = await createHarness({
      envOverrides: {
        BI_TEST_DATA_PREVIEW_ENABLED: true,
        UPSTREAM_TEST_API_BASE_URL: "https://test-upstream.example.test",
        UPSTREAM_TEST_USER_NAME: "test-preview-user"
      }
    });
    const maintenanceCookie = await login(app);
    const ordinaryCookie = `ypbi_session=${NORMAL_SESSION_TOKEN}`;

    const activation = await app.inject({
      method: "POST",
      url: "/api/bi/admin/data-preview/activate",
      headers: { cookie: `${maintenanceCookie}; ${ordinaryCookie}` },
      payload: { token: CANDIDATE_PRIMARY_TOKEN }
    });

    expect(activation.statusCode).toBe(200);
    expect(activation.body).not.toContain(CANDIDATE_PRIMARY_TOKEN);
    expect(activation.json().data).toMatchObject({ mode: "test", userName: "test-preview-user" });
    expect(observedRequests).toHaveLength(2);
    expect(observedRequests.every((request) => request.token === CANDIDATE_PRIMARY_TOKEN && request.userName === "test-preview-user")).toBe(true);
    expect(observedRequests.every((request) => request.url.startsWith("https://test-upstream.example.test/api/admin/statistics/pDaySum"))).toBe(true);
    expect(observedRequests.some((request) => request.url.includes("pid=PH"))).toBe(true);
    expect(observedRequests.some((request) => request.url.includes("pid=FBI"))).toBe(true);
    expect(existsSync(credentialsFile)).toBe(false);

    const previewCookie = previewSetCookie(activation.headers["set-cookie"]).split(";", 1)[0];
    const production = await app.inject({ method: "GET", url: "/api/bi/v2/data-environment", headers: { cookie: `${ordinaryCookie}; ${previewCookie}` } });
    const testMode = await app.inject({ method: "GET", url: "/api/bi/v2/data-environment", headers: { cookie: `${ordinaryCookie}; ${previewCookie}`, "x-ypbi-data-environment": "test" } });
    expect(production.json().data.mode).toBe("production");
    expect(testMode.json().data).toMatchObject({ mode: "test", userName: "test-preview-user" });
  });

  test("测试会话绑定普通登录 Cookie，缺失或更换后绝不回退到正式数据", async () => {
    const { app } = await createHarness({ envOverrides: {
      BI_TEST_DATA_PREVIEW_ENABLED: true,
      UPSTREAM_TEST_API_BASE_URL: "https://test-upstream.example.test",
      UPSTREAM_TEST_USER_NAME: "test-preview-user"
    } });
    const maintenanceCookie = await login(app);
    const ordinaryCookie = `ypbi_session=${NORMAL_SESSION_TOKEN}`;
    const activation = await app.inject({ method: "POST", url: "/api/bi/admin/data-preview/activate", headers: { cookie: `${maintenanceCookie}; ${ordinaryCookie}` }, payload: { token: CANDIDATE_PRIMARY_TOKEN } });
    const previewCookie = previewSetCookie(activation.headers["set-cookie"]).split(";", 1)[0];

    for (const cookie of [previewCookie, `ypbi_session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB; ${previewCookie}`]) {
      const response = await app.inject({ method: "GET", url: "/api/bi/v2/catalog/platforms", headers: { cookie, "x-ypbi-data-environment": "test" } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("DATA_PREVIEW_SESSION_REQUIRED");
    }
  });

  test("同一浏览器重新验证测试 Token 后旧预览 Cookie 立即失效", async () => {
    const { app } = await createHarness({ envOverrides: {
      BI_TEST_DATA_PREVIEW_ENABLED: true,
      UPSTREAM_TEST_API_BASE_URL: "https://test-upstream.example.test",
      UPSTREAM_TEST_USER_NAME: "test-preview-user"
    } });
    const maintenanceCookie = await login(app);
    const ordinaryCookie = `ypbi_session=${NORMAL_SESSION_TOKEN}`;
    const first = await app.inject({ method: "POST", url: "/api/bi/admin/data-preview/activate", headers: { cookie: `${maintenanceCookie}; ${ordinaryCookie}` }, payload: { token: CANDIDATE_PRIMARY_TOKEN } });
    const firstPreviewCookie = previewSetCookie(first.headers["set-cookie"]).split(";", 1)[0];

    const second = await app.inject({
      method: "POST",
      url: "/api/bi/admin/data-preview/activate",
      headers: { cookie: `${maintenanceCookie}; ${ordinaryCookie}; ${firstPreviewCookie}` },
      payload: { token: SECOND_PREVIEW_TOKEN }
    });
    const secondPreviewCookie = previewSetCookie(second.headers["set-cookie"]).split(";", 1)[0];

    const stale = await app.inject({ method: "GET", url: "/api/bi/v2/data-environment", headers: { cookie: `${ordinaryCookie}; ${firstPreviewCookie}`, "x-ypbi-data-environment": "test" } });
    const current = await app.inject({ method: "GET", url: "/api/bi/v2/data-environment", headers: { cookie: `${ordinaryCookie}; ${secondPreviewCookie}`, "x-ypbi-data-environment": "test" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("DATA_PREVIEW_SESSION_REQUIRED");
    expect(current.statusCode).toBe(200);
    expect(current.json().data.mode).toBe("test");
    expect(second.body).not.toContain(SECOND_PREVIEW_TOKEN);
  });

  for (const role of ["reader", "analyst", "maintainer"] as const) {
    test(`${role} 完成二次认证后可验证并更新共享 Token`, async () => {
      const { app, observedRequests } = await createHarness({
        identityProvider: { resolve: async () => ({ status: "authenticated", principal: {
          subjectId: `maintenance-${role}`, roles: [role], permissions: permissionsByRole[role],
          pidScope: "all", securityVersion: "1"
        } }) }
      });
      const cookie = await login(app);
      const response = await app.inject({ method: "PUT", url: "/api/bi/admin/data-sources/token",
        headers: { cookie }, payload: { site: "primary", token: CANDIDATE_PRIMARY_TOKEN } });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.configured).toBe(true);
      expect(response.body).not.toContain(CANDIDATE_PRIMARY_TOKEN);
      expect(observedRequests).toHaveLength(1);
      expect(observedRequests[0].userName).toBe("fake-primary-user");
    });
  }

  test("测试读取维护 Cookie 兼容单值和多值响应头且按名称定位", () => {
    const cookie = "bi_maintenance_session=fake-cookie; Path=/api/bi/admin; HttpOnly; Secure; SameSite=Strict";
    expect(maintenanceSetCookie(cookie)).toBe(cookie);
    expect(maintenanceSetCookie(["another_session=fake-other; Path=/", cookie])).toBe(cookie);
  });

  test("readiness 必须同时通过主站与备用站真实探针", async () => {
    const { app, observedRequests } = await createHarness();

    const response = await app.inject({ method: "GET", url: "/api/bi/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.dependencies).toMatchObject({
      workspace: true,
      identity: true,
      upstream: true,
      upstreamSites: { primary: true, secondary: true }
    });
    expect(observedRequests).toHaveLength(2);
    expect(observedRequests.some((request) => request.url.includes("pid=PH") && request.token === CURRENT_PRIMARY_TOKEN)).toBe(true);
    expect(observedRequests.some((request) => request.url.includes("pid=FBI") && request.token === "fake-current-secondary-token-0004")).toBe(true);
  });

  test("只有主站 Token 时 readiness 保持失败且明确站2未就绪", async () => {
    const { app, observedRequests } = await createHarness({
      envOverrides: { UPSTREAM_SECONDARY_X_TOKEN: undefined }
    });

    const response = await app.inject({ method: "GET", url: "/api/bi/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json().data.dependencies).toMatchObject({
      upstream: false,
      upstreamSites: { primary: true, secondary: false }
    });
    expect(observedRequests).toHaveLength(1);
    expect(observedRequests[0].token).toBe(CURRENT_PRIMARY_TOKEN);
  });

  test("只有备用站 Token 时 readiness 保持失败且明确站1未就绪", async () => {
    const { app, observedRequests } = await createHarness({
      envOverrides: { UPSTREAM_X_TOKEN: undefined }
    });

    const response = await app.inject({ method: "GET", url: "/api/bi/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json().data.dependencies).toMatchObject({
      upstream: false,
      upstreamSites: { primary: false, secondary: true }
    });
    expect(observedRequests).toHaveLength(1);
    expect(observedRequests[0].token).toBe("fake-current-secondary-token-0004");
  });

  test("普通账号未登录时不能尝试维护密码", async () => {
    const { app } = await createHarness({
      identityProvider: { resolve: async () => ({ status: "unauthenticated" }) }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      payload: { password: MAINTENANCE_PASSWORD }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  test("未获得维护能力的身份即使知道维护密码也不能进入数据源维护", async () => {
    const { app } = await createHarness({
      identityProvider: {
        resolve: async () => ({
          status: "authenticated",
          principal: {
            subjectId: "analyst-test-user",
            roles: ["analyst"],
            permissions: ["bi:read"],
            pidScope: "all",
            securityVersion: "1"
          }
        })
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      payload: { password: MAINTENANCE_PASSWORD }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ADMIN_ACCESS_DENIED");
  });

  test("未登录时拒绝读取数据源状态", async () => {
    const { app } = await createHarness();

    const response = await app.inject({ method: "GET", url: "/api/bi/admin/data-sources/status" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("MAINTENANCE_LOGIN_REQUIRED");
  });

  test("维护能力未启用时返回明确的 503", async () => {
    const { app } = await createHarness({ maintenanceEnabled: false });

    const response = await app.inject({ method: "GET", url: "/api/bi/admin/data-sources/status" });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("MAINTENANCE_DISABLED");
  });

  test("登录成功后签发安全 Cookie，响应禁止缓存且不回显密码", async () => {
    const { app } = await createHarness();

    const response = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      payload: { password: MAINTENANCE_PASSWORD }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const cookie = maintenanceSetCookie(response.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(response.body).not.toContain(MAINTENANCE_PASSWORD);
  });

  test("候选 Token 可以只验证而不保存", async () => {
    const { app, credentialsFile, observedRequests } = await createHarness();
    const cookie = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/bi/admin/data-sources/test",
      headers: { cookie },
      payload: { site: "primary", token: CANDIDATE_PRIMARY_TOKEN }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ site: "primary", valid: true });
    expect(response.body).not.toContain(CANDIDATE_PRIMARY_TOKEN);
    expect(observedRequests).toHaveLength(1);
    expect(observedRequests[0]).toMatchObject({
      token: CANDIDATE_PRIMARY_TOKEN,
      userName: "fake-primary-user"
    });
    expect(observedRequests[0].url).toContain("pid=PH");
    expect(existsSync(credentialsFile)).toBe(false);

    const status = await app.inject({
      method: "GET",
      url: "/api/bi/admin/data-sources/status",
      headers: { cookie }
    });
    expect(status.body).not.toContain(CANDIDATE_PRIMARY_TOKEN);
    expect(status.json().data[0]).toMatchObject({
      site: "primary",
      tokenHint: `••••${CURRENT_PRIMARY_TOKEN.slice(-4)}`,
      updatedAt: null
    });
  });

  test("新 Token 验证失败时不替换当前凭证", async () => {
    const { app, credentialsFile, observedRequests } = await createHarness({
      upstreamResponse: ({ token }) => token === REJECTED_PRIMARY_TOKEN
        ? new Response(JSON.stringify({ code: 2002, err: "请重新登录" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
        : new Response(JSON.stringify({ code: 200, msg: {} }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    });
    const cookie = await login(app);

    const update = await app.inject({
      method: "PUT",
      url: "/api/bi/admin/data-sources/token",
      headers: { cookie },
      payload: { site: "primary", token: REJECTED_PRIMARY_TOKEN }
    });
    expect(update.statusCode).toBe(401);
    expect(update.json().error.code).toBe("UPSTREAM_AUTH_FAILED");
    expect(update.body).not.toContain(REJECTED_PRIMARY_TOKEN);
    expect(existsSync(credentialsFile)).toBe(false);

    const currentConnection = await app.inject({
      method: "POST",
      url: "/api/bi/admin/data-sources/test",
      headers: { cookie },
      payload: { site: "primary" }
    });
    expect(currentConnection.statusCode).toBe(200);
    expect(observedRequests.map((request) => request.token)).toEqual([
      REJECTED_PRIMARY_TOKEN,
      CURRENT_PRIMARY_TOKEN
    ]);
  });

  test("验证成功后保存候选凭证，但响应只返回脱敏提示", async () => {
    const { app, credentialsFile } = await createHarness();
    const cookie = await login(app);

    const response = await app.inject({
      method: "PUT",
      url: "/api/bi/admin/data-sources/token",
      headers: { cookie },
      payload: { site: "primary", token: CANDIDATE_PRIMARY_TOKEN }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      site: "primary",
      configured: true,
      tokenHint: `••••${CANDIDATE_PRIMARY_TOKEN.slice(-4)}`
    });
    expect(response.body).not.toContain(CANDIDATE_PRIMARY_TOKEN);

    const persisted = JSON.parse(await readFile(credentialsFile, "utf8")) as {
      primary?: { token?: string; updatedAt?: string };
    };
    expect(persisted.primary?.token).toBe(CANDIDATE_PRIMARY_TOKEN);
    expect(persisted.primary?.updatedAt).toBeString();
  });

  test("退出后原维护会话立即失效", async () => {
    const { app } = await createHarness();
    const cookie = await login(app);

    const logout = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/logout",
      headers: { cookie }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["cache-control"]).toBe("no-store");
    expect(maintenanceSetCookie(logout.headers["set-cookie"])).toContain("Max-Age=0");

    const status = await app.inject({
      method: "GET",
      url: "/api/bi/admin/data-sources/status",
      headers: { cookie }
    });
    expect(status.statusCode).toBe(401);
    expect(status.json().error.code).toBe("MAINTENANCE_LOGIN_REQUIRED");
  });
});

describe("数据源维护可信代理与 HTTPS 边界", () => {
  test("生产环境缺少、使用 HTTP 或使用复合协议头时均失败关闭", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });

    for (const forwardedProtocol of [undefined, "http", "http, https"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/bi/admin/auth/login",
        remoteAddress: "127.0.0.1",
        headers: forwardedProtocol ? { "x-forwarded-proto": forwardedProtocol } : undefined,
        payload: { password: MAINTENANCE_PASSWORD }
      });

      expect(response.statusCode).toBe(426);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.json().error.code).toBe("HTTPS_REQUIRED");
    }
  });

  test("编码后的管理路由仍受生产 HTTPS 与代理门禁保护", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });

    const response = await app.inject({
      method: "POST",
      url: "/api/bi/%61dmin/auth/login",
      remoteAddress: "127.0.0.1",
      payload: { password: MAINTENANCE_PASSWORD }
    });

    expect(response.statusCode).toBe(426);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json().error.code).toBe("HTTPS_REQUIRED");
  });

  test("普通未知路由保持 404，未知管理路由仍先经过安全边界", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });

    const ordinary = await app.inject({ method: "GET", url: "/not-a-real-route" });
    expect(ordinary.statusCode).toBe(404);

    const untrustedAdmin = await app.inject({ method: "GET", url: "/api/bi/admin/not-a-real-route" });
    expect(untrustedAdmin.statusCode).toBe(426);
    expect(untrustedAdmin.headers["cache-control"]).toBe("no-store");

    const trustedAdmin = await app.inject({
      method: "GET",
      url: "/api/bi/admin/not-a-real-route",
      ...forwardedRequest("198.51.100.23")
    });
    expect(trustedAdmin.statusCode).toBe(404);
    expect(trustedAdmin.headers["cache-control"]).toBe("no-store");
  });

  test("生产环境只接受本机可信代理传入的单一 HTTPS 协议", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });

    const trusted = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      ...forwardedRequest("198.51.100.23"),
      payload: { password: MAINTENANCE_PASSWORD }
    });
    expect(trusted.statusCode).toBe(200);

    const trustedIpv6 = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      ...forwardedRequest("2001:db8::23"),
      payload: { password: MAINTENANCE_PASSWORD }
    });
    expect(trustedIpv6.statusCode).toBe(200);

    const spoofed = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      remoteAddress: "203.0.113.9",
      headers: {
        "x-forwarded-for": "198.51.100.23",
        "x-forwarded-proto": "https"
      },
      payload: { password: MAINTENANCE_PASSWORD }
    });
    expect(spoofed.statusCode).toBe(426);
    expect(spoofed.json().error.code).toBe("HTTPS_REQUIRED");
  });

  test("生产维护写请求必须来自配置的同源页面", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });

    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      remoteAddress: "127.0.0.1",
      headers: {
        "x-forwarded-for": "198.51.100.23",
        "x-forwarded-proto": "https"
      },
      payload: { password: MAINTENANCE_PASSWORD }
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json().error.code).toBe("MAINTENANCE_ORIGIN_REJECTED");

    const foreignOrigin = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      remoteAddress: "127.0.0.1",
      headers: {
        "x-forwarded-for": "198.51.100.23",
        "x-forwarded-proto": "https",
        origin: "https://foreign.example.test"
      },
      payload: { password: MAINTENANCE_PASSWORD }
    });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json().error.code).toBe("MAINTENANCE_ORIGIN_REJECTED");
  });

  test("生产维护写请求还必须携带当前普通会话的 CSRF 令牌", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });
    const base = forwardedRequest("198.51.100.23");

    for (const csrfToken of [undefined, "wrong-csrf-token"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/bi/admin/auth/login",
        remoteAddress: base.remoteAddress,
        headers: {
          "x-forwarded-for": base.headers["x-forwarded-for"],
          "x-forwarded-proto": base.headers["x-forwarded-proto"],
          origin: base.headers.origin,
          cookie: base.headers.cookie,
          ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
        },
        payload: { password: MAINTENANCE_PASSWORD }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("CSRF_VALIDATION_FAILED");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });

  test("新版普通 API 同样拒绝绕过 HTTPS 和可信代理", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });

    const insecure = await app.inject({ method: "GET", url: "/api/bi/v2/catalog/metrics" });
    expect(insecure.statusCode).toBe(426);
    expect(insecure.json().error.code).toBe("HTTPS_REQUIRED");
    expect(insecure.json().error.requestId).toBeString();

    const trusted = await app.inject({
      method: "GET",
      url: "/api/bi/v2/catalog/metrics",
      ...forwardedRequest("198.51.100.23")
    });
    expect(trusted.statusCode).toBe(200);
  });

  test("生产代理缺少、伪造或传入复合客户端 IP 时失败关闭", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });

    for (const forwardedFor of [undefined, "not-an-ip", "192.0.2.200, 198.51.100.23"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/bi/admin/auth/login",
        remoteAddress: "127.0.0.1",
        headers: {
          "x-forwarded-proto": "https",
          ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {})
        },
        payload: { password: MAINTENANCE_PASSWORD }
      });

      expect(response.statusCode).toBe(503);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.json().error.code).toBe("MAINTENANCE_PROXY_MISCONFIGURED");
    }
  });

  test("维护会话绑定真实客户端 IP，而不是绑定本机代理地址", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });
    const loginResponse = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      ...forwardedRequest("198.51.100.23"),
      payload: { password: MAINTENANCE_PASSWORD }
    });
    expect(loginResponse.statusCode).toBe(200);
    const cookie = maintenanceSetCookie(loginResponse.headers["set-cookie"]).split(";", 1)[0];

    const sameClient = await app.inject({
      method: "GET",
      url: "/api/bi/admin/data-sources/status",
      ...forwardedRequest("198.51.100.23"),
      headers: { ...forwardedRequest("198.51.100.23").headers, cookie }
    });
    expect(sameClient.statusCode).toBe(200);

    const differentClient = await app.inject({
      method: "GET",
      url: "/api/bi/admin/data-sources/status",
      ...forwardedRequest("198.51.100.24"),
      headers: { ...forwardedRequest("198.51.100.24").headers, cookie }
    });
    expect(differentClient.statusCode).toBe(401);
    expect(differentClient.json().error.code).toBe("MAINTENANCE_LOGIN_REQUIRED");
  });

  test("一个客户端的登录锁定不会误伤其他客户端", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/bi/admin/auth/login",
        ...forwardedRequest("198.51.100.23"),
        payload: { password: "Fake-but-wrong-password-2026" }
      });
      expect(failed.statusCode).toBe(401);
    }

    const lockedClient = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      ...forwardedRequest("198.51.100.23"),
      payload: { password: MAINTENANCE_PASSWORD }
    });
    expect(lockedClient.statusCode).toBe(429);

    const otherClient = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      ...forwardedRequest("198.51.100.24"),
      payload: { password: MAINTENANCE_PASSWORD }
    });
    expect(otherClient.statusCode).toBe(200);
  });

  test("复合 X-Forwarded-For 被拒绝且不会销毁原有会话", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });
    const loginResponse = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      ...forwardedRequest("198.51.100.23"),
      payload: { password: MAINTENANCE_PASSWORD }
    });
    expect(loginResponse.statusCode).toBe(200);
    const cookie = maintenanceSetCookie(loginResponse.headers["set-cookie"]).split(";", 1)[0];

    const response = await app.inject({
      method: "GET",
      url: "/api/bi/admin/data-sources/status",
      remoteAddress: "127.0.0.1",
      headers: {
        "x-forwarded-for": "192.0.2.200, 198.51.100.23",
        "x-forwarded-proto": "https",
        cookie
      }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("MAINTENANCE_PROXY_MISCONFIGURED");

    const validResponse = await app.inject({
      method: "GET",
      url: "/api/bi/admin/data-sources/status",
      ...forwardedRequest("198.51.100.23"),
      headers: { ...forwardedRequest("198.51.100.23").headers, cookie }
    });
    expect(validResponse.statusCode).toBe(200);
  });

  test("非 HTTPS 退出不销毁会话，HTTPS 退出才清除生产会话", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });
    const loginResponse = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      ...forwardedRequest("198.51.100.23"),
      payload: { password: MAINTENANCE_PASSWORD }
    });
    expect(loginResponse.statusCode).toBe(200);
    const cookie = maintenanceSetCookie(loginResponse.headers["set-cookie"]).split(";", 1)[0];

    const insecureLogout = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/logout",
      ...forwardedRequest("198.51.100.23", "http"),
      headers: { ...forwardedRequest("198.51.100.23", "http").headers, cookie: `${NORMAL_SESSION_COOKIE}; ${cookie}` }
    });
    expect(insecureLogout.statusCode).toBe(426);

    const status = await app.inject({
      method: "GET",
      url: "/api/bi/admin/data-sources/status",
      ...forwardedRequest("198.51.100.23"),
      headers: { ...forwardedRequest("198.51.100.23").headers, cookie }
    });
    expect(status.statusCode).toBe(200);

    const secureLogout = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/logout",
      ...forwardedRequest("198.51.100.23"),
      headers: { ...forwardedRequest("198.51.100.23").headers, cookie: `${NORMAL_SESSION_COOKIE}; ${cookie}` }
    });
    expect(secureLogout.statusCode).toBe(200);
    expect(maintenanceSetCookie(secureLogout.headers["set-cookie"])).toContain("Max-Age=0");

    const expiredStatus = await app.inject({
      method: "GET",
      url: "/api/bi/admin/data-sources/status",
      ...forwardedRequest("198.51.100.23"),
      headers: { ...forwardedRequest("198.51.100.23").headers, cookie }
    });
    expect(expiredStatus.statusCode).toBe(401);
  });

  test("开发环境仍允许本机 HTTP，避免破坏本地调试", async () => {
    const { app } = await createHarness({ nodeEnv: "development" });

    const response = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/login",
      payload: { password: MAINTENANCE_PASSWORD }
    });
    expect(response.statusCode).toBe(200);
  });

  test("生产环境冻结遗留匿名工作区写入", async () => {
    const { app } = await createHarness({ nodeEnv: "production" });
    const response = await app.inject({
      method: "PUT",
      url: "/api/bi/workspace",
      payload: { schemaVersion: 1, templates: [], cardAssets: [] }
    });

    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe("LEGACY_WORKSPACE_WRITE_DISABLED");
  });
});

describe("生产环境配置", () => {
  test("核心经营总览开关默认关闭且只接受明确 true 或 false", () => {
    expect(loadEnv({ NODE_ENV: "development" }).BI_V2_CORE_OVERVIEW_QUERY_ENABLED).toBe(false);
    expect(loadEnv({ NODE_ENV: "development", BI_V2_CORE_OVERVIEW_QUERY_ENABLED: "false" }).BI_V2_CORE_OVERVIEW_QUERY_ENABLED).toBe(false);
    expect(loadEnv({ NODE_ENV: "development", BI_V2_CORE_OVERVIEW_QUERY_ENABLED: "true" }).BI_V2_CORE_OVERVIEW_QUERY_ENABLED).toBe(true);
    expect(() => loadEnv({ NODE_ENV: "development", BI_V2_CORE_OVERVIEW_QUERY_ENABLED: "1" })).toThrow("环境变量配置错误");
  });

  test("正式环境允许先启动登录与维护页，再由维护者录入首个 Token", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_USER_NAME: "primary-user",
      UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.test",
      UPSTREAM_SECONDARY_USER_NAME: "secondary-user",
      TOKEN_MAINTENANCE_KEY: MAINTENANCE_PASSWORD,
      BI_IDENTITY_MODE: "local",
      BI_AUTH_DATABASE_URL: "postgres://auth.example.test/ypbi",
      BI_AUTH_CSRF_SECRET: "fake-csrf-secret-with-more-than-32-bytes",
      BI_PUBLIC_ORIGIN: PUBLIC_ORIGIN
    });

    expect(env.UPSTREAM_X_TOKEN).toBeUndefined();
    expect(env.UPSTREAM_SECONDARY_X_TOKEN).toBeUndefined();
  });

  test("从环境模板读取空白可选项时按未配置处理而不是启动报错", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_USER_NAME: "primary-user",
      UPSTREAM_X_TOKEN: "",
      UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.test",
      UPSTREAM_SECONDARY_X_TOKEN: "",
      UPSTREAM_SECONDARY_USER_NAME: "secondary-user",
      TOKEN_MAINTENANCE_KEY: MAINTENANCE_PASSWORD,
      BI_IDENTITY_MODE: "local",
      BI_AUTH_DATABASE_URL: "postgres://auth.example.test/ypbi",
      BI_AUTH_CSRF_SECRET: "fake-csrf-secret-with-more-than-32-bytes",
      BI_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      DATABASE_URL: ""
    });

    expect(env.UPSTREAM_X_TOKEN).toBeUndefined();
    expect(env.UPSTREAM_SECONDARY_API_BASE_URL).toBe("https://secondary.example.test");
    expect(env.UPSTREAM_SECONDARY_X_TOKEN).toBeUndefined();
    expect(env.TOKEN_MAINTENANCE_KEY).toBe(MAINTENANCE_PASSWORD);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  test("正式环境缺少主后台用户名时拒绝启动，避免维护页无法补救", () => {
    expect(() => loadEnv({
      NODE_ENV: "production",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      BI_IDENTITY_MODE: "local",
      BI_AUTH_DATABASE_URL: "postgres://auth.example.test/ypbi",
      BI_AUTH_CSRF_SECRET: "fake-csrf-secret-with-more-than-32-bytes",
      BI_PUBLIC_ORIGIN: PUBLIC_ORIGIN
    })).toThrow("生产环境缺少 UPSTREAM_USER_NAME");
  });

  test("正式环境缺少维护二次密码时拒绝启动", () => {
    expect(() => loadEnv({
      NODE_ENV: "production",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_USER_NAME: "primary-user",
      BI_IDENTITY_MODE: "local",
      BI_AUTH_DATABASE_URL: "postgres://auth.example.test/ypbi",
      BI_AUTH_CSRF_SECRET: "fake-csrf-secret-with-more-than-32-bytes",
      BI_PUBLIC_ORIGIN: PUBLIC_ORIGIN
    })).toThrow("生产环境缺少 TOKEN_MAINTENANCE_KEY");
  });

  test("正式环境拒绝通过明文 HTTP 传输上游凭据", () => {
    const productionBase = {
      NODE_ENV: "production",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_USER_NAME: "primary-user",
      TOKEN_MAINTENANCE_KEY: MAINTENANCE_PASSWORD,
      UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.test",
      UPSTREAM_SECONDARY_USER_NAME: "secondary-user",
      BI_IDENTITY_MODE: "local",
      BI_AUTH_DATABASE_URL: "postgres://auth.example.test/ypbi",
      BI_AUTH_CSRF_SECRET: "fake-csrf-secret-with-more-than-32-bytes",
      BI_PUBLIC_ORIGIN: PUBLIC_ORIGIN
    } as const;

    expect(() => loadEnv({ ...productionBase, UPSTREAM_API_BASE_URL: "http://primary.example.test" }))
      .toThrow("主上游地址必须使用无凭据的 HTTPS URL");
    expect(() => loadEnv({
      ...productionBase,
      UPSTREAM_SECONDARY_API_BASE_URL: "http://secondary.example.test",
      UPSTREAM_SECONDARY_USER_NAME: "secondary-user"
    })).toThrow("备用上游地址必须使用无凭据的 HTTPS URL");
  });

  test("正式环境由平台目录发现站2 PID 时要求完整配置站2连接", () => {
    const productionBase = {
      NODE_ENV: "production",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_USER_NAME: "primary-user",
      TOKEN_MAINTENANCE_KEY: MAINTENANCE_PASSWORD,
      BI_IDENTITY_MODE: "local",
      BI_AUTH_DATABASE_URL: "postgres://auth.example.test/ypbi",
      BI_AUTH_CSRF_SECRET: "fake-csrf-secret-with-more-than-32-bytes",
      BI_PUBLIC_ORIGIN: PUBLIC_ORIGIN
    } as const;

    expect(() => loadEnv(productionBase))
      .toThrow("平台目录包含站2 PID，必须配置站2后台地址和用户名");
  });

  test("遗留备用 PID 环境变量不再参与路由，平台归属只有目录一个来源", () => {
    const env = loadEnv({
      NODE_ENV: "development",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.test",
      UPSTREAM_SECONDARY_USER_NAME: "secondary-user",
      UPSTREAM_SECONDARY_PIDS: "PH"
    });

    expect("UPSTREAM_SECONDARY_PIDS" in env).toBe(false);
  });

  test("备用后台拒绝只有 Token 或地址与用户名缺一的歧义配置", () => {
    const base = {
      NODE_ENV: "development",
      UPSTREAM_API_BASE_URL: "https://primary.example.test"
    } as const;
    expect(() => loadEnv({ ...base, UPSTREAM_SECONDARY_X_TOKEN: "secondary-token" }))
      .toThrow("不能脱离对应地址和用户名");
    expect(() => loadEnv({ ...base, UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.test" }))
      .toThrow("地址和用户名必须同时配置");
  });

  test("正式环境允许使用已确认的文件工作区，不强制引入 PostgreSQL", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_USER_NAME: "primary-user",
      UPSTREAM_X_TOKEN: CURRENT_PRIMARY_TOKEN,
      UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.test",
      UPSTREAM_SECONDARY_USER_NAME: "secondary-user",
      TOKEN_MAINTENANCE_KEY: MAINTENANCE_PASSWORD,
      BI_IDENTITY_MODE: "local",
      BI_AUTH_DATABASE_URL: "postgres://auth.example.test/ypbi",
      BI_AUTH_CSRF_SECRET: "fake-csrf-secret-with-more-than-32-bytes",
      BI_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      WORKSPACE_FILE: "/opt/config-driven-bi-demo/data/workspace.json"
    });

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.BI_AUTH_DATABASE_URL).toBe("postgres://auth.example.test/ypbi");
    expect(env.WORKSPACE_FILE).toBe("/opt/config-driven-bi-demo/data/workspace.json");
  });

  test("正式环境拒绝偏离反向代理契约的监听地址或端口", () => {
    expect(() => loadEnv({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_USER_NAME: "primary-user",
      UPSTREAM_X_TOKEN: CURRENT_PRIMARY_TOKEN,
      TOKEN_MAINTENANCE_KEY: MAINTENANCE_PASSWORD,
      BI_IDENTITY_MODE: "local",
      BI_AUTH_DATABASE_URL: "postgres://auth.example.test/ypbi",
      BI_AUTH_CSRF_SECRET: "fake-csrf-secret-with-more-than-32-bytes",
      BI_PUBLIC_ORIGIN: PUBLIC_ORIGIN
    })).toThrow("生产环境 API 必须监听 127.0.0.1:3000");

    expect(() => loadEnv({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "3001",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_USER_NAME: "primary-user",
      UPSTREAM_X_TOKEN: CURRENT_PRIMARY_TOKEN,
      TOKEN_MAINTENANCE_KEY: MAINTENANCE_PASSWORD,
      BI_IDENTITY_MODE: "local",
      BI_AUTH_DATABASE_URL: "postgres://auth.example.test/ypbi",
      BI_AUTH_CSRF_SECRET: "fake-csrf-secret-with-more-than-32-bytes",
      BI_PUBLIC_ORIGIN: PUBLIC_ORIGIN
    })).toThrow("生产环境 API 必须监听 127.0.0.1:3000");
  });

  test("正式环境缺少自有账号库或 HTTPS Origin 时拒绝启动", () => {
    expect(() => loadEnv({
      NODE_ENV: "production",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_USER_NAME: "primary-user",
      UPSTREAM_X_TOKEN: CURRENT_PRIMARY_TOKEN,
      TOKEN_MAINTENANCE_KEY: MAINTENANCE_PASSWORD
    })).toThrow("BI_IDENTITY_MODE=local");

    expect(() => loadEnv({
      NODE_ENV: "production",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_USER_NAME: "primary-user",
      UPSTREAM_X_TOKEN: CURRENT_PRIMARY_TOKEN,
      TOKEN_MAINTENANCE_KEY: MAINTENANCE_PASSWORD,
      BI_IDENTITY_MODE: "local",
      BI_AUTH_DATABASE_URL: "postgres://auth.example.test/ypbi",
      BI_AUTH_CSRF_SECRET: "fake-csrf-secret-with-more-than-32-bytes",
      BI_PUBLIC_ORIGIN: "http://bi.example.test"
    })).toThrow("HTTPS Origin");
  });
});
