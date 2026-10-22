import { afterEach, describe, expect, spyOn, test } from "bun:test";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { request as httpRequest, type ServerResponse } from "node:http";
import { identityLookupFailureDiagnostics } from "../identity/identity-lookup-diagnostics";
import { LOCAL_BI_SESSION_COOKIE } from "./cookies";
import { biAuthPlugin } from "./plugin";
import type { BiAccountAdminService, BiAuthService, ResolvedAuthSession } from "./service";
import { teamAccountPlugin } from "./team-plugin";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const token = "lifecycle_session_".padEnd(43, "a");
const session = {
  principal: { subjectId: "00000000-0000-4000-8000-000000000001", username: "lifecycle.manager", role: "maintainer", permissions: ["bi:read"] },
  record: { user: { mustChangePassword: false } }
} as unknown as ResolvedAuthSession;
const headers = { cookie: `${LOCAL_BI_SESSION_COOKIE.name}=${token}`, origin: "https://lifecycle.invalid", "x-csrf-token": "lifecycle-csrf" };
const routes = [
  { method: "GET" as const, path: "/auth/session", payload: undefined },
  { method: "POST" as const, path: "/auth/logout", payload: undefined },
  { method: "PUT" as const, path: "/auth/password", payload: { currentPassword: "lifecycle-current", newPassword: "lifecycle-next" } },
  { method: "GET" as const, path: "/team", payload: undefined },
  { method: "POST" as const, path: "/team", payload: { username: "lifecycle.new", password: "lifecycle-password", role: "reader" } }
];

async function fixture(read: (signal: AbortSignal) => Promise<ResolvedAuthSession | null>, failOperation = false) {
  const logs: Record<string, unknown>[] = [], sentStatuses: number[] = [];
  let operations = 0, request: FastifyRequest | undefined;
  const operation = () => { operations++; if (failOperation) throw new Error("isolated business failure"); };
  const app = Fastify({ logger: { level: "warn", stream: { write: (line: string) => { logs.push(JSON.parse(line)); } } } });
  apps.push(app);
  app.addHook("onRequest", async current => { request = current; });
  app.addHook("onSend", async (_request, reply, payload) => { sentStatuses.push(reply.statusCode); return payload; });
  const service = {
    resolveSession: (_token: string, signal: AbortSignal) => read(signal),
    csrfMatches: () => true,
    sessionData: () => { operation(); return { active: true }; },
    logout: async () => { operation(); },
    changePassword: async () => {
      operation();
      return { sessionToken: token, principal: session.principal, expiresAt: new Date("2026-11-01T00:00:00Z"), mustChangePassword: false, csrfToken: "lifecycle-csrf" };
    },
    sessionTtlSeconds: () => 900
  } as unknown as BiAuthService;
  const accounts = {
    listAccounts: async () => { operation(); return { items: [], total: 0 }; },
    createAccount: async () => { operation(); return { id: "lifecycle-created" }; }
  } as unknown as BiAccountAdminService;
  await app.register(biAuthPlugin, { prefix: "/auth", authService: service, sessionCookie: LOCAL_BI_SESSION_COOKIE, expectedOrigin: headers.origin });
  await app.register(teamAccountPlugin, { prefix: "/team", authService: service, accounts, sessionCookie: LOCAL_BI_SESSION_COOKIE, expectedOrigin: headers.origin });
  return { app, logs, sentStatuses, operations: () => operations, request: () => request };
}

describe("会话及团队身份读取的客户端生命周期", () => {
  for (const route of routes) for (const late of ["authenticated", "rejected"] as const) {
    test(`${route.method} ${route.path}身份等待断连后迟到${late}不响应或执行操作，下一请求恢复`, async () => {
      const started = Promise.withResolvers<AbortSignal>();
      const completed = Promise.withResolvers<ResolvedAuthSession | null>();
      let first = true;
      const current = await fixture(signal => {
        if (!first) return Promise.resolve(session);
        first = false; started.resolve(signal); return completed.promise;
      });
      let response: ServerResponse | undefined, writes: ReturnType<typeof spyOn> | undefined;
      current.app.server.on("request", (request, reply) => {
        if (request.url !== route.path) return;
        response = reply; writes = spyOn(reply, "writeHead");
      });
      const origin = await current.app.listen({ port: 0, host: "127.0.0.1" });
      const body = route.payload ? JSON.stringify(route.payload) : undefined;
      const client = httpRequest(`${origin}${route.path}`, { method: route.method,
        headers: { ...headers, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) } });
      client.on("error", () => {}); client.end(body);
      const signal = await started.promise;
      const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      client.destroy(); await aborted;
      if (late === "authenticated") completed.resolve(session);
      else completed.reject(new Error("isolated late identity failure"));
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(identityLookupFailureDiagnostics(current.request()).failureCode).toBe("client_aborted");
      expect(response?.destroyed).toBe(true);
      expect(writes).toHaveBeenCalledTimes(0);
      expect(current.sentStatuses).toEqual([]);
      expect(current.logs).toEqual([]);
      expect(current.operations()).toBe(0);
      const healthy = await current.app.inject({ method: route.method, url: route.path, headers, ...(route.payload ? { payload: route.payload } : {}) });
      expect(healthy.statusCode).toBe(route.method === "POST" && route.path === "/team" ? 201 : 200);
      expect(current.operations()).toBe(1);
    });
  }

  for (const route of routes) test(`${route.method} ${route.path}连接仍在的存储失败和未登录分别保持503/401`, async () => {
    for (const failed of [true, false]) {
      const current = await fixture(async () => { if (failed) throw new Error("isolated storage failure"); return null; });
      const result = await current.app.inject({ method: route.method, url: route.path, headers, ...(route.payload ? { payload: route.payload } : {}) });
      expect(result.statusCode).toBe(failed ? 503 : 401);
      expect(result.json().error.code).toBe(!failed ? "AUTHENTICATION_REQUIRED" : route.path === "/team" ? "TEAM_SERVICE_UNAVAILABLE" : "AUTH_SERVICE_UNAVAILABLE");
      expect(current.operations()).toBe(0);
      expect(identityLookupFailureDiagnostics(current.request()).failureCode).not.toBe("client_aborted");
    }
  });

  for (const route of [routes[1], routes[2], routes[3]]) test(`${route.method} ${route.path}普通业务错误继续返回503`, async () => {
    const current = await fixture(async () => session, true);
    const result = await current.app.inject({ method: route.method, url: route.path, headers, ...(route.payload ? { payload: route.payload } : {}) });
    expect(result.statusCode).toBe(503);
    expect(current.operations()).toBe(1);
    expect(current.sentStatuses).toEqual([503]);
    expect(identityLookupFailureDiagnostics(current.request()).failureCode).toBe("unknown");
  });

  for (const route of [routes[0], routes[3]]) test(`${route.path}连接仍在时原3秒deadline继续失败关闭`, async () => {
    const completed = Promise.withResolvers<ResolvedAuthSession | null>();
    const current = await fixture(() => completed.promise);
    const result = await current.app.inject({ method: route.method, url: route.path, headers });
    expect(result.statusCode).toBe(503);
    expect(identityLookupFailureDiagnostics(current.request())).toMatchObject({ failureCode: "deadline_exceeded", deadlineMs: 3_000 });
    expect(current.sentStatuses).toEqual([503]);
    expect(current.operations()).toBe(0);
    completed.resolve(session);
  });
});
