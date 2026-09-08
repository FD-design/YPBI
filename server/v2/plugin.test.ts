import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { IdentityProvider, IdentityResolution } from "../identity/identity-provider";
import { UpstreamError } from "../upstream/client";
import { V2MetricQueryError } from "./metric-query.service";
import { v2BiPlugin, type V2MetricQueryExecutor } from "./plugin";

const openApps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function identityProvider(resolution: IdentityResolution): IdentityProvider {
  return { resolve: async () => resolution };
}

function queryExecutor(onExecute?: V2MetricQueryExecutor["execute"]): V2MetricQueryExecutor {
  return {
    execute: onExecute ?? (async (query) => ({
      success: true,
      data: {
        metric: {
          id: "M016",
          code: "daily_active_user_count",
          name: "日活跃用户数",
          definition: "当天打开并登录产品的去重用户数",
          unit: "人",
          valueType: "integer",
          authority: { document: "全站指标体系.md", version: "v0.23-draft", validationStatus: "pending_validation", statusLabel: "技术称已实现（待验数）" },
          capabilities: { grains: ["day"], platformMode: "single_pid", dimensions: [], filters: [], comparisons: [] }
        },
        scope: { pid: query.pid, platformName: "Pornhub" },
        grain: "day",
        dateRange: query.dateRange,
        seriesStatus: "available",
        points: [{ businessDate: query.dateRange[0], value: 0, state: "available" }],
        unavailableDates: []
      },
      meta: { queryId: "query-test", sourceApiIds: ["test"], fetchedAt: "2026-09-08T00:00:00.000Z", validationStatus: "pending_validation", watermark: null, warnings: [] }
    }))
  };
}

const reader = (pidScope: "all" | readonly string[] = ["PH"]): IdentityResolution => ({
  status: "authenticated",
  principal: { subjectId: "test-user", roles: ["viewer"], permissions: ["bi:read"], pidScope }
});

async function createApp(
  resolution: IdentityResolution,
  executor: V2MetricQueryExecutor = queryExecutor(),
  options: { identityTimeoutMs?: number; provider?: IdentityProvider } = {}
) {
  const app = Fastify();
  openApps.push(app);
  await app.register(v2BiPlugin, {
    prefix: "/api/bi/v2",
    identityProvider: options.provider ?? identityProvider(resolution),
    metricQueryService: executor,
    identityTimeoutMs: options.identityTimeoutMs
  });
  return app;
}

