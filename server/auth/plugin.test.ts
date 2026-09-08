import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { biAuthErrorResponseSchema } from "../../contracts/bi-auth";
import {
  BI_SESSION_COOKIE,
  LOCAL_BI_SESSION_COOKIE,
  resolveSessionCookieConfiguration
} from "./cookies";
import { biAuthPlugin, type BiAuthPluginOptions } from "./plugin";
import { MemoryAuthRepository } from "./repository";
import { permissionsByRole } from "./roles";
import { BiAccountAdminService, BiAuthService } from "./service";
import { PasswordWorkCapacityError, type ScryptParameters } from "./password";

const testScryptParameters: ScryptParameters = {
  N: 2 ** 10,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
  maxmem: 4 * 1024 * 1024
};

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function setCookieValues(header: string | string[] | undefined) {
  return Array.isArray(header) ? header : header ? [header] : [];
}

function cookiePair(setCookie: string | string[] | undefined, name: string) {
  const cookie = setCookieValues(setCookie).find((value) => value.startsWith(`${name}=`));
  return cookie?.split(";", 1)[0] ?? null;
}

async function createApp(
  options: Omit<BiAuthPluginOptions, "authService"> = {}
) {
  const repository = new MemoryAuthRepository();
  const accounts = new BiAccountAdminService(repository, testScryptParameters);
  await accounts.createAccount({
    username: "alice",
    displayName: "Alice",
    role: "analyst",
    password: "Correct-password-2026"
  });
  const authService = await BiAuthService.create(repository, {
    csrfSecret: "test-only-csrf-secret-at-least-32-bytes",
    scryptParameters: testScryptParameters
  });
  const app = Fastify();
  try {
    await app.register(biAuthPlugin, {
      prefix: "/api/bi/v2/auth",
      authService,
      ...options
    });
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  apps.push(app);
  return { app, accounts };
}

async function login(app: FastifyInstance, password = "Correct-password-2026") {
  return app.inject({
    method: "POST",
    url: "/api/bi/v2/auth/login",
    payload: { username: "alice", password }
  });
}

describe("biAuthPlugin", () => {
  test("登录设置安全 Cookie，响应不泄露密码、哈希或原始会话", async () => {
    const { app } = await createApp();
    const response = await login(app);

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const setCookies = setCookieValues(response.headers["set-cookie"]);
    expect(setCookies).toHaveLength(1);
    expect(setCookies.find((value) => value.startsWith(`${BI_SESSION_COOKIE}=`))).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(response.json().data).toMatchObject({
      user: { role: "analyst", pidScope: "all", permissions: ["bi:account:change-password"] },
      mustChangePassword: true
    });
    expect(response.json().data.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.body).not.toContain("Correct-password-2026");
    expect(response.body).not.toContain("$scrypt$");
    expect(response.body).not.toContain(BI_SESSION_COOKIE);
  });

  test("本地开发配置使用独立非 Secure Cookie，且读写使用同一名称", async () => {
    const { app } = await createApp({ sessionCookie: LOCAL_BI_SESSION_COOKIE });
    const response = await login(app);

    expect(response.statusCode).toBe(200);
    const configuredCookie = setCookieValues(response.headers["set-cookie"])[0];
    expect(configuredCookie).toStartWith(`${LOCAL_BI_SESSION_COOKIE.name}=`);
    expect(configuredCookie).toContain("HttpOnly; SameSite=Strict");
    expect(configuredCookie).not.toContain("; Secure");
    const localCookiePair = cookiePair(response.headers["set-cookie"], LOCAL_BI_SESSION_COOKIE.name)!;
    const session = await app.inject({
      method: "GET",
      url: "/api/bi/v2/auth/session",
      headers: { cookie: localCookiePair }
    });
    expect(session.statusCode).toBe(200);
  });

  test("拒绝把 __Host-/__Secure- Cookie 配置为非 Secure", () => {
    expect(() => resolveSessionCookieConfiguration({
      name: "__Host-ypbi_session",
      secure: false
    })).toThrow();
    expect(() => resolveSessionCookieConfiguration({
      name: "__Secure-ypbi_session",
      secure: false
    })).toThrow();
  });

  test("配置 expectedOrigin 后严格校验登录、退出和改密写请求", async () => {
    const expectedOrigin = "https://bi.example.com";
    const { app } = await createApp({ expectedOrigin });

    const missingOrigin = await login(app);
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json().error.code).toBe("ORIGIN_VALIDATION_FAILED");

    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/bi/v2/auth/login",
      headers: { origin: "https://attacker.example" },
      payload: { username: "alice", password: "Correct-password-2026" }
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json().error.code).toBe("ORIGIN_VALIDATION_FAILED");

    const malformedOrigin = await app.inject({
      method: "POST",
      url: "/api/bi/v2/auth/login",
      headers: { origin: `${expectedOrigin}/` },
      payload: { username: "alice", password: "Correct-password-2026" }
    });
    expect(malformedOrigin.statusCode).toBe(403);
    expect(malformedOrigin.json().error.code).toBe("ORIGIN_VALIDATION_FAILED");

    const loggedIn = await app.inject({
      method: "POST",
      url: "/api/bi/v2/auth/login",
      headers: { origin: expectedOrigin },
      payload: { username: "alice", password: "Correct-password-2026" }
    });
    expect(loggedIn.statusCode).toBe(200);
    const cookie = cookiePair(loggedIn.headers["set-cookie"], BI_SESSION_COOKIE)!;
    const csrfToken = loggedIn.json().data.csrfToken as string;

    // Session is read-only and remains available without an Origin header.
    expect((await app.inject({
      method: "GET",
      url: "/api/bi/v2/auth/session",
      headers: { cookie }
    })).statusCode).toBe(200);

    const rejectedPasswordChange = await app.inject({
      method: "PUT",
      url: "/api/bi/v2/auth/password",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: {
        currentPassword: "Correct-password-2026",
        newPassword: "Replacement-password-2026"
      }
    });
    expect(rejectedPasswordChange.statusCode).toBe(403);
    expect(rejectedPasswordChange.json().error.code).toBe("ORIGIN_VALIDATION_FAILED");

    const rejectedLogout = await app.inject({
      method: "POST",
      url: "/api/bi/v2/auth/logout",
      headers: { cookie, "x-csrf-token": csrfToken, origin: "https://attacker.example" }
    });
    expect(rejectedLogout.statusCode).toBe(403);
    expect(rejectedLogout.json().error.code).toBe("ORIGIN_VALIDATION_FAILED");

    const logout = await app.inject({
      method: "POST",
      url: "/api/bi/v2/auth/logout",
      headers: { cookie, "x-csrf-token": csrfToken, origin: expectedOrigin }
    });
    expect(logout.statusCode).toBe(200);
  });

  test("expectedOrigin 配置不是纯 http(s) Origin 时启动失败", async () => {
    await expect(createApp({ expectedOrigin: "https://bi.example.com/auth" })).rejects.toThrow();
  });

  test("公网 HTTPS 与代理边界错误码属于统一认证错误契约", () => {
    for (const [code, status] of [
      ["HTTPS_REQUIRED", 426],
      ["AUTH_PROXY_MISCONFIGURED", 503]
    ] as const) {
      expect(biAuthErrorResponseSchema.safeParse({
        success: false,
        error: { code, message: `HTTP ${status}`, requestId: "request-1" }
      }).success).toBe(true);
    }
  });

  test("畸形 JSON 使用稳定错误契约且不回显解析详情", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{\"username\":"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_AUTH_REQUEST");
    expect(response.json().error.requestId).toBeString();
    expect(response.body).not.toContain("Unexpected");
  });

  test("密码计算容量满载返回可重试 503，不冒充密码错误", async () => {
    const authService = {
      login: async () => { throw new PasswordWorkCapacityError(); }
    } as unknown as BiAuthService;
    const app = Fastify();
    await app.register(biAuthPlugin, {
      prefix: "/api/bi/v2/auth",
      authService
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/auth/login",
      payload: { username: "alice", password: "Correct-password-2026" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.json().error.code).toBe("AUTH_SERVICE_UNAVAILABLE");
  });

  test("会话读取重新派生 CSRF，未登录明确返回 401", async () => {
    const { app } = await createApp();
    const unauthorized = await app.inject({ method: "GET", url: "/api/bi/v2/auth/session" });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json().error.code).toBe("AUTHENTICATION_REQUIRED");

    const loggedIn = await login(app);
    const sessionPair = cookiePair(loggedIn.headers["set-cookie"], BI_SESSION_COOKIE);
    expect(sessionPair).not.toBeNull();
    const session = await app.inject({
      method: "GET",
      url: "/api/bi/v2/auth/session",
      headers: { cookie: sessionPair! }
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().data.csrfToken).toBe(loggedIn.json().data.csrfToken);
    expect(session.headers["set-cookie"]).toBeUndefined();
  });

  test("会话查询超过期限时取消底层查询并稳定返回 503", async () => {
    let lookupSignal: AbortSignal | undefined;
    const authService = {
      resolveSession: (_token: string | null, signal?: AbortSignal) => {
        lookupSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("query_cancelled")), { once: true });
        });
      }
    } as unknown as BiAuthService;
    const app = Fastify();
    await app.register(biAuthPlugin, {
      prefix: "/api/bi/v2/auth",
      authService,
      sessionLookupTimeoutMs: 20
    });
    apps.push(app);

    const startedAt = Date.now();
    const response = await app.inject({
      method: "GET",
      url: "/api/bi/v2/auth/session",
      headers: { cookie: `${BI_SESSION_COOKIE}=${"a".repeat(43)}` }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("AUTH_SERVICE_UNAVAILABLE");
    expect(lookupSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test("退出要求 CSRF，成功后服务端会话立即失效", async () => {
    const { app } = await createApp();
    const loggedIn = await login(app);
    const sessionPair = cookiePair(loggedIn.headers["set-cookie"], BI_SESSION_COOKIE)!;
    const csrfToken = loggedIn.json().data.csrfToken as string;
    const cookie = sessionPair;

    const rejected = await app.inject({ method: "POST", url: "/api/bi/v2/auth/logout", headers: { cookie } });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("CSRF_VALIDATION_FAILED");
    const stillActive = await app.inject({ method: "GET", url: "/api/bi/v2/auth/session", headers: { cookie } });
    expect(stillActive.statusCode).toBe(200);

    const logout = await app.inject({
      method: "POST",
      url: "/api/bi/v2/auth/logout",
      headers: { cookie, "x-csrf-token": csrfToken }
    });
    expect(logout.statusCode).toBe(200);
    expect(setCookieValues(logout.headers["set-cookie"]).every((value) => value.includes("Max-Age=0"))).toBe(true);
    const expired = await app.inject({ method: "GET", url: "/api/bi/v2/auth/session", headers: { cookie } });
    expect(expired.statusCode).toBe(401);
  });

  test("普通退出和改密成功后撤销同一用户的关联安全上下文", async () => {
    const revokedSubjects: string[] = [];
    const { app } = await createApp({
      onSecurityContextChanged: (subjectId) => { revokedSubjects.push(subjectId); }
    });

    const first = await login(app);
    const subjectId = first.json().data.user.subjectId as string;
    const firstCookie = cookiePair(first.headers["set-cookie"], BI_SESSION_COOKIE)!;
    await app.inject({
      method: "POST",
      url: "/api/bi/v2/auth/logout",
      headers: {
        cookie: firstCookie,
        "x-csrf-token": first.json().data.csrfToken as string
      }
    });

    const second = await login(app);
    const secondCookie = cookiePair(second.headers["set-cookie"], BI_SESSION_COOKIE)!;
    const changed = await app.inject({
      method: "PUT",
      url: "/api/bi/v2/auth/password",
      headers: {
        cookie: secondCookie,
        "x-csrf-token": second.json().data.csrfToken as string
      },
      payload: {
        currentPassword: "Correct-password-2026",
        newPassword: "Replacement-password-2026"
      }
    });

    expect(changed.statusCode).toBe(200);
    expect(revokedSubjects).toEqual([subjectId, subjectId]);
  });

  test("关联安全上下文撤销失败时返回稳定错误并清除已失效会话 Cookie", async () => {
    const { app } = await createApp({
      onSecurityContextChanged: async () => { throw new Error("maintenance session store unavailable"); }
    });
    const loggedIn = await login(app);
    const cookie = cookiePair(loggedIn.headers["set-cookie"], BI_SESSION_COOKIE)!;
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/auth/logout",
      headers: {
        cookie,
        "x-csrf-token": loggedIn.json().data.csrfToken as string
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("AUTH_SERVICE_UNAVAILABLE");
    expect(setCookieValues(response.headers["set-cookie"])[0]).toContain("Max-Age=0");
    expect((await app.inject({
      method: "GET",
      url: "/api/bi/v2/auth/session",
      headers: { cookie }
    })).statusCode).toBe(401);
  });

  test("修改密码校验当前密码并使全部旧会话失效", async () => {
    const { app } = await createApp();
    const first = await login(app);
    const second = await login(app);
    const firstSession = cookiePair(first.headers["set-cookie"], BI_SESSION_COOKIE)!;
    const firstCsrfToken = first.json().data.csrfToken as string;

    const changed = await app.inject({
      method: "PUT",
      url: "/api/bi/v2/auth/password",
      headers: {
        cookie: firstSession,
        "x-csrf-token": firstCsrfToken
      },
      payload: { currentPassword: "Correct-password-2026", newPassword: "Replacement-password-2026" }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data.mustChangePassword).toBe(false);
    expect(changed.json().data.user.permissions).toEqual(permissionsByRole.analyst);
    const replacementCookie = cookiePair(changed.headers["set-cookie"], BI_SESSION_COOKIE)!;
    const secondCookie = cookiePair(second.headers["set-cookie"], BI_SESSION_COOKIE)!;
    const oldSession = await app.inject({ method: "GET", url: "/api/bi/v2/auth/session", headers: { cookie: secondCookie } });
    expect(oldSession.statusCode).toBe(401);
    const replacementSession = await app.inject({ method: "GET", url: "/api/bi/v2/auth/session", headers: { cookie: replacementCookie } });
    expect(replacementSession.statusCode).toBe(200);
    expect((await login(app)).statusCode).toBe(401);
    expect((await login(app, "Replacement-password-2026")).statusCode).toBe(200);
  });

  test("当前密码错误返回业务校验错误且保留登录会话", async () => {
    const { app } = await createApp();
    const loggedIn = await login(app);
    const sessionCookie = cookiePair(loggedIn.headers["set-cookie"], BI_SESSION_COOKIE)!;
    const csrfToken = loggedIn.json().data.csrfToken as string;
    const rejected = await app.inject({
      method: "PUT",
      url: "/api/bi/v2/auth/password",
      headers: { cookie: sessionCookie, "x-csrf-token": csrfToken },
      payload: { currentPassword: "Wrong-password-2026", newPassword: "Replacement-password-2026" }
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("CURRENT_PASSWORD_INVALID");
    const stillActive = await app.inject({
      method: "GET",
      url: "/api/bi/v2/auth/session",
      headers: { cookie: sessionCookie }
    });
    expect(stillActive.statusCode).toBe(200);
  });

  test("停用账号立即撤销会话且没有自助注册接口", async () => {
    const { app, accounts } = await createApp();
    const loggedIn = await login(app);
    const session = cookiePair(loggedIn.headers["set-cookie"], BI_SESSION_COOKIE)!;
    await accounts.disableAccount("alice");

    const response = await app.inject({ method: "GET", url: "/api/bi/v2/auth/session", headers: { cookie: session } });
    expect(response.statusCode).toBe(401);
    expect((await login(app)).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/bi/v2/auth/register", payload: {} })).statusCode).toBe(404);
  });
});
