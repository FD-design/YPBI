import { afterEach, describe, expect, test } from "bun:test";
import { OperatingQueryJobService } from "./operating-query-jobs.service";
import { BiQueryJobService } from "./query-jobs.service";
import { DailyDashboardService } from "./daily-dashboard.service";
import { currentUpstreamRequestProfile, runWithUpstreamRequestProfile, type UpstreamRequestProfile } from "../upstream/request-profile";
import { UpstreamError } from "../upstream/client";
import type { QueryJobContext, QueryJobCreateRequest, QueryJobResult, QueryJobStatus } from "../upstream/query-jobs";
import type { Principal } from "../identity/identity-provider";
import { getEnabledPlatformByPid } from "../platforms/registry";
import { operatingQueryJobResultSchema } from "../../contracts/operating-query-jobs";
import { OPERATING_METRIC_IDS } from "../../contracts/operating-detail-projection";

const profile: UpstreamRequestProfile = { environment: "test", baseUrl: "https://fixture.invalid", userName: "fixture-account", token: "fixture-token", cachePartition: "fixture-session" };
const principal: Principal = { subjectId: "fixture-user", securityVersion: "v1", roles: ["viewer"], permissions: ["bi:read"], pidScope: ["PH"] };
const request = { kind: "operating-snapshot", pids: ["PH"], date: "2026-10-17" };
const services: OperatingQueryJobService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
const inTest = <T>(operation: () => Promise<T>, source = profile) => runWithUpstreamRequestProfile(source, operation);
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(holdLegacy = false, productionEnabled = false) {
  let time = Date.parse("2026-10-21T04:20:00Z"), state: QueryJobStatus["msg"]["status"] = "RUNNING";
  let productionSourceVersion = "v1";
  let queries: QueryJobCreateRequest | undefined, creates = 0, reads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const legacy: { path: string; profile: unknown }[] = [];
  const contextForPid = (routingPid: string): QueryJobContext => {
    const current = currentUpstreamRequestProfile();
    const siteId = getEnabledPlatformByPid(routingPid)!.siteId;
    return { routingPid, siteId, environment: current ? "test" : "production",
      accountRef: current?.userName ?? `${siteId}-production-account`, sourceRef: current ? `${current.token}:${current.cachePartition}` : `${siteId}:${productionSourceVersion}` };
  };
  const taskId = "0123456789abcdef0123456789abcdef";
  const message = () => ({ taskId, status: state, totalUnits: queries!.queries.length,
    completedUnits: state === "SUCCEEDED" ? queries!.queries.length : 0, attempts: 1,
    createdAtMs: time, expiresAtMs: time + 3_600_000 });
  const jobs = new BiQueryJobService({ contextForPid,
    create: async (_source, body) => { creates++; queries = body; return { code: 200, msg: { taskId, reused: false } }; },
    status: async () => { reads++; return { code: 200, msg: message() }; },
    result: async () => { reads++; return { code: 200, msg: { ...message(), ...(state === "SUCCEEDED" ? {
      results: queries!.queries.map(() => ({ generatedAt: "2026-10-21T04:20:00Z", rows: [] }))
    } : {}) } } as QueryJobResult; }
  }, () => time);
  const daily = new DailyDashboardService({ get: async path => {
    legacy.push({ path, profile: currentUpstreamRequestProfile() });
    if (holdLegacy) await gate;
    throw new UpstreamError("UPSTREAM_FAILED", "Fixture legacy source unavailable");
  } }, () => new Date(time));
  const options = { productionEnabled };
  const service = new OperatingQueryJobService(jobs, daily, () => time, options); services.push(service);
  return { service, legacy, release, state: (next: typeof state) => { state = next; }, advance: (ms: number) => { time += ms; },
    rotateProduction: () => { productionSourceVersion = "v2"; }, disableProduction: () => { options.productionEnabled = false; },
    counts: () => ({ creates, reads }), request: () => queries };
}

