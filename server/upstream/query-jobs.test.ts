import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppEnv } from "../config/env";
import { UpstreamClient } from "./client";
import { QueryJobBusinessError, QueryJobsClient, type QueryJobCreateRequest } from "./query-jobs";
import { runWithUpstreamRequestProfile, type UpstreamRequestProfile } from "./request-profile";

const taskId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const env = (): AppEnv => ({
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3000,
  UPSTREAM_API_BASE_URL: "https://primary.example.invalid", UPSTREAM_X_TOKEN: "fixture-primary-token", UPSTREAM_USER_NAME: "fixture-primary-user",
  UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.invalid", UPSTREAM_SECONDARY_X_TOKEN: "fixture-secondary-token", UPSTREAM_SECONDARY_USER_NAME: "fixture-secondary-user",
  UPSTREAM_CREDENTIALS_FILE: join(tmpdir(), `query-job-unused-${randomUUID()}`, "credentials.json"),
  WORKSPACE_FILE: join(tmpdir(), `query-job-unused-${randomUUID()}`, "workspace.json"),
  BI_V2_CORE_OVERVIEW_QUERY_ENABLED: false, BI_LOCAL_DASHBOARD_READING_ENABLED: false,
  BI_PRODUCTION_DASHBOARD_READING_ENABLED: false, BI_TEST_DATA_PREVIEW_ENABLED: true,
  REQUEST_TIMEOUT_MS: 1000, MAX_PLATFORM_CONCURRENCY: 1
});
const body = (pid = "PH"): QueryJobCreateRequest => ({ queries: [{ query: {
  pid, metricCodes: "M016,M020", startDate: "2020-01-01", endDate: "2020-01-02",
  granularity: "day", includeIncomplete: true,
  dimensions: "clientPlatform,userCohort", dimensionFilters: '{"clientPlatform":"ios","userCohort":"old"}'
} }] });
const preview = (partition = "fixture-session-a"): UpstreamRequestProfile => ({
  environment: "test", baseUrl: "https://test.example.invalid", token: "fixture-test-token",
  userName: "fixture-test-user", cachePartition: partition
});
const response = (value: unknown, status = 200) => Response.json(value, { status });
const created = () => ({ code: 200 as const, msg: { taskId, reused: false } });
const status = (state = "RUNNING") => ({ code: 200, msg: { taskId, status: state, completedUnits: 0, totalUnits: 1, attempts: 1 } });
const result = () => ({ code: 200 as const, msg: {
  taskId, status: "SUCCEEDED" as const, completedUnits: 1, totalUnits: 1,
  results: [{ rows: [{ value: 0, denominator: null, dataStatus: "READY", ruleVersion: "fixture-rule", dimensions: { retentionDay: 1 } }],
    generatedAt: "2026-10-20T09:00:00+08:00", watermark: null, sourceCoverage: { state: "PARTIAL" } }]
} });

