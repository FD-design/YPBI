import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  CORE_OVERVIEW_CARD_SPECS,
  type CoreOverviewMetricId,
  type CoreOverviewQuery,
  type CoreOverviewQuerySuccess
} from "../../contracts/core-overview";
import type { MetricDefinitionItem } from "../../contracts/bi-v2";
import type { IdentityProvider, IdentityResolution } from "../identity/identity-provider";
import { CoreOverviewPeriodResolutionError } from "./core-overview/core-overview-period";
import { getV2MetricDefinition } from "./metric-definitions";
import { v2BiPlugin, type V2CoreOverviewQueryExecutor, type V2MetricQueryExecutor } from "./plugin";

const openApps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

const unusedMetricExecutor: V2MetricQueryExecutor = {
  execute: async () => { throw new Error("single metric executor must not run"); }
};

function identityProvider(resolution: IdentityResolution): IdentityProvider {
  return { resolve: async () => resolution };
}

const reader = (pidScope: "all" | readonly string[] = "all"): IdentityResolution => ({
  status: "authenticated",
  principal: {
    subjectId: "core-overview-reader",
    roles: ["reader"],
    permissions: ["bi:read"],
    pidScope
  }
});

function unavailableCard(metricId: CoreOverviewMetricId) {
  const spec = CORE_OVERVIEW_CARD_SPECS.find((candidate) => candidate.metricId === metricId)!;
  return {
    ...spec,
    result: {
      status: "not_ready" as const,
      reasonCode: "validation_not_passed",
      message: "当前映射、验数或可信水位尚未全部就绪",
      retryable: false
    }
  };
}

function admittedM016Resolver(metricId: string): MetricDefinitionItem | undefined {
  if (metricId !== "M016") return undefined;
  const current = getV2MetricDefinition(metricId);
  if (!current) throw new Error("测试目录缺少 M016");
  const admitted = structuredClone(current);
  admitted.authority.version = "v0.23-draft";
  admitted.ypbiMapping.status = "configured";
  admitted.validation = {
    status: "passed",
    mappingVersion: admitted.ypbiMapping.mappingVersion,
    authorityVersion: admitted.authority.version,
    validatedAt: "2026-09-08T23:50:00+08:00",
    evidenceId: "service:core-overview-plugin-test"
  };
  admitted.analysis = { status: "available", reasonCodes: [] };
  return admitted;
}

function resolvedPeriod(query: CoreOverviewQuery): CoreOverviewQuerySuccess["data"]["period"] {
  if (query.period.mode === "explicit") {
    return {
      mode: "explicit",
      grain: "day",
      timeZone: "Asia/Shanghai",
      currentRange: query.period.currentRange,
      comparisonRange: query.period.comparisonRange,
      commonCompleteThrough: query.period.currentRange[1]
    };
  }
  return {
    mode: "latest_complete",
    grain: "day",
    timeZone: "Asia/Shanghai",
    currentRange: ["2026-09-01", "2026-09-07"],
    comparisonRange: query.period.comparison === "previous_equal" ? ["2026-08-25", "2026-08-31"] : null,
    commonCompleteThrough: "2026-09-07"
  };
}

function fakeAllNotReadySuccessResponse(query: CoreOverviewQuery): CoreOverviewQuerySuccess {
  const scopes = query.scope.kind === "official_overall"
    ? [{ kind: "official_overall" as const }]
    : query.scope.pids.map((pid) => ({ kind: "pid" as const, pid }));
  return {
    success: true,
    data: {
      dashboard: { id: "core-overview", contractVersion: "core-overview/v1" },
      requestedScope: query.scope,
      requestedMetricIds: [...query.metricIds],
      period: resolvedPeriod(query),
      scopeResults: scopes.map((scope) => ({ scope, cards: query.metricIds.map(unavailableCard) }))
    },
    meta: {
      queryId: "core-overview-test-query",
      fetchedAt: "2026-09-08T00:05:00+08:00",
      partial: true,
      warnings: ["测试中所有指标均保持未准入"]
    }
  };
}

function trustedPartialResponse(query: CoreOverviewQuery): CoreOverviewQuerySuccess {
  const response = fakeAllNotReadySuccessResponse(query);
  const completeThrough = response.data.period.commonCompleteThrough;
  response.data.scopeResults.forEach((scopeResult) => {
    const cardIndex = response.data.requestedMetricIds.indexOf("M016");
    if (cardIndex < 0) throw new Error("可信测试响应必须请求 M016");
    scopeResult.cards[cardIndex] = {
      ...CORE_OVERVIEW_CARD_SPECS[0],
      result: {
        status: "no_records",
        message: "可信水位内没有业务记录",
        retryable: false,
        provenance: {
          authorityVersion: "v0.23-draft",
          mappingVersion: "m016-pday-sum-v1",
          validationStatus: "passed",
          sourceIds: ["/api/admin/statistics/pDaySum"],
          fetchedAt: "2026-09-09T00:05:00+08:00",
          watermark: {
            type: "complete_through_business_date",
            completeThrough,
            timeZone: "Asia/Shanghai",
            scope: scopeResult.scope,
            evidence: [{
              sourceId: "/api/admin/statistics/pDaySum",
              sourceKind: "upstream_explicit",
              observedAt: new Date(`${completeThrough}T16:01:00Z`).toISOString()
            }]
          }
        }
      }
    };
  });
  response.meta.fetchedAt = "2026-09-09T00:05:00+08:00";
  response.meta.warnings = ["测试响应由可信无记录卡片提供共同水位"];
  return response;
}

