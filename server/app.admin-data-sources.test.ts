import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { loadEnv, type AppEnv } from "./config/env";

const MAINTENANCE_PASSWORD = "Fake-maintenance-password-2026";
const CURRENT_PRIMARY_TOKEN = "fake-current-primary-token-0001";
const CANDIDATE_PRIMARY_TOKEN = "fake-candidate-primary-token-0002";
const REJECTED_PRIMARY_TOKEN = "fake-rejected-primary-token-0003";

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
  upstreamResponse?: (request: ObservedUpstreamRequest) => Response;
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
    UPSTREAM_SECONDARY_PIDS: "FBI,TJD",
    UPSTREAM_CREDENTIALS_FILE: credentialsFile,
    WORKSPACE_FILE: join(directory, "workspace.json"),
    TOKEN_MAINTENANCE_KEY: options.maintenanceEnabled === false ? undefined : MAINTENANCE_PASSWORD,
    REQUEST_TIMEOUT_MS: 1_000,
    MAX_PLATFORM_CONCURRENCY: 1
  };

  const app = await buildApp(env);
  openApps.push(app);
  return { app, credentialsFile, observedRequests };
}

const forwardedRequest = (clientIp: string, protocol = "https") => ({
  remoteAddress: "127.0.0.1",
  headers: {
    "x-forwarded-for": clientIp,
    "x-forwarded-proto": protocol
  }
});

async function login(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/api/bi/admin/auth/login",
    payload: { password: MAINTENANCE_PASSWORD }
  });
  const setCookie = response.headers["set-cookie"];
  expect(response.statusCode).toBe(200);
  expect(setCookie).toBeString();
  return String(setCookie).split(";", 1)[0];
}

describe("数据源维护管理接口", () => {
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
    expect(response.headers["set-cookie"]).toContain("bi_maintenance_session=");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
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
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");

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
    const cookie = String(loginResponse.headers["set-cookie"]).split(";", 1)[0];

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
    const cookie = String(loginResponse.headers["set-cookie"]).split(";", 1)[0];

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
    const cookie = String(loginResponse.headers["set-cookie"]).split(";", 1)[0];

    const insecureLogout = await app.inject({
      method: "POST",
      url: "/api/bi/admin/auth/logout",
      ...forwardedRequest("198.51.100.23", "http"),
      headers: { ...forwardedRequest("198.51.100.23", "http").headers, cookie }
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
      headers: { ...forwardedRequest("198.51.100.23").headers, cookie }
    });
    expect(secureLogout.statusCode).toBe(200);
    expect(secureLogout.headers["set-cookie"]).toContain("Max-Age=0");

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
});

describe("生产环境配置", () => {
  test("正式环境允许使用已确认的文件工作区，不强制引入 PostgreSQL", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_X_TOKEN: CURRENT_PRIMARY_TOKEN,
      WORKSPACE_FILE: "/opt/config-driven-bi-demo/data/workspace.json"
    });

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.WORKSPACE_FILE).toBe("/opt/config-driven-bi-demo/data/workspace.json");
  });

  test("正式环境拒绝偏离反向代理契约的监听地址或端口", () => {
    expect(() => loadEnv({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_X_TOKEN: CURRENT_PRIMARY_TOKEN
    })).toThrow("生产环境 API 必须监听 127.0.0.1:3000");

    expect(() => loadEnv({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "3001",
      UPSTREAM_API_BASE_URL: "https://primary.example.test",
      UPSTREAM_X_TOKEN: CURRENT_PRIMARY_TOKEN
    })).toThrow("生产环境 API 必须监听 127.0.0.1:3000");
  });
});
