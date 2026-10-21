import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { v2BiPlugin, type V2BiPluginOptions } from "./plugin";
import { QueryJobBusinessError } from "../upstream/query-jobs";
import { currentUpstreamRequestProfile } from "../upstream/request-profile";
import { v2ApiErrorSchema } from "../../contracts/bi-v2";
import { dailyDashboardCatalogSchema } from "../../contracts/daily-dashboard";
import { getEnabledPlatformByPid } from "../platforms/registry";
import { listV2Platforms } from "./catalog";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function app(options: Partial<V2BiPluginOptions> = {}) {
  const instance = Fastify(); apps.push(instance);
  await instance.register(v2BiPlugin, {
    prefix: "/api/bi/v2", identityProvider: { resolve: async () => ({ status: "authenticated", principal: { subjectId: "fixture", roles: ["viewer"], permissions: ["bi:read"], pidScope: ["PH"] } }) },
    metricQueryService: { execute: async () => { throw new Error("unused"); } }, productionDailyDashboardEnabled: true, ...options
  });
  return instance;
}
const handle = randomUUID();
const operatingHandle = randomUUID();
const testHeaders = { "x-ypbi-data-environment": "test" };
const testProfile = { environment: "test" as const, baseUrl: "https://fixture.invalid", userName: "fixture-user", token: "fixture-secret", cachePartition: "fixture-session" };
const dataEnvironmentResolver: NonNullable<V2BiPluginOptions["dataEnvironmentResolver"]> = {
  testAvailable: true, resolveTest: () => ({ status: "active", expiresAt: Date.now() + 1000, profile: testProfile })
};
const operatingService = (seen: unknown[] = []): NonNullable<V2BiPluginOptions["operatingQueryJobService"]> => {
  const scope = { kind: "operating-snapshot" as const, pids: ["PH"], date: "2026-10-17", handle: operatingHandle };
  return {
    handles: value => value === operatingHandle,
    create: async (...args) => { seen.push({ args, profile: currentUpstreamRequestProfile() }); return { success: true, data: { ...scope, reused: false } }; },
    status: async (...args) => { seen.push({ args, profile: currentUpstreamRequestProfile() }); return { success: true, data: { ...scope, status: "RUNNING", phase: "query" } }; },
    result: async (...args) => { seen.push({ args, profile: currentUpstreamRequestProfile() }); return { success: true, data: { ...scope, status: "EXPIRED", phase: "query" } }; }
  };
};
const service = (seen: unknown[] = []): NonNullable<V2BiPluginOptions["queryJobService"]> => ({
  create: async (...args) => { seen.push({ args, profile: currentUpstreamRequestProfile() }); return { success: true, data: { handle, reused: false } }; },
  status: async (...args) => { seen.push({ args, profile: currentUpstreamRequestProfile() }); return { success: true, data: { handle, status: "RUNNING" } }; },
  result: async (...args) => { seen.push({ args, profile: currentUpstreamRequestProfile() }); return { success: true, data: { handle, status: "EXPIRED" } }; }
});