describe("查询任务专用传输与来源绑定", () => {
  test("两站创建 POST 和状态/结果 GET 始终使用已授权 PID 绑定站点和成对账号", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const client = new QueryJobsClient(new UpstreamClient(env(), async (input, init) => {
      const url = new URL(input.toString()); requests.push({ url, init });
      return response(init?.method === "POST" ? created() : url.pathname.endsWith("/result") ? result() : status());
    }));
    for (const pid of ["PH", "FBI"]) {
      const context = client.contextForPid(pid);
      expect(await client.create(context, body(pid))).toEqual(created());
      await client.status(context, taskId);
      await client.result(context, taskId, 1);
    }
    expect(requests.map(item => item.url.hostname)).toEqual([
      "primary.example.invalid", "primary.example.invalid", "primary.example.invalid",
      "secondary.example.invalid", "secondary.example.invalid", "secondary.example.invalid"
    ]);
    for (const [index, request] of requests.entries()) {
      const headers = new Headers(request.init?.headers);
      const site = index < 3 ? "primary" : "secondary";
      expect(headers.get("name")).toBe(`fixture-${site}-user`);
      expect(headers.get("x-token")).toBe(`fixture-${site}-token`);
      expect(request.url.search).toBe("");
      expect(request.init?.cache).toBe("no-store");
      expect(request.init?.redirect).toBe("error");
      if (index % 3 === 0) {
        expect(request.init?.method).toBe("POST");
        expect(headers.get("content-type")).toBe("application/json");
        expect(JSON.parse(String(request.init?.body))).toEqual(body(index < 3 ? "PH" : "FBI"));
      } else expect(request.init?.method).toBe("GET");
    }
    expect(requests.map(item => item.url.pathname)).toEqual([
      "/api/admin/bi/v1/queryJobs", `/api/admin/bi/v1/queryJobs/${taskId}`, `/api/admin/bi/v1/queryJobs/${taskId}/result`,
      "/api/admin/bi/v1/queryJobs", `/api/admin/bi/v1/queryJobs/${taskId}`, `/api/admin/bi/v1/queryJobs/${taskId}/result`
    ]);
  });

  test("测试会话覆盖所有任务操作，不携带正式配对或跨会话复用绑定", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const client = new QueryJobsClient(new UpstreamClient(env(), async (input, init) => {
      requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
      return response(init?.method === "POST" ? created() : input.toString().endsWith("/result") ? result() : status());
    }));
    const production = client.contextForPid("FBI");
    const context = await runWithUpstreamRequestProfile(preview(), async () => {
      const context = client.contextForPid("FBI");
      await client.create(context, body("FBI")); await client.status(context, taskId); await client.result(context, taskId, 1);
      await expect(client.status(production, taskId)).rejects.toMatchObject({ code: "UPSTREAM_QUERY_JOB_CONTEXT_CHANGED", statusCode: 409 });
      return context;
    });
    await expect(client.status(context, taskId)).rejects.toMatchObject({ code: "UPSTREAM_QUERY_JOB_CONTEXT_CHANGED" });
    await runWithUpstreamRequestProfile(preview("fixture-session-b"), async () => {
      const next = client.contextForPid("FBI");
      expect(next.accountRef).toBe(context.accountRef);
      expect(next.sourceRef).not.toBe(context.sourceRef);
      await expect(client.status(context, taskId)).rejects.toMatchObject({ code: "UPSTREAM_QUERY_JOB_CONTEXT_CHANGED" });
    });
    expect(requests).toHaveLength(3);
    expect(requests.every(item => item.url.startsWith("https://test.example.invalid/api/admin/bi/v1/queryJobs"))).toBe(true);
    expect(requests.map(item => [item.headers.get("name"), item.headers.get("x-token")])).toEqual(Array.from({ length: 3 }, () => ["fixture-test-user", "fixture-test-token"]));
    expect(JSON.stringify(context)).not.toMatch(/fixture-test|fixture-session|example\.invalid/);
  });

  test("共享配额账号引用稳定，Token/用户名/地址变化使旧来源绑定失效", async () => {
    const configuration = env(); let count = 0;
    const client = new QueryJobsClient(new UpstreamClient(configuration, async () => { count++; return response(status()); }));
    const original = client.contextForPid("PH");
    configuration.UPSTREAM_X_TOKEN = "fixture-rotated-token";
    const rotated = client.contextForPid("PH");
    expect(rotated.accountRef).toBe(original.accountRef); expect(rotated.sourceRef).not.toBe(original.sourceRef);
    await expect(client.status(original, taskId)).rejects.toMatchObject({ statusCode: 409 });
    configuration.UPSTREAM_USER_NAME = "fixture-other-user";
    await expect(client.status(rotated, taskId)).rejects.toMatchObject({ statusCode: 409 });
    const renamed = client.contextForPid("PH");
    configuration.UPSTREAM_API_BASE_URL = "https://changed.example.invalid";
    await expect(client.status(renamed, taskId)).rejects.toMatchObject({ statusCode: 409 });
    expect(count).toBe(0);
  });

  test("配额按实际后台账号归并，逻辑站点/环境仍由来源绑定隔离", async () => {
    const configuration = env();
    configuration.UPSTREAM_SECONDARY_USER_NAME = configuration.UPSTREAM_USER_NAME;
    const client = new QueryJobsClient(new UpstreamClient(configuration, async () => response(status())));
    const primary = client.contextForPid("PH");
    const secondary = client.contextForPid("FBI");
    expect(primary.accountRef).not.toBe(secondary.accountRef);
    await runWithUpstreamRequestProfile(preview(), async () => {
      const primaryTest = client.contextForPid("PH");
      const secondaryTest = client.contextForPid("FBI");
      expect(primaryTest.accountRef).toBe(secondaryTest.accountRef);
      expect(primaryTest.sourceRef).not.toBe(secondaryTest.sourceRef);
      expect(primaryTest.siteId).toBe("primary");
      expect(secondaryTest.siteId).toBe("secondary");
      await expect(client.status({ ...primaryTest, routingPid: "FBI" }, taskId)).rejects.toMatchObject({ code: "UPSTREAM_QUERY_JOB_CONTEXT_CHANGED" });
    });
    await runWithUpstreamRequestProfile({ ...preview(), baseUrl: `${configuration.UPSTREAM_API_BASE_URL}/`, userName: configuration.UPSTREAM_USER_NAME!, token: configuration.UPSTREAM_X_TOKEN! }, async () => {
      const sameActualAccount = client.contextForPid("PH");
      expect(sameActualAccount.accountRef).toBe(primary.accountRef);
      expect(sameActualAccount.sourceRef).not.toBe(primary.sourceRef);
      await expect(client.status(primary, taskId)).rejects.toMatchObject({ code: "UPSTREAM_QUERY_JOB_CONTEXT_CHANGED" });
    });
  });

  test("创建拒绝跨站、未知 PID、任意附加字段及不合法查询预算", async () => {
    let count = 0;
    const client = new QueryJobsClient(new UpstreamClient(env(), async () => { count++; return response(created()); }));
    const context = client.contextForPid("PH");
    const invalid: unknown[] = [body("PH,FBI"), body("missing-pid"), { ...body(), environment: "test" },
      { queries: [] }, { queries: Array.from({ length: 65 }, () => body().queries[0]) },
      { queries: [{ query: { ...body().queries[0]!.query, pid: Array(21).fill("PH").join(",") } }] },
      { queries: [{ query: { ...body().queries[0]!.query, dimensionFilters: { sourceType: "natural" } } }] },
      { queries: [{ query: { ...body().queries[0]!.query, endDate: "2020-01-01" } }] },
      { queries: [{ query: { ...body().queries[0]!.query, endDate: "2021-01-02" } }] },
      { queries: [{ unitId: "local-only", query: body().queries[0]!.query }] }
    ];
    for (const request of invalid) await expect(client.create(context, request as QueryJobCreateRequest)).rejects.toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 400 });
    expect(() => client.contextForPid("PH,FBI")).toThrow();
    expect(() => client.contextForPid("missing-pid")).toThrow();
    await expect(client.status(context, "../metrics?pid=FBI")).rejects.toMatchObject({ statusCode: 400 });
    expect(count).toBe(0);
  });

  test("同站 CSV 原样发送，创建/状态/结果不缓存、不合并、不自动重试", async () => {
    let count = 0;
    const client = new QueryJobsClient(new UpstreamClient(env(), async (_input, init) => {
      count++;
      if (init?.method === "POST") return response(created());
      return response(status(count === 3 ? "RUNNING" : "SUCCEEDED"));
    }));
    const context = client.contextForPid("PH");
    await client.create(context, body("PH,PH")); await client.create(context, body("PH,PH"));
    expect((await client.status(context, taskId)).msg.status).toBe("RUNNING");
    expect((await client.status(context, taskId)).msg.status).toBe("SUCCEEDED");
    await Promise.all([client.status(context, taskId), client.status(context, taskId)]);
    expect(count).toBe(6);
  });
});