describe("v2BiPlugin identity boundary", () => {
  test("身份来源未配置时失败关闭", async () => {
    const app = await createApp({ status: "unavailable", reason: "尚未配置正式身份来源" });
    const response = await app.inject({ method: "GET", url: "/api/bi/v2/catalog/metrics" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
    expect(response.json().error.message).toBe("正式身份来源当前不可用");
    expect(response.json().error.requestId).toBeString();
  });

  test("未登录与身份来源不可用是不同状态", async () => {
    const app = await createApp({ status: "unauthenticated" });
    const response = await app.inject({ method: "GET", url: "/api/bi/v2/catalog/metrics" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  test("平台目录只返回身份授权范围", async () => {
    const app = await createApp(reader(["PH", "PH", "UNKNOWN"]));
    const response = await app.inject({ method: "GET", url: "/api/bi/v2/catalog/platforms" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toEqual([{ id: "HX-001", pid: "PH", name: "Pornhub", order: 1 }]);
  });

  test("查询其他 PID 时由服务端拒绝", async () => {
    let executed = false;
    const executor = queryExecutor(async () => { executed = true; throw new Error("should not run"); });
    const app = await createApp(reader(["PH"]), executor);
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "TT", dateRange: ["2026-09-01", "2026-09-02"], grain: "day" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PID_ACCESS_DENIED");
    expect(executed).toBe(false);
  });

  test("授权成功响应禁止缓存并保留稳定查询契约", async () => {
    const app = await createApp(reader());
    const catalog = await app.inject({ method: "GET", url: "/api/bi/v2/catalog/metrics" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.headers["cache-control"]).toBe("no-store");

    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-01"], grain: "day" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ success: true, data: { scope: { pid: "PH" }, grain: "day" } });
  });

  test("缺少 BI 只读权限时拒绝且不执行查询", async () => {
    let executed = false;
    const executor = queryExecutor(async () => { executed = true; throw new Error("should not run"); });
    const app = await createApp({ status: "authenticated", principal: { subjectId: "test-user", roles: ["viewer"], permissions: [], pidScope: ["PH"] } }, executor);
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-02"], grain: "day" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("BI_READ_ACCESS_DENIED");
    expect(executed).toBe(false);
  });

  test("身份 Provider 返回畸形 principal 时失败关闭", async () => {
    const malformed = { status: "authenticated", principal: { subjectId: "", roles: [], permissions: ["bi:read"], pidScope: "all" } } as unknown as IdentityResolution;
    const app = await createApp(malformed);
    const response = await app.inject({ method: "GET", url: "/api/bi/v2/catalog/metrics" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
  });

  test("身份 Provider 抛错或超时时使用同一个安全 503 契约", async () => {
    for (const provider of [
      { resolve: async () => { throw new Error("secret identity response"); } },
      { resolve: async () => new Promise<IdentityResolution>(() => {}) }
    ] satisfies IdentityProvider[]) {
      const app = await createApp({ status: "unauthenticated" }, queryExecutor(), { provider, identityTimeoutMs: 5 });
      const response = await app.inject({ method: "GET", url: "/api/bi/v2/catalog/metrics" });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("secret");
    }
  });

  test("未知筛选字段被拒绝，不会静默扩大查询范围", async () => {
    let executed = false;
    const executor = queryExecutor(async () => { executed = true; throw new Error("should not run"); });
    const app = await createApp(reader(), executor);
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-02"], grain: "day", filters: { country: "CN" } }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_V2_METRIC_QUERY");
    expect(executed).toBe(false);
  });

  test("反向或超长日期范围在执行查询前拒绝", async () => {
    let executed = false;
    const executor = queryExecutor(async () => { executed = true; throw new Error("should not run"); });
    const app = await createApp(reader(), executor);
    for (const dateRange of [
      ["2026-09-02", "2026-09-01"],
      ["2025-01-01", "2026-09-01"]
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/bi/v2/queries/metrics",
        payload: { metricId: "M016", pid: "PH", dateRange, grain: "day" }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_V2_METRIC_QUERY");
    }
    expect(executed).toBe(false);
  });

  test("数据源契约冲突稳定映射为 502 且不返回内部详情", async () => {
    const executor = queryExecutor(async () => {
      throw new V2MetricQueryError("V2_METRIC_SOURCE_CONFLICT", "M016 数据源返回内容不满足已确认契约，查询已停止", 502, { reason: "secret_internal_reason" });
    });
    const app = await createApp(reader(), executor);
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-02"], grain: "day" }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("V2_METRIC_SOURCE_CONFLICT");
    expect(response.body).not.toContain("secret_internal_reason");
  });

  test("上游错误不会冒充用户登录或 PID 权限错误，也不回传上游原文", async () => {
    const cases = [
      ["UPSTREAM_AUTH_FAILED", 401, 503, "V2_UPSTREAM_UNAVAILABLE"],
      ["UPSTREAM_IP_RESTRICTED", 403, 503, "V2_UPSTREAM_UNAVAILABLE"],
      ["UPSTREAM_RATE_LIMITED", 429, 503, "V2_UPSTREAM_RATE_LIMITED"],
      ["UPSTREAM_TIMEOUT", 504, 504, "V2_UPSTREAM_TIMEOUT"],
      ["UPSTREAM_INVALID_REQUEST", 422, 502, "V2_UPSTREAM_FAILED"]
    ] as const;
    for (const [code, upstreamStatus, expectedStatus, expectedCode] of cases) {
      const executor = queryExecutor(async () => { throw new UpstreamError(code, "secret upstream response", upstreamStatus); });
      const app = await createApp(reader(), executor);
      const response = await app.inject({
        method: "POST",
        url: "/api/bi/v2/queries/metrics",
        payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-02"], grain: "day" }
      });
      expect(response.statusCode).toBe(expectedStatus);
      expect(response.json().error.code).toBe(expectedCode);
      expect(response.body).not.toContain("secret");
    }
  });
});