describe("BI异步路由边界", () => {
  test("默认未注入，不改变原有读取或擅自调用上游", async () => {
    const response = await (await app()).inject({ method: "POST", url: "/api/bi/v2/queries/jobs", payload: {} });
    expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe("QUERY_JOBS_DISABLED");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  for (const [state, status] of [["unauthenticated", 401], ["unavailable", 503]] as const) test(`三阶段均受${state}保护`, async () => {
    const seen: unknown[] = [], instance = await app({ identityProvider: { resolve: async () => ({ status: state }) }, queryJobService: service(seen) });
    for (const [method, suffix] of [["POST", ""], ["GET", `/${handle}`], ["GET", `/${handle}/result`]] as const) {
      const response = await instance.inject({ method, url: `/api/bi/v2/queries/jobs${suffix}`, ...(method === "POST" ? { payload: {} } : {}) });
      expect(response.statusCode).toBe(status);
    }
    expect(seen).toHaveLength(0);
  });
  test("缺BI读取权限不进入任务服务", async () => {
    const seen: unknown[] = [], instance = await app({ queryJobService: service(seen), identityProvider: { resolve: async () => ({ status: "authenticated", principal: { subjectId: "fixture", roles: [], permissions: [], pidScope: "all" } }) } });
    expect((await instance.inject(`/api/bi/v2/queries/jobs/${handle}`)).statusCode).toBe(403);
    expect(seen).toHaveLength(0);
  });
  test("测试会话缺失不回退正式", async () => {
    const seen: unknown[] = [], instance = await app({ queryJobService: service(seen), dataEnvironmentResolver: { testAvailable: true, resolveTest: () => ({ status: "expired" }) } });
    const response = await instance.inject({ url: `/api/bi/v2/queries/jobs/${handle}`, headers: { "x-ypbi-data-environment": "test" } });
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe("DATA_PREVIEW_SESSION_REQUIRED"); expect(seen).toHaveLength(0);
  });
  test("三个操作使用同一请求级测试profile，不改正式来源", async () => {
    const seen: unknown[] = [], profile = { environment: "test" as const, baseUrl: "https://fixture.invalid", userName: "fixture-user", token: "fixture-secret", cachePartition: "fixture-session" };
    const instance = await app({ queryJobService: service(seen), dataEnvironmentResolver: { testAvailable: true, resolveTest: () => ({ status: "active", expiresAt: Date.now() + 1000, profile }) } });
    for (const [method, suffix] of [["POST", ""], ["GET", `/${handle}`], ["GET", `/${handle}/result`]] as const) {
      const response = await instance.inject({ method, url: `/api/bi/v2/queries/jobs${suffix}`, headers: { "x-ypbi-data-environment": "test" }, ...(method === "POST" ? { payload: {} } : {}) });
      expect(response.statusCode).toBe(200); expect(response.body).not.toContain("fixture-secret");
    }
    expect(seen).toHaveLength(3); expect(seen.every(value => (value as { profile: unknown }).profile === profile)).toBe(true);
  });
  test("正式日看板开关与服务装配不能开启正式三步任务入口", async () => {
    const seen: unknown[] = [], operatingSeen: unknown[] = [];
    const instance = await app({ queryJobService: service(seen), operatingQueryJobService: operatingService(operatingSeen), dataEnvironmentResolver });
    for (const target of [handle, operatingHandle]) for (const [method, suffix] of [["POST", ""], ["GET", `/${target}`], ["GET", `/${target}/result`]] as const) {
      const response = await instance.inject({ method, url: `/api/bi/v2/queries/jobs${suffix}`, ...(method === "POST" ? { payload: { kind: "operating-snapshot", pids: ["PH"], date: "2026-10-17" } } : {}) });
      expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe("QUERY_JOBS_DISABLED");
    }
    expect(seen).toHaveLength(0); expect(operatingSeen).toHaveLength(0);
  });
  test("经营kind与句柄只转给经营编排，旧显式查询协议保持独立", async () => {
    const seen: unknown[] = [], operatingSeen: unknown[] = [];
    const instance = await app({ queryJobService: service(seen), operatingQueryJobService: operatingService(operatingSeen), dataEnvironmentResolver });
    for (const [method, suffix] of [["POST", ""], ["GET", `/${operatingHandle}`], ["GET", `/${operatingHandle}/result`]] as const) {
      const response = await instance.inject({ method, url: `/api/bi/v2/queries/jobs${suffix}`, headers: testHeaders, ...(method === "POST" ? { payload: { kind: "operating-snapshot", pids: ["PH"], date: "2026-10-17" } } : {}) });
      expect(response.statusCode).toBe(200); expect(response.json().data.kind).toBe("operating-snapshot");
      expect(response.body).not.toContain("fixture-secret");
    }
    expect(seen).toHaveLength(0); expect(operatingSeen).toHaveLength(3);
    expect(operatingSeen.every(value => (value as { profile: unknown }).profile === testProfile)).toBe(true);
    expect((await instance.inject({ method: "POST", url: "/api/bi/v2/queries/jobs", headers: testHeaders, payload: { queries: [] } })).statusCode).toBe(200);
    expect(seen).toHaveLength(1);
  });
  test("未装配经营编排时不能把经营请求交给通用任务服务", async () => {
    const seen: unknown[] = [], instance = await app({ queryJobService: service(seen), dataEnvironmentResolver });
    const response = await instance.inject({ method: "POST", url: "/api/bi/v2/queries/jobs", headers: testHeaders, payload: { kind: "operating-snapshot", pids: ["PH"], date: "2026-10-17" } });
    expect(response.statusCode).toBe(422); expect(seen).toHaveLength(0);
  });
  test("目录仅向已验证测试会话提供已授权同站PID分组", async () => {
    const instance = await app({ queryJobService: service(), operatingQueryJobService: operatingService(), dataEnvironmentResolver,
      dailyDashboardService: { execute: async () => { throw new Error("unused"); } },
      identityProvider: { resolve: async () => ({ status: "authenticated", principal: { subjectId: "fixture", roles: ["viewer"], permissions: ["bi:read"], pidScope: ["PH", "FBI", "UNKNOWN"] } }) }
    });
    const production = (await instance.inject("/api/bi/v2/catalog/readable-dashboards")).json();
    expect(production.data.enabled).toBe(true); expect(production.data.operatingAsyncEnabled).toBe(false);
    expect(production.data.operatingAsyncPidGroups).toBeUndefined();
    const response = await instance.inject({ url: "/api/bi/v2/catalog/readable-dashboards", headers: testHeaders });
    const catalog = dailyDashboardCatalogSchema.parse(response.json());
    expect(catalog.data.operatingAsyncEnabled).toBe(true);
    const groups = catalog.data.operatingAsyncPidGroups!;
    expect(groups.flat().sort()).toEqual(["FBI", "PH"]);
    expect(new Set(groups.flat()).size).toBe(groups.flat().length);
    expect(groups.every(group => group.length <= 20 && new Set(group.map(pid => getEnabledPlatformByPid(pid)?.siteId)).size === 1)).toBe(true);
    expect(groups.flat().every(pid => listV2Platforms(["PH", "FBI"]).some(platform => platform.pid === pid))).toBe(true);
  });
  test("测试目录没有完整服务装配时不发出启用信号或分组", async () => {
    const instance = await app({ queryJobService: service(), dataEnvironmentResolver, dailyDashboardService: { execute: async () => { throw new Error("unused"); } } });
    const response = await instance.inject({ url: "/api/bi/v2/catalog/readable-dashboards", headers: testHeaders });
    expect(response.json().data.operatingAsyncEnabled).toBe(false); expect(response.json().data.operatingAsyncPidGroups).toBeUndefined();
  });
  for (const businessCode of [400, 404, 409, 500]) test(`保留数字业务码${businessCode}与实际HTTP，不回显原错误`, async () => {
    const queryJobService = service(); queryJobService.status = async () => { throw new QueryJobBusinessError(businessCode, 200); };
    const response = await (await app({ queryJobService, dataEnvironmentResolver })).inject({ url: `/api/bi/v2/queries/jobs/${handle}`, headers: testHeaders });
    expect(response.statusCode).toBe(businessCode === 500 ? 502 : businessCode);
    expect(response.json().error).toMatchObject({ code: "QUERY_JOB_UPSTREAM_REJECTED", upstreamBusinessCode: businessCode, upstreamHttpStatus: 200 });
    expect(v2ApiErrorSchema.safeParse(response.json()).success).toBe(true);
  });
});
