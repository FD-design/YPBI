import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OPERATING_METRIC_IDS } from "../../contracts/operating-detail-projection";
import type { IdentityResolution } from "../identity/identity-provider";
import { currentUpstreamRequestProfile } from "../upstream/request-profile";
import { UpstreamError } from "../upstream/client";
import { DailyDashboardService, dailyDashboardCatalog, type DailyDashboardExecutor } from "./daily-dashboard.service";
import { v2BiPlugin } from "./plugin";

const query = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-05", "2026-10-12"] as [string, string], projection: "operating_snapshot" as const };
const service = () => new DailyDashboardService({ get: async path => path.includes("/bi/v1/")
  ? { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-10-14T00:00:00Z", watermark: null, rows: [] } }
  : { msg: { pageData: [], totalCount: 0, totalData: [] }, data: [] } }, () => new Date("2026-10-14T00:00:00Z"));
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const reader = (role = "reader", pidScope: "all" | string[] = ["PH"]): IdentityResolution => ({ status: "authenticated", principal: {
  subjectId: "fixture-reader", roles: [role], permissions: ["bi:read"], pidScope
} });
async function appFor(identity: IdentityResolution = reader(), executor: DailyDashboardExecutor = service(), setup?: (app: FastifyInstance) => void) {
  const app = Fastify(); apps.push(app);
  setup?.(app);
  await app.register(v2BiPlugin, { prefix: "/api/bi/v2", identityProvider: { resolve: async () => identity },
    metricQueryService: { execute: async () => { throw new Error("not requested"); } },
    dailyDashboardService: executor, productionDailyDashboardEnabled: true });
  return app;
}
describe("兼容经营快照HTTP边界", () => {
  for (const event of ["request_abort", "premature_response_close"] as const) test(`${event}透传内部取消信号并清理路由监听`, async () => {
    let rawRequest!: IncomingMessage, rawResponse!: ServerResponse;
    let signal!: AbortSignal, requestListeners: Function[] = [], responseListeners: Function[] = [];
    const app = await appFor(reader(), { execute: async (_query, received) => {
      signal = received!;
      expect(signal.aborted).toBe(false);
      if (event === "request_abort") rawRequest.emit("aborted");
      else rawResponse.emit("close");
      expect(signal.aborted).toBe(true);
      throw new UpstreamError("UPSTREAM_TIMEOUT", "fixture cancelled", 504);
    } }, app => app.addHook("onRequest", (request, reply, done) => {
      rawRequest = request.raw; rawResponse = reply.raw;
      requestListeners = rawRequest.listeners("aborted"); responseListeners = rawResponse.listeners("close");
      done();
    }));
    const result = await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: query }).catch(error => error);
    if (event === "premature_response_close") expect(result.code).toBe("LIGHT_ECONNRESET");
    else expect(result.statusCode).toBe(504);
    await new Promise(resolve => setTimeout(resolve, 0));
    // The injection transport removes its own once-listeners on completion;
    // the route must leave no additional listeners behind.
    expect(rawRequest.listeners("aborted").every(listener => requestListeners.includes(listener))).toBe(true);
    expect(rawResponse.listeners("close").every(listener => responseListeners.includes(listener))).toBe(true);
  });

  test("正常响应完成清理取消监听，不改变93列且正常关闭不取消已完成查询", async () => {
    let rawRequest!: IncomingMessage, rawResponse!: ServerResponse, signal!: AbortSignal;
    let requestListeners: Function[] = [], responseListeners: Function[] = [];
    const app = await appFor(reader(), { execute: (request, received) => {
      signal = received!; return service().execute(request, signal);
    } }, app => app.addHook("onRequest", (request, reply, done) => {
      rawRequest = request.raw; rawResponse = reply.raw;
      requestListeners = rawRequest.listeners("aborted"); responseListeners = rawResponse.listeners("close");
      done();
    }));
    const result = await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: query });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.series).toHaveLength(93);
    expect(rawRequest.listeners("aborted").every(listener => requestListeners.includes(listener))).toBe(true);
    expect(rawResponse.listeners("close").every(listener => responseListeners.includes(listener))).toBe(true);
    rawResponse.emit("close"); rawRequest.emit("aborted");
    expect(signal.aborted).toBe(false);
  });

  for (const role of ["reader", "analyst", "maintainer"]) test(`${role}读取93列，默认121列仍保留`, async () => {
    const app = await appFor(reader(role));
    const snapshot = await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: query });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.headers["cache-control"]).toContain("no-store");
    expect(snapshot.json().data.series.map((series: { metric: { id: string } }) => series.metric.id)).toEqual(OPERATING_METRIC_IDS);
    const { projection: _projection, ...defaultQuery } = query;
    const full = await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: defaultQuery });
    expect(full.statusCode).toBe(200);
    expect(full.json().data.series.map((series: { metric: { id: string } }) => series.metric.id)).toEqual(dailyDashboardCatalog(true).data.items.find(board => board.id === "5.2")!.metricIds);
    expect(full.json().data.series).toHaveLength(121);
    expect(full.json().data.series[0].points).toHaveLength(8);
  });
  for (const [identity, status] of [[{ status: "unauthenticated" }, 401], [{ status: "unavailable", reason: "fixture" }, 503],
    [{ status: "authenticated", principal: { subjectId: "none", roles: [], permissions: [], pidScope: "all" } }, 403]] as const) test(`身份拒绝${status}且不执行来源`, async () => {
    let called = false;
    const app = await appFor(identity, { execute: async () => { called = true; throw new Error("not requested"); } });
    expect((await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: query })).statusCode).toBe(status);
    expect(called).toBe(false);
  });
  test("范围外PID与非法快照参数仍在读取前拒绝", async () => {
    let called = false;
    const app = await appFor(reader(), { execute: async () => { called = true; throw new Error("not requested"); } });
    for (const [change, status] of [[{ pid: "TT" }, 403], [{ boardId: "5.8" }, 400], [{ dateRange: ["2026-10-12", "2026-10-12"] }, 400], [{ projection: "other" }, 400]] as const) {
      expect((await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: { ...query, ...change } })).statusCode).toBe(status);
    }
    expect(called).toBe(false);
  });
  test("执行器不能把121列旧响应冒充经营快照", async () => {
    const { projection: _projection, ...defaultQuery } = query;
    const old = await service().execute(defaultQuery);
    const app = await appFor(reader(), { execute: async () => old });
    const result = await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: query });
    expect(result.statusCode).toBe(502);
    expect(result.json().error.code).toBe("DAILY_SOURCE_CONFLICT");
  });
  test("测试环境沿用临时会话而不回退正式数据源", async () => {
    let profile: ReturnType<typeof currentUpstreamRequestProfile>;
    const app = Fastify(); apps.push(app);
    await app.register(v2BiPlugin, { prefix: "/api/bi/v2", identityProvider: { resolve: async () => reader() },
      metricQueryService: { execute: async () => { throw new Error("not requested"); } },
      dailyDashboardService: { execute: request => { profile = currentUpstreamRequestProfile(); return service().execute(request); } },
      dataEnvironmentResolver: { testAvailable: true, resolveTest: () => ({ status: "active", expiresAt: Date.now() + 60_000,
        profile: { environment: "test", baseUrl: "https://fixture.invalid", token: "fixture-only", userName: "fixture-user", cachePartition: "fixture-test" } }) } });
    const result = await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", headers: { "x-ypbi-data-environment": "test" }, payload: query });
    expect(result.statusCode).toBe(200);
    expect(profile?.environment).toBe("test");
    expect(result.body).not.toContain("fixture-only");
  });
});