describe("查询任务响应与错误契约", () => {
  for (const businessCode of [400, 404, 409, 500]) {
    for (const httpStatus of [200, businessCode]) test(`保留 HTTP ${httpStatus} / 业务 ${businessCode}，不压成 422、不重试`, async () => {
      let calls = 0;
      const client = new QueryJobsClient(new UpstreamClient(env(), async () => { calls++; return response({ code: businessCode, err: "fixture-sensitive-upstream-detail" }, httpStatus); }));
      const error = await client.status(client.contextForPid("PH"), taskId).catch(error => error);
      expect(error).toBeInstanceOf(QueryJobBusinessError);
      expect(error).toMatchObject({ code: "UPSTREAM_QUERY_JOB_REJECTED", businessCode, httpStatus, statusCode: businessCode });
      expect(error.message).not.toContain("fixture-sensitive"); expect(calls).toBe(1);
    });
  }

  test("合法旧同步码兼容及其错误分类不受任务传输影响", async () => {
    const client = new UpstreamClient(env(), async input => response(input.toString().includes("legacy-error") ? { code: 400, err: "invalid selection" } : { code: "200", msg: {} }));
    expect(await client.get("/legacy", { pid: "PH" })).toEqual({ code: "200", msg: {} });
    await expect(client.get("/legacy-error", { pid: "PH" })).rejects.toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422 });
    const jobs = new QueryJobsClient(client);
    await expect(jobs.status(jobs.contextForPid("PH"), taskId)).rejects.toMatchObject({ code: "UPSTREAM_INVALID_RESPONSE", statusCode: 502 });
  });

  test("畸形/缺失业务码和未知任务状态不能成为成功", async () => {
    const payloads: unknown[] = [{ msg: created().msg }, { code: { 200: "OK" }, err: "请检查当前用户是否正常" },
      { code: [200] }, { code: null }, { code: true }, { code: "200" }, { code: 200.1 },
      { code: 200, msg: { taskId, status: "UNKNOWN" } }, { code: 200, msg: { taskId: "different", status: "RUNNING" } }];
    for (const payload of payloads) {
      const jobs = new QueryJobsClient(new UpstreamClient(env(), async () => response(payload)));
      await expect(jobs.status(jobs.contextForPid("PH"), taskId)).rejects.toBeInstanceOf(Error);
    }
  });

  test("HTTP 鉴权和既有登录失效业务码保持鉴权失败，不因中文错误文案猜认证", async () => {
    for (const [httpStatus, code] of [[401, 200], [403, 200], [200, 2002]]) {
      const jobs = new QueryJobsClient(new UpstreamClient(env(), async () => response({ code, err: "请检查当前用户是否正常" }, httpStatus)));
      await expect(jobs.status(jobs.contextForPid("PH"), taskId)).rejects.toMatchObject({ code: "UPSTREAM_AUTH_FAILED" });
    }
    const jobs = new QueryJobsClient(new UpstreamClient(env(), async () => response({ code: 500, err: "请检查当前用户是否正常" })));
    await expect(jobs.status(jobs.contextForPid("PH"), taskId)).rejects.toMatchObject({ businessCode: 500 });
  });

  test("成功结果保持 0/null/行状态、原时区生成时间和未知来源元信息", async () => {
    const payload = result();
    const jobs = new QueryJobsClient(new UpstreamClient(env(), async () => response(payload)));
    expect(await jobs.result(jobs.contextForPid("PH"), taskId, 1)).toEqual(payload);
  });

  test("结果数量/行结构/生成时间缺失失败关闭，不补空结果或时间", async () => {
    const invalid = [
      { ...result().msg, results: [] },
      { ...result().msg, results: [{ rows: null, generatedAt: "2026-10-20T01:00:00Z" }] },
      { ...result().msg, results: [{ rows: [] }] },
      { ...result().msg, results: [{ rows: [], generatedAt: "2026-10-20" }] },
      { ...result().msg, completedUnits: 0 },
      { ...result().msg, totalUnits: 2 },
      { ...result().msg, taskId: "different" }
    ];
    for (const msg of invalid) {
      const jobs = new QueryJobsClient(new UpstreamClient(env(), async () => response({ code: 200, msg })));
      await expect(jobs.result(jobs.contextForPid("PH"), taskId, 1)).rejects.toMatchObject({ code: "UPSTREAM_INVALID_RESPONSE" });
    }
  });

  test("结果实际过期/失败保持状态，未提供的进度/期限不生成默认值", async () => {
    for (const state of ["QUEUED", "RUNNING", "FAILED", "EXPIRED"] as const) {
      const payload = { code: 200 as const, msg: { taskId, status: state, errorCode: "FUTURE_FAILURE_KIND" } };
      const jobs = new QueryJobsClient(new UpstreamClient(env(), async () => response(payload)));
      expect(await jobs.result(jobs.contextForPid("PH"), taskId, 1)).toEqual(payload);
    }
  });

  test("结果请求和失败响应不污染下一次读取", async () => {
    let calls = 0;
    const jobs = new QueryJobsClient(new UpstreamClient(env(), async () => response(++calls === 1 ? { code: 500, err: "unavailable" } : result())));
    const context = jobs.contextForPid("PH");
    await expect(jobs.result(context, taskId, 1)).rejects.toMatchObject({ businessCode: 500 });
    expect(await jobs.result(context, taskId, 1)).toEqual(result());
    expect(await jobs.result(context, taskId, 1)).toEqual(result());
    expect(calls).toBe(3);
  });
});

