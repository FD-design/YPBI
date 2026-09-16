import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { v2MetricDefinitionsSuccessSchema, v2MetricQuerySuccessSchema } from "../../contracts/bi-v2";
import type { IdentityProvider, IdentityResolution } from "../identity/identity-provider";
import { UpstreamError } from "../upstream/client";
import { V2MetricQueryError } from "./metric-query.service";
import { getV2MetricDefinition as getCurrentMetricDefinition } from "./metric-definitions";
import { v2BiPlugin, type V2MetricQueryExecutor } from "./plugin";

const openApps: FastifyInstance[] = [];
// Query-boundary tests use an isolated v0.23 candidate matching their executor.
// The actual v0.24 catalog remains stale; its gate is tested separately below.
function getV2MetricDefinition(id: string) {
  const current = getCurrentMetricDefinition(id);
  if (!current || id !== "M016") return current;
  return { ...current, authority: { ...current.authority, version: "v0.23-draft" },
    ypbiMapping: { ...current.ypbiMapping, status: "configured" as const },
    analysis: { status: "unavailable" as const, reasonCodes: ["validation_not_passed" as const] } };
}
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
      meta: { queryId: "query-test", sourceApiIds: ["test"], fetchedAt: "2026-09-08T00:00:00.000Z", mappingVersion: "m016-pday-sum-v1", validationStatus: "pending_validation", watermark: null, warnings: [] }
    }))
  };
}

const reader = (pidScope: "all" | readonly string[] = ["PH"]): IdentityResolution => ({
  status: "authenticated",
  principal: { subjectId: "test-user", roles: ["viewer"], permissions: ["bi:read"], pidScope }
});

const maintainer = (pidScope: "all" | readonly string[] = ["PH"]): IdentityResolution => ({
  status: "authenticated",
  principal: {
    subjectId: "test-maintainer",
    roles: ["maintainer"],
    permissions: ["bi:read", "bi:data-source-maintenance:enter"],
    pidScope
  }
});

async function createApp(
  resolution: IdentityResolution,
  executor: V2MetricQueryExecutor = queryExecutor(),
  options: {
    identityTimeoutMs?: number;
    provider?: IdentityProvider;
    metricDefinitionResolver?: (metricId: string) => NonNullable<ReturnType<typeof getV2MetricDefinition>> | undefined;
  } = {}
) {
  const app = Fastify();
  openApps.push(app);
  await app.register(v2BiPlugin, {
    prefix: "/api/bi/v2",
    identityProvider: options.provider ?? identityProvider(resolution),
    metricQueryService: executor,
    identityTimeoutMs: options.identityTimeoutMs,
    metricDefinitionResolver: options.metricDefinitionResolver ?? getV2MetricDefinition
  });
  return app;
}