async function createApp(options: {
  resolution?: IdentityResolution;
  enabled?: boolean;
  executor?: V2CoreOverviewQueryExecutor;
  metricDefinitionResolver?: (metricId: string) => MetricDefinitionItem | undefined;
}) {
  const app = Fastify();
  openApps.push(app);
  await app.register(v2BiPlugin, {
    prefix: "/api/bi/v2",
    identityProvider: identityProvider(options.resolution ?? reader()),
    metricQueryService: unusedMetricExecutor,
    coreOverviewQueryEnabled: options.enabled,
    coreOverviewQueryService: options.executor,
    metricDefinitionResolver: options.metricDefinitionResolver
  });
  return app;
}

describe("核心经营总览批量查询路由", () => {
  test("默认关闭且绝不调用执行器", async () => {
    let executed = false;
    const app = await createApp({
      executor: { execute: async () => { executed = true; throw new Error("must not run"); } }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/dashboards/core-overview",
      payload: { scope: { kind: "official_overall" } }
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().error.code).toBe("CORE_OVERVIEW_QUERY_DISABLED");
    expect(executed).toBe(false);
  });

  test("即使功能关闭也先执行身份边界", async () => {
    const app = await createApp({ resolution: { status: "unauthenticated" } });
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/dashboards/core-overview",
      payload: { scope: { kind: "official_overall" } }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  test("开关打开但未注入执行器时失败关闭", async () => {
    const app = await createApp({ enabled: true });
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/dashboards/core-overview",
      payload: { scope: { kind: "official_overall" } }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("CORE_OVERVIEW_QUERY_UNAVAILABLE");
  });

  test("受限 PID 身份不能请求官方整体、未知 PID 或范围外 PID", async () => {
    let executeCount = 0;
    const executor: V2CoreOverviewQueryExecutor = {
      execute: async () => { executeCount += 1; throw new Error("must not run"); }
    };
    const app = await createApp({ enabled: true, resolution: reader(["PH"]), executor });
    for (const scope of [
      { kind: "official_overall" },
      { kind: "pids", pids: ["PH", "TT"] },
      { kind: "pids", pids: ["UNKNOWN"] }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/bi/v2/queries/dashboards/core-overview",
        payload: { scope }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("PID_ACCESS_DENIED");
    }
    expect(executeCount).toBe(0);
  });

  test("重复 PID、重复指标和未知筛选在执行前拒绝", async () => {
    let executeCount = 0;
    const executor: V2CoreOverviewQueryExecutor = {
      execute: async () => { executeCount += 1; throw new Error("must not run"); }
    };
    const app = await createApp({ enabled: true, executor });
    for (const payload of [
      { scope: { kind: "pids", pids: ["PH", "PH"] } },
      { scope: { kind: "pids", pids: ["PH"] }, metricIds: ["M016", "M016"] },
      { scope: { kind: "official_overall" }, filters: { channel: "x" } }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/bi/v2/queries/dashboards/core-overview",
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_CORE_OVERVIEW_QUERY");
    }
    expect(executeCount).toBe(0);
  });

  test("多 PID 按服务端目录顺序独立返回，不制造跨 PID 合计", async () => {
    let observedQuery: CoreOverviewQuery | undefined;
    const executor: V2CoreOverviewQueryExecutor = {
      execute: async (query) => {
        observedQuery = query;
        return trustedPartialResponse(query);
      }
    };
    const app = await createApp({ enabled: true, executor, metricDefinitionResolver: admittedM016Resolver });
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/dashboards/core-overview",
      payload: { scope: { kind: "pids", pids: ["TT", "PH"] }, metricIds: ["M020", "M016"] }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(observedQuery?.scope).toEqual({ kind: "pids", pids: ["PH", "TT"] });
    expect(observedQuery?.metricIds).toEqual(["M016", "M020"]);
    expect(response.json().data.scopeResults.map((item: { scope: unknown }) => item.scope)).toEqual([
      { kind: "pid", pid: "PH" },
      { kind: "pid", pid: "TT" }
    ]);
  });

  test("单卡失败只在同一响应仍有可信水位卡片时返回 200", async () => {
    const executor: V2CoreOverviewQueryExecutor = {
      execute: async (query) => {
        const response = trustedPartialResponse(query);
        response.data.scopeResults[0].cards[1] = {
          ...CORE_OVERVIEW_CARD_SPECS[1],
          result: {
            status: "failed",
            errorCode: "UPSTREAM_TIMEOUT",
            message: "本卡查询超时，请单独重试",
            retryable: true
          }
        };
        return response;
      }
    };
    const app = await createApp({ enabled: true, executor, metricDefinitionResolver: admittedM016Resolver });
    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/dashboards/core-overview",
      payload: { scope: { kind: "pids", pids: ["PH"] }, metricIds: ["M016", "M008"] }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta.partial).toBe(true);
    expect(response.json().data.scopeResults[0].cards.map((card: { result: { status: string } }) => card.result.status)).toEqual([
      "no_records",
      "failed"
    ]);
  });

  test("正确执行器的零可信水位错误映射为 422，错误返回假成功仍是 502", async () => {
    const unavailableExecutor: V2CoreOverviewQueryExecutor = {
      execute: async () => {
        throw new CoreOverviewPeriodResolutionError(
          "NO_TRUSTED_WATERMARK",
          "内部执行器没有找到可信水位"
        );
      }
    };
    const unavailableApp = await createApp({ enabled: true, executor: unavailableExecutor });
    const unavailableResponse = await unavailableApp.inject({
      method: "POST",
      url: "/api/bi/v2/queries/dashboards/core-overview",
      payload: { scope: { kind: "official_overall" } }
    });
    expect(unavailableResponse.statusCode).toBe(422);
    expect(unavailableResponse.json().error.code).toBe("METRIC_NOT_READY");
    expect(unavailableResponse.body).not.toContain("NO_TRUSTED_WATERMARK");

    const fakeSuccessExecutor: V2CoreOverviewQueryExecutor = {
      execute: async (query) => fakeAllNotReadySuccessResponse(query)
    };
    const fakeSuccessApp = await createApp({ enabled: true, executor: fakeSuccessExecutor });
    const fakeSuccessResponse = await fakeSuccessApp.inject({
      method: "POST",
      url: "/api/bi/v2/queries/dashboards/core-overview",
      payload: { scope: { kind: "official_overall" }, metricIds: ["M016"] }
    });
    expect(fakeSuccessResponse.statusCode).toBe(502);
    expect(fakeSuccessResponse.json().error.code).toBe("CORE_OVERVIEW_SOURCE_CONFLICT");
  });

  test("畸形、错范围或冒充已准入的响应安全映射为 502", async () => {
    const cases: V2CoreOverviewQueryExecutor[] = [
      {
        execute: async (query) => {
          const response = fakeAllNotReadySuccessResponse(query);
          response.data.scopeResults[0].cards.splice(0, 1);
          return response;
        }
      },
      {
        execute: async (query) => {
          const response = fakeAllNotReadySuccessResponse(query);
          response.data.requestedScope = { kind: "pids", pids: ["PH"] };
          response.data.scopeResults = [{
            scope: { kind: "pid", pid: "PH" },
            cards: query.metricIds.map(unavailableCard)
          }];
          return response;
        }
      },
      {
        execute: async (query) => {
          const response = fakeAllNotReadySuccessResponse(query);
          response.data.scopeResults[0].cards[0] = {
            ...CORE_OVERVIEW_CARD_SPECS[0],
            result: {
              status: "available",
              completeness: "complete",
              current: {
                actualRange: ["2026-09-01", "2026-09-01"],
                includedBusinessDates: ["2026-09-01"],
                value: { raw: 0, unit: "人", currencyCode: null }
              },
              comparison: null,
              trend: {
                current: [{ offset: 0, state: "available", businessDate: "2026-09-01", value: 0 }],
                comparison: null
              },
              provenance: {
                authorityVersion: "v0.23-draft",
                mappingVersion: "m016-pday-sum-v1",
                validationStatus: "passed",
                sourceIds: ["/api/admin/statistics/pDaySum"],
                fetchedAt: "2026-09-02T00:05:00+08:00",
                watermark: {
                  type: "complete_through_business_date",
                  completeThrough: "2026-09-01",
                  timeZone: "Asia/Shanghai",
                  scope: { kind: "official_overall" },
                  evidence: [{
                    sourceId: "/api/admin/statistics/pDaySum",
                    sourceKind: "upstream_explicit",
                    observedAt: "2026-09-02T00:01:00+08:00"
                  }]
                }
              }
            }
          };
          response.data.period = {
            mode: "explicit",
            grain: "day",
            timeZone: "Asia/Shanghai",
            currentRange: ["2026-09-01", "2026-09-01"],
            comparisonRange: null,
            commonCompleteThrough: "2026-09-01"
          };
          response.meta.fetchedAt = "2026-09-02T00:05:00+08:00";
          response.meta.partial = query.metricIds.length > 1;
          response.meta.warnings = [];
          return response;
        }
      }
    ];

    for (const [index, executor] of cases.entries()) {
      const app = await createApp({ enabled: true, executor });
      const response = await app.inject({
        method: "POST",
        url: "/api/bi/v2/queries/dashboards/core-overview",
        payload: index === 2
          ? { scope: { kind: "official_overall" }, metricIds: ["M016"], period: { mode: "explicit", currentRange: ["2026-09-01", "2026-09-01"], comparisonRange: null } }
          : { scope: { kind: "official_overall" } }
      });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe("CORE_OVERVIEW_SOURCE_CONFLICT");
      expect(response.body).not.toContain("m016-pday-sum-v1");
    }
  });
});
