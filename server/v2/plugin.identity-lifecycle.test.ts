import { afterEach, describe, expect, spyOn, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { request as httpRequest, type ServerResponse } from "node:http";
import type { IdentityProvider, IdentityResolution } from "../identity/identity-provider";
import { DailyDashboardService } from "./daily-dashboard.service";
import { v2BiPlugin } from "./plugin";

const openApps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(openApps.splice(0).map(app => app.close())); });

const authenticated: IdentityResolution = {
  status: "authenticated",
  principal: { subjectId: "identity-lifecycle-user", roles: ["reader"], permissions: ["bi:read"], pidScope: "all", securityVersion: "1" }
};
const dailyQuery = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-16", "2026-10-16"] };
const routes = [
  { method: "GET" as const, path: "/api/bi/v2/catalog/metrics" },
  { method: "POST" as const, path: "/api/bi/v2/queries/dashboards/daily-reading" }
];

async function createApp(identityProvider: IdentityProvider) {
  const logs: Record<string, unknown>[] = [];
  const sentStatuses: number[] = [];
  let businessEntries = 0;
  const app = Fastify({ logger: { level: "warn", stream: { write: (line: string) => { logs.push(JSON.parse(line)); } } } });
  openApps.push(app);
  app.addHook("onSend", async (_request, reply, payload) => { sentStatuses.push(reply.statusCode); return payload; });
  const daily = new DailyDashboardService({ get: async path => path.includes("/bi/v1/")
    ? { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-10-17T00:00:00Z", watermark: null, rows: [] } }
    : { msg: { pageData: [], totalCount: 0, totalData: [] }, data: [] } }, () => new Date("2026-10-17T00:00:00Z"));
  await app.register(v2BiPlugin, {
    prefix: "/api/bi/v2", identityProvider,
    metricQueryService: { execute: async () => { businessEntries++; throw new Error("unexpected metric query"); } },
    dailyDashboardService: { execute: (query, signal) => { businessEntries++; return daily.execute(query, signal); } },
    productionDailyDashboardEnabled: true
  });
  return { app, logs, sentStatuses, businessEntries: () => businessEntries };
}

describe("V2 身份读取的客户端生命周期", () => {
  for (const route of routes) for (const late of ["authenticated", "rejected"] as const) {
    test(`${route.method} ${route.path}断连后迟到身份${late}不发送503、不授权，后续请求恢复`, async () => {
      const started = Promise.withResolvers<AbortSignal>();
      const completed = Promise.withResolvers<IdentityResolution>();
      let first = true;
      const fixture = await createApp({ resolve: ({ signal }) => {
        if (!first) return Promise.resolve(authenticated);
        first = false;
        started.resolve(signal);
        return completed.promise;
      } });
      let response: ServerResponse | undefined;
      let writes: ReturnType<typeof spyOn> | undefined;
      fixture.app.server.on("request", (request, reply) => {
        if (request.url !== route.path) return;
        response = reply;
        writes = spyOn(reply, "writeHead");
      });
      const origin = await fixture.app.listen({ port: 0, host: "127.0.0.1" });
      const body = route.method === "POST" ? JSON.stringify(dailyQuery) : undefined;
      const client = httpRequest(`${origin}${route.path}`, {
        method: route.method,
        ...(body ? { headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } } : {})
      });
      client.on("error", () => {});
      client.end(body);
      const signal = await started.promise;
      const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      client.destroy();
      await aborted;
      if (late === "authenticated") completed.resolve(authenticated);
      else completed.reject(new Error("late isolated identity failure"));
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(response?.destroyed).toBe(true);
      expect(writes).toHaveBeenCalledTimes(0);
      expect(fixture.sentStatuses).toEqual([]);
      expect(fixture.logs).toEqual([]);
      expect(fixture.businessEntries()).toBe(0);
      const healthy = await fixture.app.inject({ method: route.method, url: route.path, ...(body ? { payload: dailyQuery } : {}) });
      expect(healthy.statusCode).toBe(200);
      expect(fixture.businessEntries()).toBe(route.method === "POST" ? 1 : 0);
    });
  }

  for (const route of routes) test(`${route.method} ${route.path}连接仍在时保持503、401和403身份契约`, async () => {
    const cases: Array<{ resolution: IdentityResolution | Error; status: number; code: string }> = [
      { resolution: new Error("isolated private identity failure"), status: 503, code: "IDENTITY_PROVIDER_UNAVAILABLE" },
      { resolution: { status: "unavailable" }, status: 503, code: "IDENTITY_PROVIDER_UNAVAILABLE" },
      { resolution: { status: "unauthenticated" }, status: 401, code: "AUTHENTICATION_REQUIRED" },
      { resolution: { ...authenticated, principal: { ...authenticated.principal, permissions: [] } }, status: 403, code: "BI_READ_ACCESS_DENIED" }
    ];
    for (const item of cases) {
      const fixture = await createApp({ resolve: async () => {
        if (item.resolution instanceof Error) throw item.resolution;
        return item.resolution;
      } });
      const result = await fixture.app.inject({ method: route.method, url: route.path, ...(route.method === "POST" ? { payload: dailyQuery } : {}) });
      expect(result.statusCode).toBe(item.status);
      expect(result.json()).toMatchObject({ success: false, error: { code: item.code, requestId: expect.any(String) } });
      expect(result.body).not.toContain("isolated private identity failure");
      expect(fixture.businessEntries()).toBe(0);
    }
  });

  for (const route of routes) test(`${route.method} ${route.path}连接仍在时原3秒deadline继续返回503`, async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const completed = Promise.withResolvers<IdentityResolution>();
    const fixture = await createApp({ resolve: ({ signal }) => { started.resolve(signal); return completed.promise; } });
    const result = await fixture.app.inject({ method: route.method, url: route.path, ...(route.method === "POST" ? { payload: dailyQuery } : {}) });
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
    expect((await started.promise).aborted).toBe(true);
    expect(fixture.logs.find(event => event.outcome === "identity_provider_failed")).toMatchObject({
      identityLookup: { failureCode: "deadline_exceeded", deadlineMs: 3_000 }
    });
    expect(fixture.businessEntries()).toBe(0);
    completed.resolve(authenticated);
  });
});