describe("v2BiPlugin identity boundary", () => {
  for (const role of ["reader", "analyst"]) {
    test(`${role} 的 Token 维护能力不授予待验数指标执行权限`, async () => {
      let executed = false;
      const app = await createApp({ status: "authenticated", principal: {
        subjectId: `maintenance-${role}`, roles: [role], pidScope: "all",
        permissions: ["bi:read", "bi:data-source-maintenance:enter"]
      } }, queryExecutor(async () => { executed = true; throw Error("must not execute"); }));
      const response = await app.inject({ method: "POST", url: "/api/bi/v2/queries/metrics",
        payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-01"], grain: "day" } });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("METRIC_NOT_READY");
      expect(executed).toBe(false);
    });
  }

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

  test("新指标定义目录与旧 M016 目录并行且不可缓存", async () => {
    const app = await createApp(reader("all"));
    const definitions = await app.inject({ method: "GET", url: "/api/bi/v2/catalog/metric-definitions" });
    const legacy = await app.inject({ method: "GET", url: "/api/bi/v2/catalog/metrics" });

    expect(definitions.statusCode).toBe(200);
    expect(definitions.headers["cache-control"]).toBe("no-store");
    const parsed = v2MetricDefinitionsSuccessSchema.parse(definitions.json());
    expect(parsed.data.snapshot.counts).toEqual({ standard: 98, periodDerived: 3, total: 101 });
    expect(parsed.data.categories).toHaveLength(5);
    expect(parsed.data.items.find((item) => item.id === "M016")).toMatchObject({
      ypbiMapping: { status: "stale" },
      validation: { status: "not_started" },
      analysis: { status: "unavailable", reasonCodes: ["mapping_stale"] }
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().data.items).toHaveLength(0);
  });

  test("当前权威版本升级后，维护者也不能执行过期的真实映射", async () => {
    let executed=false;
    const app=await createApp(maintainer(),queryExecutor(async()=>{executed=true;throw Error('must not execute');}),{metricDefinitionResolver:getCurrentMetricDefinition});
    const response=await app.inject({method:'POST',url:'/api/bi/v2/queries/metrics',payload:{metricId:'M016',pid:'PH',dateRange:['2026-09-01','2026-09-01'],grain:'day'}});
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('METRIC_NOT_READY');
    expect(executed).toBe(false);
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

  test("全部 PID 权限也不能绕过当前平台目录查询未知 PID", async () => {
    let executed = false;
    const executor = queryExecutor(async () => { executed = true; throw new Error("should not run"); });
    const app = await createApp(reader("all"), executor);
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "UNKNOWN", dateRange: ["2026-09-01", "2026-09-02"], grain: "day" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PID_ACCESS_DENIED");
    expect(executed).toBe(false);
  });

  test("授权成功响应禁止缓存并保留稳定查询契约", async () => {
    const app = await createApp(maintainer());
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

  test("未验数指标只允许维护者调用技术查询，普通阅读者不能绕过正式入口", async () => {
    let executed = false;
    const executor = queryExecutor(async () => { executed = true; throw new Error("should not run"); });
    const app = await createApp(reader(), executor);
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-01"], grain: "day" }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("METRIC_NOT_READY");
    expect(executed).toBe(false);
  });

  test("failed 或 expired 验数状态对维护者也返回 422 且绝不执行上游", async () => {
    const current = getV2MetricDefinition("M016");
    expect(current).toBeDefined();
    for (const status of ["failed", "expired"] as const) {
      let executeCount = 0;
      const executor = queryExecutor(async () => {
        executeCount += 1;
        throw new Error("should not run");
      });
      const app = await createApp(maintainer(), executor, {
        metricDefinitionResolver: () => ({
          ...current!,
          validation: {
            status,
            mappingVersion: "m016-pday-sum-v1",
            authorityVersion: "v0.23-draft",
            validatedAt: "2026-09-08T15:30:00+08:00",
            evidenceId: `server/v2/validation/evidence/M016/test-${status}.evidence.json`
          },
          analysis: { status: "unavailable", reasonCodes: ["validation_not_passed"] }
        })
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/bi/v2/queries/metrics",
        payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-01"], grain: "day" }
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("METRIC_NOT_READY");
      expect(executeCount).toBe(0);
    }
  });

  test("passed 验数状态由普通阅读者走正式查询", async () => {
    const current = getV2MetricDefinition("M016");
    expect(current).toBeDefined();
    let executeCount = 0;
    const executor = queryExecutor(async (query) => {
      executeCount += 1;
      const result = await queryExecutor().execute(query);
      return {
        ...result,
        data: {
          ...result.data,
          metric: {
            ...result.data.metric,
            authority: {
              ...result.data.metric.authority,
              validationStatus: "passed",
              statusLabel: "真实验数已通过"
            }
          }
        },
        meta: {
          ...result.meta,
          sourceApiIds: ["/api/admin/statistics/pDaySum"],
          validationStatus: "passed",
          watermark: {
            type: "complete_through_business_date",
            completeThrough: "2026-09-01",
            timeZone: "Asia/Shanghai",
            pid: query.pid,
            sourceApiId: "/api/admin/statistics/pDaySum",
            sourceKind: "upstream_explicit",
            observedAt: "2026-09-02T00:10:00+08:00"
          }
        }
      };
    });
    const app = await createApp(reader(), executor, {
      metricDefinitionResolver: () => ({
        ...current!,
        validation: {
          status: "passed",
          mappingVersion: "m016-pday-sum-v1",
          authorityVersion: "v0.23-draft",
          validatedAt: "2026-09-08T15:30:00+08:00",
          evidenceId: "server/v2/validation/evidence/M016/test-passed.evidence.json"
        },
        analysis: { status: "available", reasonCodes: [] }
      })
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-01"], grain: "day" }
    });
    expect(response.statusCode).toBe(200);
    expect(v2MetricQuerySuccessSchema.safeParse(response.json()).success).toBe(true);
    expect(executeCount).toBe(1);
  });

  test("停用映射对维护者也失败关闭且不执行上游", async () => {
    const current = getV2MetricDefinition("M016");
    expect(current).toBeDefined();
    let executed = false;
    const executor = queryExecutor(async () => { executed = true; throw new Error("should not run"); });
    const app = await createApp(maintainer(), executor, {
      metricDefinitionResolver: () => ({
        ...current!,
        ypbiMapping: { ...current!.ypbiMapping, status: "disabled" },
        analysis: { status: "unavailable", reasonCodes: ["mapping_disabled"] }
      })
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-01"], grain: "day" }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("METRIC_NOT_READY");
    expect(executed).toBe(false);
  });

  test("映射权威版本不匹配时维护者也不能执行旧映射", async () => {
    const current = getV2MetricDefinition("M016");
    expect(current).toBeDefined();
    let executed = false;
    const executor = queryExecutor(async () => { executed = true; throw new Error("should not run"); });
    const app = await createApp(maintainer(), executor, {
      metricDefinitionResolver: () => ({
        ...current!,
        ypbiMapping: { ...current!.ypbiMapping, authorityVersion: "v0.22-stale-test" },
        analysis: { status: "unavailable", reasonCodes: ["mapping_stale"] }
      })
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-01"], grain: "day" }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("METRIC_NOT_READY");
    expect(executed).toBe(false);
  });

  test("登记来源与当前查询 Adapter 不一致时维护者也不能执行上游", async () => {
    const current = getV2MetricDefinition("M016");
    expect(current).toBeDefined();
    let executed = false;
    const executor = queryExecutor(async () => { executed = true; throw new Error("should not run"); });
    const app = await createApp(maintainer(), executor, {
      metricDefinitionResolver: () => ({
        ...current!,
        ypbiMapping: {
          ...current!.ypbiMapping,
          sourceApiIds: ["/api/admin/statistics/not-the-m016-adapter"]
        }
      })
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-01"], grain: "day" }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("METRIC_NOT_READY");
    expect(executed).toBe(false);
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
    const app = await createApp(maintainer(), executor);
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-02"], grain: "day" }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("V2_METRIC_SOURCE_CONFLICT");
    expect(response.body).not.toContain("secret_internal_reason");
  });

  test("查询执行器返回 passed 加空水位时由完整出站契约安全映射为 502", async () => {
    const executor = queryExecutor(async (query) => {
      const result = await queryExecutor().execute(query);
      return {
        ...result,
        data: {
          ...result.data,
          metric: {
            ...result.data.metric,
            authority: {
              ...result.data.metric.authority,
              validationStatus: "passed",
              statusLabel: "真实验数已通过"
            }
          }
        },
        meta: {
          ...result.meta,
          queryId: "secret-internal-query-id",
          validationStatus: "passed",
          watermark: null
        }
      } as unknown as Awaited<ReturnType<V2MetricQueryExecutor["execute"]>>;
    });
    const app = await createApp(maintainer(), executor);
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-01"], grain: "day" }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("V2_METRIC_SOURCE_CONFLICT");
    expect(response.json().error.message).toBe("指标查询结果不满足公共契约，查询已停止");
    expect(response.body).not.toContain("secret-internal-query-id");
  });

  test("查询执行器返回与逐日状态不一致的成功体时由出站边界安全映射为 502", async () => {
    const executor = queryExecutor(async (query) => {
      const result = await queryExecutor().execute(query);
      return {
        ...result,
        data: {
          ...result.data,
          seriesStatus: "available",
          points: [],
          unavailableDates: []
        },
        meta: { ...result.meta, queryId: "secret-inconsistent-query-id" }
      };
    });
    const app = await createApp(maintainer(), executor);
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-01"], grain: "day" }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("V2_METRIC_SOURCE_CONFLICT");
    expect(response.body).not.toContain("secret-inconsistent-query-id");
  });

  test("查询执行器返回 Schema 合法但与原请求范围不一致的成功体时安全映射为 502", async () => {
    const executor = queryExecutor(async (query) => {
      const result = await queryExecutor().execute(query);
      return {
        ...result,
        data: {
          ...result.data,
          scope: { pid: "TT", platformName: "TikTok" }
        },
        meta: { ...result.meta, queryId: "secret-mismatched-query-id" }
      };
    });
    const app = await createApp(maintainer(), executor);
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      payload: { metricId: "M016", pid: "PH", dateRange: ["2026-09-01", "2026-09-01"], grain: "day" }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("V2_METRIC_SOURCE_CONFLICT");
    expect(response.json().error.message).toBe("指标查询结果与请求范围不一致，查询已停止");
    expect(response.body).not.toContain("secret-mismatched-query-id");
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
      const app = await createApp(maintainer(), executor);
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