describe("查询任务取消与物理队列", () => {
  test("调用前取消不发送；调用中取消不重试，结束后队列可继续", async () => {
    let calls = 0;
    const jobs = new QueryJobsClient(new UpstreamClient(env(), async (_input, init) => {
      calls++;
      if (calls > 1) return response(status());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }, { maxActiveRequests: 1 }));
    const context = jobs.contextForPid("PH");
    await expect(jobs.status(context, taskId, AbortSignal.abort())).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(calls).toBe(0);
    const controller = new AbortController();
    const pending = jobs.status(context, taskId, controller.signal);
    await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect((await jobs.status(context, taskId)).msg.status).toBe("RUNNING");
    expect(calls).toBe(2);
  });

  test("每个网络动作沿用现有超时，不把排队/执行任务生命周期占作物理槽", async () => {
    let calls = 0;
    const configuration = { ...env(), REQUEST_TIMEOUT_MS: 20 };
    const jobs = new QueryJobsClient(new UpstreamClient(configuration, async (_input, init) => {
      calls++;
      if (calls > 1) return response(status("QUEUED"));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }, { maxActiveRequests: 1 }));
    const context = jobs.contextForPid("PH");
    await expect(jobs.status(context, taskId)).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
    expect((await jobs.status(context, taskId)).msg.status).toBe("QUEUED");
    expect((await jobs.status(context, taskId)).msg.status).toBe("QUEUED");
    expect(calls).toBe(3);
  });
});