describe("服务器经营任务编排", () => {
  test("创建仅生成服务器计划，legacy并行启动，任务完成后等投影再交付原93列", async () => {
    const f = fixture(true);
    await inTest(async () => {
      const created = await f.service.create(principal, request);
      await settle();
      expect(created.data).toMatchObject({ kind: "operating-snapshot", pids: ["PH"], date: "2026-10-17" });
      expect(f.request()!.queries.length).toBeGreaterThan(0);
      expect(f.request()!.queries.every(unit => unit.query.pid === "PH" && unit.query.includeIncomplete)).toBe(true);
      expect(f.legacy.length).toBeGreaterThan(0);
      expect(f.legacy.every(call => call.profile === profile && !/bi\/v1\/(metrics|playback)/.test(call.path))).toBe(true);
      expect((await f.service.status(principal, created.data.handle)).data).toMatchObject({ status: "RUNNING", phase: "query", completedUnits: 0 });
      f.state("SUCCEEDED");
      expect((await f.service.result(principal, created.data.handle)).data).toMatchObject({ status: "SUCCEEDED", phase: "projection", completedUnits: f.request()!.queries.length });
      expect((await f.service.status(principal, created.data.handle)).data.phase).toBe("projection");
      f.release(); await settle();
      const result = await f.service.result(principal, created.data.handle);
      expect(operatingQueryJobResultSchema.safeParse(result).success).toBe(true);
      expect(result.data.phase).toBe("complete");
      expect(result.data.dashboards?.[0].data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
      expect(result.data.dashboards?.[0].data.query).toEqual({ boardId: "5.2", pid: "PH", projection: "operating_snapshot", dateRange: ["2026-10-10", "2026-10-17"] });
      expect(result.data.dashboards?.[0].data.series.every(series => series.points.every(point => point.value === null))).toBe(true);
      expect(JSON.stringify(result)).not.toContain("fixture-token");
    });
  });

  test("正式环境默认关闭，浏览器不能提交业务rows或自定义计划", async () => {
    const f = fixture();
    await expect(f.service.create(principal, request)).rejects.toMatchObject({ code: "QUERY_JOB_FORBIDDEN" });
    await inTest(async () => {
      for (const raw of [{ ...request, rows: [] }, { ...request, queries: [] }, { ...request, pids: ["PH", "PH"] }, { ...request, date: "invalid" }]) {
        await expect(f.service.create(principal, raw)).rejects.toMatchObject({ code: "QUERY_JOB_INVALID" });
      }
    });
    expect(f.counts().creates).toBe(0); expect(f.legacy).toHaveLength(0);
  });

  for (const pid of ["PH", "FBI"]) test(`显式开启正式${pid}原站点计划并交付93列，legacy保留正式环境`, async () => {
    const f = fixture(false, true), reader = { ...principal, pidScope: [pid] };
    const created = await f.service.create(reader, { ...request, pids: [pid] });
    await settle();
    expect(f.request()!.queries.every(unit => unit.query.pid === pid)).toBe(true);
    expect(f.legacy.length).toBeGreaterThan(0);
    expect(f.legacy.every(call => call.profile === undefined && !/bi\/v1\/(metrics|playback)/.test(call.path))).toBe(true);
    expect((await f.service.status(reader, created.data.handle)).data.status).toBe("RUNNING");
    f.state("SUCCEEDED");
    await f.service.result(reader, created.data.handle); await settle();
    const result = await f.service.result(reader, created.data.handle);
    expect(result.data.phase).toBe("complete");
    expect(result.data.dashboards?.[0].data.query.pid).toBe(pid);
    expect(result.data.dashboards?.[0].data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
    expect(operatingQueryJobResultSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/production-account|sourceRef|fixture-token/);
  });

  test("正式任务不接受跨站、越权PID、业务行或自定义计划", async () => {
    const f = fixture(false, true);
    await expect(f.service.create({ ...principal, pidScope: "all" }, { ...request, pids: ["PH", "FBI"] })).rejects.toMatchObject({ code: "QUERY_JOB_INVALID" });
    await expect(f.service.create(principal, { ...request, pids: ["FBI"] })).rejects.toMatchObject({ code: "QUERY_JOB_FORBIDDEN" });
    await expect(f.service.create({ ...principal, permissions: [] }, request)).rejects.toMatchObject({ code: "QUERY_JOB_FORBIDDEN" });
    for (const payload of [{ ...request, rows: [] }, { ...request, queries: [] }]) {
      await expect(f.service.create(principal, payload)).rejects.toMatchObject({ code: "QUERY_JOB_INVALID" });
    }
    expect(f.counts().creates).toBe(0); expect(f.legacy).toHaveLength(0);
  });

  test("正式句柄逐次校验身份、权限、PID、环境与凭据；无效访问零来源请求", async () => {
    const f = fixture(false, true), created = await f.service.create(principal, request);
    for (const changed of [
      { ...principal, subjectId: "other" }, { ...principal, securityVersion: "v2" },
      { ...principal, roles: ["maintainer"] }, { ...principal, permissions: [] },
      { ...principal, pidScope: ["FBI"] }, { ...principal, pidScope: ["PH", "FBI"] }
    ]) for (const method of ["status", "result"] as const) {
      await expect(f.service[method](changed, created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
    }
    for (const method of ["status", "result"] as const) {
      await inTest(async () => { await expect(f.service[method](principal, created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_CONTEXT_CHANGED" }); });
    }
    f.rotateProduction();
    for (const method of ["status", "result"] as const) await expect(f.service[method](principal, created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_CONTEXT_CHANGED" });
    expect(f.counts().reads).toBe(0);
  });

  test("正式关闭后旧句柄三步均拒绝，测试句柄也不能跨到正式读取", async () => {
    const f = fixture(false, true), production = await f.service.create(principal, request);
    const testJob = await inTest(() => f.service.create(principal, request));
    for (const method of ["status", "result"] as const) await expect(f.service[method](principal, testJob.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_CONTEXT_CHANGED" });
    f.disableProduction();
    await expect(f.service.create(principal, request)).rejects.toMatchObject({ code: "QUERY_JOB_FORBIDDEN" });
    for (const method of ["status", "result"] as const) await expect(f.service[method](principal, production.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_FORBIDDEN" });
    expect((await inTest(() => f.service.status(principal, testJob.data.handle))).data.status).toBe("RUNNING");
    expect(f.counts().reads).toBe(1);
  });

  for (const terminal of ["FAILED", "EXPIRED"] as const) test(`正式${terminal}保留终态且不回退同步或其他环境`, async () => {
    const f = fixture(false, true), created = await f.service.create(principal, request);
    f.state(terminal);
    const result = await f.service.result(principal, created.data.handle);
    expect(result.data).toMatchObject({ status: terminal, phase: "query" });
    expect(result.data).not.toHaveProperty("dashboards");
    expect(f.counts().creates).toBe(1);
    expect(f.legacy.every(call => call.profile === undefined && !/bi\/v1\/(metrics|playback)/.test(call.path))).toBe(true);
  });

  test("同站和PID授权在创建前由原任务服务校验", async () => {
    const f = fixture();
    await inTest(async () => {
      await expect(f.service.create(principal, { ...request, pids: ["FBI"] })).rejects.toMatchObject({ code: "QUERY_JOB_FORBIDDEN" });
      await expect(f.service.create({ ...principal, pidScope: "all" }, { ...request, pids: ["PH", "FBI"] })).rejects.toMatchObject({ code: "QUERY_JOB_INVALID" });
    });
    expect(f.counts().creates).toBe(0); expect(f.legacy).toHaveLength(0);
  });

  test("每次轮询和交付重验原用户、PID范围及来源绑定", async () => {
    const f = fixture(), created = await inTest(() => f.service.create(principal, request));
    await inTest(async () => {
      await expect(f.service.status({ ...principal, subjectId: "another" }, created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
      await expect(f.service.result({ ...principal, pidScope: ["PH", "FBI"] }, created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
    });
    await inTest(async () => { await expect(f.service.result(principal, created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_CONTEXT_CHANGED" }); }, { ...profile, token: "rotated-fixture" });
    expect(f.counts().reads).toBe(0);
    f.state("SUCCEEDED");
    await inTest(async () => {
      await f.service.result(principal, created.data.handle); await settle();
      expect((await f.service.result(principal, created.data.handle)).data.phase).toBe("complete");
    });
  });

  for (const terminal of ["FAILED", "EXPIRED"] as const) test(`${terminal}保留后台状态，不交付缓存结果、不回退同步现代查询`, async () => {
    const f = fixture(), created = await inTest(() => f.service.create(principal, request));
    f.state(terminal);
    const result = await inTest(() => f.service.result(principal, created.data.handle));
    expect(result.data).toMatchObject({ status: terminal, phase: "query" });
    expect(result.data).not.toHaveProperty("dashboards");
    expect(f.legacy.every(call => !/bi\/v1\/(metrics|playback)/.test(call.path))).toBe(true);
  });

  test("成功后实际结果过期仍拒绝缓存看板，局部读取取消不取消共享投影", async () => {
    const f = fixture(), created = await inTest(() => f.service.create(principal, request));
    f.state("SUCCEEDED");
    await inTest(async () => {
      const controller = new AbortController(); controller.abort(new Error("reader_cancelled"));
      await expect(f.service.result(principal, created.data.handle, controller.signal)).rejects.toThrow("reader_cancelled");
      await f.service.result(principal, created.data.handle); await settle();
      expect((await f.service.result(principal, created.data.handle)).data.phase).toBe("complete");
      f.state("EXPIRED");
      expect((await f.service.result(principal, created.data.handle)).data).not.toHaveProperty("dashboards");
    });
  });

  test("重启及内存绑定到期不能凭经营句柄恢复访问", async () => {
    const f = fixture(), created = await inTest(() => f.service.create(principal, request));
    f.advance(3_600_000);
    await inTest(async () => { await expect(f.service.status(principal, created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" }); });
    f.service.close();
    expect(f.service.handles(created.data.handle)).toBe(false);
    expect(f.counts().reads).toBe(0);
  });
});
