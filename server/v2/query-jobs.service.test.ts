import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Principal } from "../identity/identity-provider";
import { queryJobCreateRequestSchema, queryJobResultSchema, type QueryJobContext, type QueryJobCreateRequest, type QueryJobResult, type QueryJobStatus } from "../upstream/query-jobs";
import { BiQueryJobService } from "./query-jobs.service";
import { getEnabledPlatformByPid } from "../platforms/registry";
import { biQueryJobResultSchema } from "../../contracts/query-jobs";

const principal = (subjectId = "fixture-user", pidScope: Principal["pidScope"] = "all"): Principal => ({ subjectId, roles: ["viewer"], permissions: ["bi:read"], pidScope, securityVersion: "r1" });
const body = (pid = "PH", metrics = "M016"): QueryJobCreateRequest => ({ queries: [{ query: { pid, metricCodes: metrics, startDate: "2020-01-01", endDate: "2020-01-02", granularity: "day", includeIncomplete: true } }] });
const row = (extra: Record<string, unknown> = {}) => ({ metricCode: "M016", businessDate: "2020-01-01", dimensions: { pid: "PH" }, value: 3, numerator: 3, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "fixture-rule", ...extra });
function fixture() {
  let time = 0, sourceVersion = "1", environment: QueryJobContext["environment"] = "production", created = 0, states = 0, resultsRead = 0;
  let taskId = "fixture-task";
  let resultRows: unknown[] = [row()];
  let status: QueryJobStatus["msg"]["status"] = "RUNNING";
  let extra: Record<string, unknown> = {};
  const requests: QueryJobCreateRequest[] = [];
  const port = {
    contextForPid: (routingPid: string): QueryJobContext => ({ routingPid, siteId: getEnabledPlatformByPid(routingPid)!.siteId, environment, accountRef: `${environment}-${getEnabledPlatformByPid(routingPid)!.siteId}`, sourceRef: sourceVersion }),
    create: async (_scope: QueryJobContext, request: QueryJobCreateRequest) => { created++; requests.push(request); return { code: 200 as const, msg: { taskId, reused: created > 1 } }; },
    status: async (_scope: QueryJobContext, id: string): Promise<QueryJobStatus> => { states++; return { code: 200, msg: { taskId: id, status, completedUnits: 0, totalUnits: 1, ...extra } }; },
    result: async (_scope: QueryJobContext, id: string): Promise<QueryJobResult> => { resultsRead++; return { code: 200, msg: { taskId: id, status: "SUCCEEDED", completedUnits: 1, totalUnits: 1, results: [{ rows: resultRows, generatedAt: "2020-01-03T00:00:00+08:00" }], ...extra } } as QueryJobResult; }
  };
  const service = new BiQueryJobService(port, () => Date.parse("2020-03-01T00:00:00Z") + time);
  return { service, port, requests, counts: () => ({ created, states, resultsRead }),
    setTime: (value: number) => { time = value; }, rotate: () => { sourceVersion += "x"; }, testMode: () => { environment = "test"; },
    rows: (value: unknown[]) => { resultRows = value; }, task: (value: string) => { taskId = value; }, state: (value: typeof status) => { status = value; }, extra: (value: Record<string, unknown>) => { extra = value; } };
}

const deployedEvidence = JSON.parse(readFileSync(new URL("./fixtures/query-jobs-http-20261021.json", import.meta.url), "utf8"));
function deployedFixture(indices = [0, 1, 2, 3, 4, 5, 6, 7], extra = false) {
  const requests = queryJobCreateRequestSchema.parse(extra ? deployedEvidence.extraRequest : deployedEvidence.request);
  const response = queryJobResultSchema.parse(extra ? deployedEvidence.extraResult : deployedEvidence.result);
  if (response.msg.status !== "SUCCEEDED") throw new Error("Successful deployed fixture required");
  const succeeded = response.msg;
  const message = { ...succeeded, totalUnits: indices.length, completedUnits: indices.length,
    results: indices.map(index => structuredClone(succeeded.results[index])) };
  const f = fixture(); f.testMode(); f.task(message.taskId);
  const service = new BiQueryJobService({ ...f.port, result: async () => ({ code: 200, msg: message }) }, () => Date.parse(deployedEvidence.capturedAt));
  return { service, message, request: { queries: indices.map(index => ({ query: requests.queries[index].query })) } };
}

