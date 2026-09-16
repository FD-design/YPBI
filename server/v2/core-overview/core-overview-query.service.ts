import { randomUUID } from "node:crypto";
import {
  CORE_OVERVIEW_CARD_SPECS,
  CORE_OVERVIEW_CONTRACT_VERSION,
  CORE_OVERVIEW_DASHBOARD_ID,
  coreOverviewQuerySuccessSchema,
  coreOverviewWatermarkSchema,
  type CoreOverviewCard,
  type CoreOverviewMetricId,
  type CoreOverviewQuery,
  type CoreOverviewQuerySuccess
} from "../../../contracts/core-overview.ts";
import type { MetricDefinitionItem } from "../../../contracts/bi-v2.ts";
import {
  planCoreOverviewAdmissions,
  type CoreOverviewMetricDefinitionResolver
} from "./core-overview-admission.ts";
import {
  CoreOverviewPeriodResolutionError,
  resolveCoreOverviewPeriodFromTrustedWatermarks,
  type CoreOverviewResolvedPeriod,
  type CoreOverviewTrustedWatermark
} from "./core-overview-period.ts";

type CoreOverviewScope = CoreOverviewQuerySuccess["data"]["scopeResults"][number]["scope"];

export interface CoreOverviewMetricProvider {
  resolveWatermark(input: {
    metricId: CoreOverviewMetricId;
    definition: MetricDefinitionItem;
    scope: CoreOverviewScope;
    signal: AbortSignal;
  }): Promise<CoreOverviewTrustedWatermark | null>;
  query(input: {
    metricId: CoreOverviewMetricId;
    definition: MetricDefinitionItem;
    scope: CoreOverviewScope;
    period: CoreOverviewResolvedPeriod;
    watermark: CoreOverviewTrustedWatermark;
    signal: AbortSignal;
  }): Promise<CoreOverviewCard["result"]>;
}

export type CoreOverviewProviderRegistry = ReadonlyMap<CoreOverviewMetricId, CoreOverviewMetricProvider>;

function scopeKey(scope: CoreOverviewScope) {
  return scope.kind === "official_overall" ? "official_overall" : `pid:${scope.pid}`;
}

function scopesFor(query: CoreOverviewQuery): CoreOverviewScope[] {
  return query.scope.kind === "official_overall"
    ? [{ kind: "official_overall" }]
    : query.scope.pids.map((pid) => ({ kind: "pid", pid }));
}

function cardSpec(metricId: CoreOverviewMetricId) {
  const spec = CORE_OVERVIEW_CARD_SPECS.find((candidate) => candidate.metricId === metricId);
  if (!spec) throw new Error(`核心经营总览缺少 ${metricId} 固定卡片配置`);
  return spec;
}

function sameScope(left: CoreOverviewScope, right: CoreOverviewScope) {
  return left.kind === right.kind
    && (left.kind === "official_overall" || (right.kind === "pid" && left.pid === right.pid));
}

function providerFailure(errorCode: string, retryable: boolean): CoreOverviewCard["result"] {
  return {
    status: "failed",
    errorCode,
    message: retryable ? "指标查询暂时失败，请稍后重试" : "指标查询执行器尚未配置",
    retryable
  };
}

/**
 * 核心经营总览的正式编排器。它只调用已经通过当前指标目录准入、并能提供
 * 已登记可信水位的 provider；没有可信水位时整板失败关闭，不从当前时间、
 * 日看板候选结果或返回记录最大日期推断完整日。
 */
export class CoreOverviewQueryService {
  private readonly providers: CoreOverviewProviderRegistry;
  private readonly resolveDefinition: CoreOverviewMetricDefinitionResolver;
  private readonly now: () => Date;

  constructor(
    resolveDefinition: CoreOverviewMetricDefinitionResolver,
    providers: CoreOverviewProviderRegistry = new Map(),
    now: () => Date = () => new Date()
  ) {
    this.providers = providers;
    this.resolveDefinition = resolveDefinition;
    this.now = now;
  }

  async execute(query: CoreOverviewQuery, context: { signal: AbortSignal }): Promise<CoreOverviewQuerySuccess> {
    const admissions = planCoreOverviewAdmissions(query, this.resolveDefinition);
    const scopes = scopesFor(query);
    const watermarkByCard = new Map<string, CoreOverviewTrustedWatermark>();
    const watermarkFailures = new Set<string>();

    await Promise.all(scopes.flatMap((scope) => admissions.map(async ({ metricId, decision }) => {
      if (decision.status !== "admitted") return;
      const provider = this.providers.get(metricId);
      const key = `${scopeKey(scope)}|${metricId}`;
      if (!provider) {
        watermarkFailures.add(key);
        return;
      }
      try {
        const rawWatermark = await provider.resolveWatermark({
          metricId,
          definition: decision.definition,
          scope,
          signal: context.signal
        });
        if (context.signal.aborted) throw new DOMException("请求已取消", "AbortError");
        if (!rawWatermark) {
          watermarkFailures.add(key);
          return;
        }
        const parsed = coreOverviewWatermarkSchema.safeParse(rawWatermark);
        if (!parsed.success || !sameScope(parsed.data.scope, scope)) {
          throw new Error("核心指标 provider 返回了无效或错范围的可信水位");
        }
        watermarkByCard.set(key, parsed.data);
      } catch (error) {
        if (context.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        watermarkFailures.add(key);
      }
    })));

    const period = resolveCoreOverviewPeriodFromTrustedWatermarks(
      query.period,
      [...watermarkByCard.values()]
    );

    const scopeResults = await Promise.all(scopes.map(async (scope) => ({
      scope,
      cards: await Promise.all(admissions.map(async ({ metricId, decision }) => {
        const spec = cardSpec(metricId);
        if (decision.status !== "admitted") return { ...spec, result: decision };
        const key = `${scopeKey(scope)}|${metricId}`;
        const provider = this.providers.get(metricId);
        const watermark = watermarkByCard.get(key);
        if (!provider || !watermark) {
          return { ...spec, result: providerFailure("CORE_OVERVIEW_PROVIDER_UNAVAILABLE", false) };
        }
        try {
          const result = await provider.query({
            metricId,
            definition: decision.definition,
            scope,
            period,
            watermark,
            signal: context.signal
          });
          if (context.signal.aborted) throw new DOMException("请求已取消", "AbortError");
          return { ...spec, result };
        } catch (error) {
          if (context.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
          return { ...spec, result: providerFailure("CORE_OVERVIEW_PROVIDER_QUERY_FAILED", true) };
        }
      }))
    })));

    const fetchedAt = this.now().toISOString();
    const response = {
      success: true,
      data: {
        dashboard: { id: CORE_OVERVIEW_DASHBOARD_ID, contractVersion: CORE_OVERVIEW_CONTRACT_VERSION },
        requestedScope: query.scope,
        requestedMetricIds: query.metricIds,
        period,
        scopeResults
      },
      meta: {
        queryId: randomUUID(),
        fetchedAt,
        partial: scopeResults.some(({ cards }) => cards.some(({ result }) => (
          result.status !== "available" || result.completeness === "partial"
        ))),
        warnings: watermarkFailures.size > 0
          ? [`${watermarkFailures.size} 个指标范围尚无可信水位或正式 provider。`]
          : []
      }
    };
    const validated = coreOverviewQuerySuccessSchema.safeParse(response);
    if (!validated.success) throw new Error("核心经营总览 provider 输出不满足正式公共契约");
    return validated.data;
  }
}

export { CoreOverviewPeriodResolutionError };