describe("BI任务访问绑定与范围", () => {
  test("创建返回独立句柄，不暴露上游账号、来源引用或任务标识", async () => {
    const f = fixture();
    const created = await f.service.create(principal(), body());
    expect(created.data.handle).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(created)).not.toMatch(/fixture-task|accountRef|sourceRef|fixture-user/);
    expect(f.requests[0]).toEqual(body());
    const status = await f.service.status(principal(), created.data.handle);
    expect(status.data.status).toBe("RUNNING");
    expect(JSON.stringify(status)).not.toContain("fixture-task");
  });
  test("未知句柄及其他用户不能获取任务，不调用上游", async () => {
    const f = fixture(), own = await f.service.create(principal(), body());
    await expect(f.service.status(principal("other"), own.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
    await expect(f.service.result(principal(), randomUUID())).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
    expect(f.counts()).toEqual({ created: 1, states: 0, resultsRead: 0 });
  });
  test("共享同一上游任务的两位合法用户拥有互不覆盖的访问绑定", async () => {
    const f = fixture();
    const first = await f.service.create(principal("a"), body());
    const second = await f.service.create(principal("b"), body());
    expect(first.data.handle).not.toBe(second.data.handle);
    expect((await f.service.status(principal("a"), first.data.handle)).success).toBe(true);
    expect((await f.service.status(principal("b"), second.data.handle)).success).toBe(true);
    await expect(f.service.status(principal("b"), first.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
  });
  test("每次重新检查PID授权，角色或安全版本变化使绑定失效", async () => {
    const f = fixture(), created = await f.service.create(principal(), body());
    await expect(f.service.status(principal("fixture-user", ["FBI"]), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
    await expect(f.service.result({ ...principal(), securityVersion: "r2" }, created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
    await expect(f.service.status({ ...principal(), roles: ["maintainer"] }, created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
    expect(f.counts().states).toBe(0);
  });
  test("PID权限收窄即使保留本次PID也使旧绑定失效，相同集合重排不失效", async () => {
    const f = fixture(), owner = principal("fixture-user", ["PH", "FBI"]);
    const created = await f.service.create(owner, body());
    expect((await f.service.status(principal("fixture-user", ["FBI", "PH", "PH"]), created.data.handle)).success).toBe(true);
    await expect(f.service.status(principal("fixture-user", ["PH"]), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
    expect(f.counts().states).toBe(1);
  });
  for (const change of ["rotate", "testMode"] as const) test(`${change}后旧任务不跨来源读取`, async () => {
    const f = fixture(), created = await f.service.create(principal(), body());
    f[change]();
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_CONTEXT_CHANGED" });
    expect(f.counts().resultsRead).toBe(0);
  });
  test("进程重建或绑定过期时失败关闭，不凭编号补建许可", async () => {
    const f = fixture(), created = await f.service.create(principal(), body());
    await expect(new BiQueryJobService(f.port).status(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
    f.setTime(3_600_000);
    await expect(f.service.status(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_NOT_FOUND" });
  });
  test("跨站、越权、未知指标及额外参数在调用上游前拒绝", async () => {
    const f = fixture();
    for (const request of [body("PH,FBI"), body("missing"), body("PH", "M999"), { ...body(), token: "fixture" }, { queries: [{ query: { ...body().queries[0].query, sql: "fixture" } }] }]) {
      await expect(f.service.create(principal(), request)).rejects.toBeInstanceOf(Error);
    }
    await expect(f.service.create(principal("reader", ["PH"]), body("FBI"))).rejects.toMatchObject({ code: "QUERY_JOB_FORBIDDEN" });
    expect(f.counts().created).toBe(0);
  });
  test("合并请求保留单元顺序，只规范单元内部指标和过滤键", async () => {
    const f = fixture(), request = body("PH", "M026,M016,M026");
    request.queries[0].query.dimensions = "userCohort,clientPlatform";
    request.queries[0].query.dimensionFilters = '{"userCohort":"old","clientPlatform":"ios"}';
    request.queries.push(body("PH", "M020").queries[0]);
    await f.service.create(principal(), request);
    expect(f.requests[0].queries.map(unit => unit.query.metricCodes)).toEqual(["M016,M026", "M020"]);
    expect(f.requests[0].queries[0].query.dimensionFilters).toBe('{"clientPlatform":"ios","userCohort":"old"}');
  });
  test("同一用户并发创建相同查询只调用上游一次", async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.service.create(principal(), body()), f.service.create(principal(), body())]);
    expect(first.data.handle).toBe(second.data.handle);
    expect(f.counts().created).toBe(1);
  });
  test("取消一个创建消费者不取消仍在等待的同查询消费者", async () => {
    const f = fixture();
    let release!: () => void, sharedSignal: AbortSignal | undefined;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const service = new BiQueryJobService({ ...f.port, create: async (_source, _request, signal) => {
      sharedSignal = signal; await blocked; signal?.throwIfAborted();
      return { code: 200, msg: { taskId: "fixture-task", reused: false } };
    } });
    const firstController = new AbortController(), secondController = new AbortController();
    const first = service.create(principal(), body(), firstController.signal);
    const second = service.create(principal(), body(), secondController.signal);
    firstController.abort(new Error("fixture_cancel"));
    await expect(first).rejects.toThrow("fixture_cancel");
    expect(sharedSignal?.aborted).toBe(false);
    release();
    expect((await second).success).toBe(true);
  });
  test("全部消费者取消后立即重试不复用旧请求，旧结算不清掉新请求", async () => {
    const f = fixture();
    const releases: (() => void)[] = [], signals: AbortSignal[] = [];
    const service = new BiQueryJobService({ ...f.port, create: async (_source, _request, signal) => {
      signals.push(signal!);
      await new Promise<void>(resolve => { releases.push(resolve); });
      signal?.throwIfAborted();
      return { code: 200, msg: { taskId: "retry-task", reused: false } };
    } });
    const controller = new AbortController();
    const first = service.create(principal(), body(), controller.signal);
    controller.abort(new Error("fixture_cancel"));
    await expect(first).rejects.toThrow("fixture_cancel");
    expect(signals[0].aborted).toBe(true);
    const second = service.create(principal(), body());
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(false);
    releases[0]();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    const third = service.create(principal(), body());
    expect(signals).toHaveLength(2);
    releases[1]();
    const [secondResult, thirdResult] = await Promise.all([second, third]);
    expect(secondResult.success).toBe(true);
    expect(secondResult.data.handle).toBe(thirdResult.data.handle);
  });
  test("共享任务终态同时释放各用户旧绑定的配额，迟到RUNNING不重新占用", async () => {
    const f = fixture();
    const a = await f.service.create(principal("a"), body());
    const b = await f.service.create(principal("b"), body());
    f.state("SUCCEEDED"); await f.service.status(principal("a"), a.data.handle);
    f.state("RUNNING"); await f.service.status(principal("b"), b.data.handle);
    f.task("task-two"); await f.service.create(principal("a"), body("PH", "M026"));
    f.task("task-three"); expect((await f.service.create(principal("b"), body("PH", "M020"))).success).toBe(true);
  });
  test("任意未知分组不能成为数据输出字段", async () => {
    const f = fixture(), request = body(); request.queries[0].query.dimensions = "email";
    await expect(f.service.create(principal(), request)).rejects.toMatchObject({ code: "QUERY_JOB_INVALID" });
    expect(f.counts().created).toBe(0);
  });
  test("共享账号最多两个独立活跃任务，终态释放名额", async () => {
    const f = fixture(), first = await f.service.create(principal(), body());
    f.task("task-two"); await f.service.create(principal("b"), body("PH", "M026"));
    await expect(f.service.create(principal("c"), body("PH", "M020"))).rejects.toMatchObject({ code: "QUERY_JOB_CAPACITY" });
    f.state("SUCCEEDED"); await f.service.status(principal(), first.data.handle);
    f.task("task-three"); expect((await f.service.create(principal("c"), body("PH", "M020"))).success).toBe(true);
  });
  test("月活单独查询，批次粒度和排他日期边界不猜测", async () => {
    const f = fixture();
    const monthly = body("PH", "M018"); monthly.queries[0].query.granularity = "summary"; monthly.queries[0].query.endDate = "2020-02-01";
    expect((await f.service.create(principal(), monthly)).success).toBe(true);
    await expect(f.service.create(principal(), body("PH", "M018,M016"))).rejects.toMatchObject({ code: "QUERY_JOB_INVALID" });
    const invalid = body(); invalid.queries[0].query.granularity = "cohort_day";
    await expect(f.service.create(principal(), invalid)).rejects.toMatchObject({ code: "QUERY_JOB_INVALID" });
    invalid.queries[0].query.endDate = "2020-01-01";
    await expect(f.service.create(principal(), invalid)).rejects.toMatchObject({ code: "QUERY_JOB_INVALID" });
  });
});

describe("2026-10-21部署返回契约", () => {
  test("真实8单元按原顺序交付，行级版本、历史日期、诊断与自然月元数据完整保留", async () => {
    const f = deployedFixture(), created = await f.service.create(principal(), f.request);
    const result = await f.service.result(principal(), created.data.handle);
    expect(result.data).toMatchObject({ status: "SUCCEEDED", results: f.message.results });
    expect(biQueryJobResultSchema.safeParse(result).success).toBe(true);
    if (!("results" in result.data)) throw new Error("Results required");
    expect(f.message.results).toEqual(result.data.results);
    expect(result.data.results[0]).not.toHaveProperty("metricVersion");
    expect(result.data.results[2]).not.toHaveProperty("watermark");
    expect(result.data.results[5].rows[0]).not.toHaveProperty("businessDate");
    expect(result.data.results[3].rows[0]).toMatchObject({ businessDate: "2026-10-20", cutoffDate: "2026-10-20", isComplete: false, dataStatus: "FAILED", value: null });
    expect(result.data.results[4].sourceCoverage?.[0].dataStatus).toBe("READY");
    expect(result.data.results[4].rows[0]).toMatchObject({ dataStatus: "SOURCE_INCOMPLETE", value: null, numerator: 4 });
    expect(result.data.results[7].rows[0].dimensions.retentionDay).toBe("D1");
  });

  test("行顺序与metricCodes不同仍按范围校验，真实READY零比率保留0/3", async () => {
    const f = deployedFixture([1], true), created = await f.service.create(principal(), f.request);
    f.message.results[0].rows.reverse();
    const result = await f.service.result(principal(), created.data.handle);
    if (!("results" in result.data)) throw new Error("Results required");
    expect(f.message.results).toEqual(result.data.results);
    expect(result.data.results[0].rows[0]).toMatchObject({ metricCode: "M081", value: 0, numerator: 0, denominator: 3, dataStatus: "READY" });
  });

  test("空播放rows保留扫描覆盖而不补造分组", async () => {
    const f = deployedFixture([4]), created = await f.service.create(principal(), f.request);
    f.message.results[0].rows = [];
    expect((await f.service.result(principal(), created.data.handle)).data).toMatchObject({ results: [{ rows: [], sourceCoverage: f.message.results[0].sourceCoverage }] });
  });

  for (const change of [
    { pid: "FBI" }, { metricCode: "M016" }, { businessDate: "2026-10-18" },
    { reason: "uncontracted_raw_reason" }, { dataStatus: "UNKNOWN" }, { token: "not-for-browser" }
  ]) test(`覆盖证明拒绝范围或形状漂移 ${JSON.stringify(change)}`, async () => {
    const f = deployedFixture([4]), created = await f.service.create(principal(), f.request);
    const coverage = f.message.results[0].sourceCoverage as Record<string, unknown>[];
    coverage[0] = { ...coverage[0], ...change };
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
  });

  test("覆盖证明拒绝重复与超量条目，不通过空rows绕过范围", async () => {
    const f = deployedFixture([4]), created = await f.service.create(principal(), f.request);
    const unit = f.message.results[0], coverage = unit.sourceCoverage as Record<string, unknown>[];
    unit.rows = []; coverage.push({ ...coverage[0] });
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
    unit.sourceCoverage = Array(3 * 20 * 366 + 1).fill(coverage[0]);
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
  });

  test("来源诊断只输出已知代码，未知代码仅输出unknown", async () => {
    const f = deployedFixture([2]), created = await f.service.create(principal(), f.request);
    const row = f.message.results[0].rows[0] as Record<string, unknown>;
    row.sourceDiagnostics = ["credit_final_failure_mapping_unconfirmed", "private_account_secret"];
    const result = await f.service.result(principal(), created.data.handle);
    expect(result.data).toMatchObject({ results: [{ rows: [{ sourceDiagnostics: ["credit_final_failure_mapping_unconfirmed", "unknown"] }] }] });
    expect(JSON.stringify(result)).not.toContain("private_account_secret");
    row.sourceDiagnostics = [];
    expect((await f.service.result(principal(), created.data.handle)).data).toMatchObject({ results: [{ rows: [{ sourceDiagnostics: [], dataStatus: "SOURCE_INCOMPLETE", value: null }] }] });
  });

  for (const diagnostics of [{ raw: "private" }, ["SQL select private"], ["x".repeat(129)], Array(33).fill("credit_sla_unconfirmed")]) test("拒绝非代码、非数组及越界诊断", async () => {
    const f = deployedFixture([2]), created = await f.service.create(principal(), f.request);
    (f.message.results[0].rows[0] as Record<string, unknown>).sourceDiagnostics = diagnostics;
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
  });

  for (const version of [undefined, "bi-v2"]) test(`每行版本必须匹配已接入bi-v1：${version}`, async () => {
    const f = deployedFixture([0]), created = await f.service.create(principal(), f.request);
    (f.message.results[0].rows[0] as Record<string, unknown>).metricVersion = version;
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
  });

  for (const period of ["D1", "D3", "D7", "D30"]) test(`M115独立${period}窗口，回显不能混用另一窗口`, async () => {
    const f = deployedFixture([7]);
    f.request.queries[0].query.dimensionFilters = JSON.stringify({ retentionDay: period });
    const row = f.message.results[0].rows[0] as Record<string, unknown>;
    row.dimensions = { pid: "PH", retentionDay: period };
    const created = await f.service.create(principal(), f.request);
    expect((await f.service.result(principal(), created.data.handle)).success).toBe(true);
    row.dimensions = { pid: "PH", retentionDay: period === "D1" ? "D3" : "D1" };
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
  });

  for (const [metrics, dimension, value] of [
    ["M115", "retentionDay", 1], ["M020", "retentionDay", "D1"], ["M020,M115", "retentionDay", "D1"],
    ["M016", "videoType", "long_video"], ["M016,M034", "videoType", "long_video"],
    ["M034", "clientPlatform", "android"]
  ] as const) test(`专属维度按指标准入 ${metrics}/${dimension}/${value}`, async () => {
    const f = fixture(), request = body("PH", metrics);
    request.queries[0].query.dimensions = dimension;
    request.queries[0].query.dimensionFilters = JSON.stringify({ [dimension]: value });
    await expect(f.service.create(principal(), request)).rejects.toMatchObject({ code: "QUERY_JOB_INVALID" });
    expect(f.counts().created).toBe(0);
  });

  test("worker新attempt允许completedUnits重置，保持实际进度", async () => {
    const f = fixture(), created = await f.service.create(principal(), body());
    f.extra({ attempts: 1, completedUnits: 1 });
    expect((await f.service.status(principal(), created.data.handle)).data).toMatchObject({ attempts: 1, completedUnits: 1 });
    f.extra({ attempts: 2, completedUnits: 0 });
    expect((await f.service.status(principal(), created.data.handle)).data).toMatchObject({ attempts: 2, completedUnits: 0 });
  });
});

describe("任务结果不改指标状态或取值", () => {
  for (const [status, value] of [["READY", 0], ["PROCESSING", null], ["SOURCE_INCOMPLETE", null], ["NOT_MATURE", null], ["FAILED", null]] as const) test(`${status}与真实值原样保留`, async () => {
    const f = fixture(), created = await f.service.create(principal(), body());
    f.rows([row({ dataStatus: status, value })]);
    const result = await f.service.result(principal(), created.data.handle);
    expect(biQueryJobResultSchema.safeParse(result).success).toBe(true);
    expect("results" in result.data && result.data.results[0].rows[0].value).toBe(value);
    expect("results" in result.data && result.data.results[0].rows[0].dataStatus).toBe(status);
  });
  test("空rows是空结果，诊断分子分母不生成比率", async () => {
    const f = fixture(), created = await f.service.create(principal(), body());
    f.rows([]);
    expect((await f.service.result(principal(), created.data.handle)).data).toMatchObject({ results: [{ rows: [] }] });
    f.rows([row({ dataStatus: "SOURCE_INCOMPLETE", value: null, numerator: 1, denominator: 2 })]);
    expect((await f.service.result(principal(), created.data.handle)).data).toMatchObject({ results: [{ rows: [{ value: null, numerator: 1, denominator: 2 }] }] });
  });
  for (const badRow of [row({ dimensions: { pid: "FBI" } }), row({ pid: "FBI" }), row({ metricCode: "M026" }), row({ businessDate: "2020-01-02" }), row({ businessDate: undefined }), row({ dimensions: { pid: "PH", clientPlatform: "ios" } })]) test(`拒绝错范围：${JSON.stringify(badRow).slice(0,100)}`, async () => {
    const f = fixture(), created = await f.service.create(principal(), body()); f.rows([badRow]);
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
  });
  test("交叉维度同时匹配，不能用总体或另一个人群补入", async () => {
    const f = fixture(), request = body();
    request.queries[0].query.dimensions = "clientPlatform,userCohort";
    request.queries[0].query.dimensionFilters = '{"clientPlatform":"android","userCohort":"old"}';
    const created = await f.service.create(principal(), request);
    f.rows([row({ dimensions: { pid: "PH", clientPlatform: "android", userCohort: "old" } })]);
    expect((await f.service.result(principal(), created.data.handle)).success).toBe(true);
    f.rows([row({ dimensions: { pid: "PH", clientPlatform: "android", userCohort: "new" } })]);
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
  });
  test("重复行、缺单元、进度越界均拒绝", async () => {
    const f = fixture(), created = await f.service.create(principal(), body()); f.rows([row(), row()]);
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
    f.extra({ results: [] });
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
    f.extra({ completedUnits: 2 });
    await expect(f.service.status(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
  });
  test("结果再次过期不沿用先前成功，未知错误只返回固定分类", async () => {
    const f = fixture(), created = await f.service.create(principal(), body());
    f.state("SUCCEEDED"); expect((await f.service.status(principal(), created.data.handle)).data.status).toBe("SUCCEEDED");
    f.extra({ status: "EXPIRED", errorCode: "sensitive raw error" });
    const result = await f.service.result(principal(), created.data.handle);
    expect(result.data.status).toBe("EXPIRED"); expect(result.data.errorCode).toBe("UNKNOWN"); expect(result.data).not.toHaveProperty("results");
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });
  test("额外原始payload不输出，未提供生成元信息不编造", async () => {
    const f = fixture(), created = await f.service.create(principal(), body());
    f.rows([row({ token: "not-for-browser", payload: { authorization: "not-for-browser" } })]);
    const result = await f.service.result(principal(), created.data.handle);
    expect(JSON.stringify(result)).not.toContain("not-for-browser");
    expect("results" in result.data && result.data.results[0]).not.toHaveProperty("watermark");
    f.rows([row({ sourceDiagnostics: { raw: "not-for-browser" } })]);
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
  });
  test("请求取消或来源在飞行中变化，不交付旧上下文结果", async () => {
    const f = fixture();
    f.port.create = async () => { f.rotate(); return { code: 200, msg: { taskId: "fixture-task", reused: false } }; };
    await expect(f.service.create(principal(), body())).rejects.toMatchObject({ code: "QUERY_JOB_CONTEXT_CHANGED" });
    const controller = new AbortController(); controller.abort();
    await expect(f.service.create(principal(), body(), controller.signal)).rejects.toBeInstanceOf(Error);
  });
  test("非留存专属字段不能绕过重复键，M115必须有观察周期", async () => {
    const f = fixture(), created = await f.service.create(principal(), body());
    f.rows([row({ retentionDay: 1 }), row({ retentionDay: 3 })]);
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
    await expect(f.service.create(principal(), body("PH", "M115"))).rejects.toMatchObject({ code: "QUERY_JOB_INVALID" });
  });
  test("月活元数据与创建时自然月一致，不用isComplete替代READY", async () => {
    const f = fixture(), monthly = body("PH", "M018");
    monthly.queries[0].query.granularity = "summary"; monthly.queries[0].query.endDate = "2020-02-01";
    const created = await f.service.create(principal(), monthly);
    f.rows([row({ metricCode: "M018", businessDate: undefined, month: "2020-01", cutoffDate: "2020-01-31", isComplete: true, dataStatus: "SOURCE_INCOMPLETE", value: null })]);
    expect((await f.service.result(principal(), created.data.handle)).data).toMatchObject({ results: [{ rows: [{ value: null, dataStatus: "SOURCE_INCOMPLETE", isComplete: true }] }] });
    f.rows([row({ metricCode: "M018", businessDate: undefined, month: "1999-01", cutoffDate: "1999-01-31", isComplete: true })]);
    await expect(f.service.result(principal(), created.data.handle)).rejects.toMatchObject({ code: "QUERY_JOB_RESULT_INVALID" });
  });
});
