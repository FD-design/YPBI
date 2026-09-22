import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  coreOverviewQuerySchema,
  coreOverviewQuerySuccessSchema,
  coreOverviewResponseMatchesQuery
} from "../../contracts/core-overview";
import type {
  CoreOverviewQuery,
  CoreOverviewQuerySuccess
} from "../../contracts/core-overview";
import { v2MetricQuerySchema, v2MetricQuerySuccessSchema } from "../../contracts/bi-v2";
import type {
  MetricDefinitionItem,
  V2ApiErrorCode,
  V2MetricQuery,
  V2MetricQuerySuccess
} from "../../contracts/bi-v2";
import type { IdentityProvider, IdentityResolution, Principal } from "../identity/identity-provider";
import { DEFAULT_IDENTITY_TIMEOUT_MS, resolveIdentity } from "../identity/resolve-identity";
import { UpstreamError } from "../upstream/client";
import { listV2Platforms, v2MetricCatalog } from "./catalog";
import {
  getV2MetricDefinition,
  hasCurrentExecutableMetricMapping,
  v2MetricDefinitionsResponse
} from "./metric-definitions";
import { CoreOverviewPeriodResolutionError } from "./core-overview/core-overview-period";
import { V2MetricQueryError } from "./metric-query.service";
import { bindClientRequestAbort } from "../http/client-request-abort";
import { dailyDashboardCatalog, dailyDashboardMatchesMapping, type DailyDashboardExecutor } from "./daily-dashboard.service";
import { dailyDashboardQuerySchema, dailyDashboardSuccessSchema, dailyDashboardMatchesQuery } from "../../contracts/daily-dashboard";
import { runWithUpstreamRequestProfile, type UpstreamRequestProfile } from "../upstream/request-profile";

export interface V2MetricQueryExecutor {
  execute(query: V2MetricQuery): Promise<V2MetricQuerySuccess>;
}

export interface V2CoreOverviewQueryExecutor {
  execute(query: CoreOverviewQuery, context: { signal: AbortSignal }): Promise<CoreOverviewQuerySuccess>;
}

export interface V2BiPluginOptions {
  identityProvider: IdentityProvider;
  metricQueryService: V2MetricQueryExecutor;
  coreOverviewQueryEnabled?: boolean;
  coreOverviewQueryService?: V2CoreOverviewQueryExecutor;
  dailyDashboardService?: DailyDashboardExecutor;
  productionDailyDashboardEnabled?: boolean;
  dataEnvironmentResolver?: {
    testAvailable: boolean;
    resolveTest(request: FastifyRequest, principal: Principal):
      | { status: "active"; expiresAt: number; profile: UpstreamRequestProfile }
      | { status: "missing" | "invalid" | "expired" };
  };
  identityTimeoutMs?: number;
  metricDefinitionResolver?: (metricId: string) => MetricDefinitionItem | undefined;
}

type V2RequestContext = {
  principal: Principal;
  environment:
    | { mode: "production" }
    | { mode: "test"; expiresAt: number; profile: UpstreamRequestProfile };
};

const transportStatusByCode: Readonly<Record<string, 400 | 413 | 415>> = {
  FST_ERR_CTP_INVALID_JSON_BODY: 400,
  FST_ERR_CTP_EMPTY_JSON_BODY: 400,
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 400,
  FST_ERR_CTP_BODY_TOO_LARGE: 413,
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 415
};
function sendV2Error(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: V2ApiErrorCode,
  message: string
) {
  return reply.code(statusCode).send({
    success: false,
    error: { code, message, requestId: request.id }
  });
}

function normalizedPrincipal(principal: Principal): Principal {
  if (principal.pidScope === "all") return principal;
  const allowedPids = new Set(listV2Platforms("all").map((platform) => platform.pid));
  return { ...principal, pidScope: [...new Set(principal.pidScope)].filter((pid) => allowedPids.has(pid)) };
}

function mapUpstreamFailure(error: UpstreamError): { statusCode: 502 | 503 | 504; code: V2ApiErrorCode; message: string } {
  if (error.code === "UPSTREAM_TIMEOUT") {
    return { statusCode: 504, code: "V2_UPSTREAM_TIMEOUT", message: "指标数据源响应超时，请稍后重试" };
  }
  if (error.code === "UPSTREAM_RATE_LIMITED") {
    return { statusCode: 503, code: "V2_UPSTREAM_RATE_LIMITED", message: "指标数据源当前繁忙，请稍后重试" };
  }
  if (["UPSTREAM_NOT_CONFIGURED", "UPSTREAM_AUTH_FAILED", "UPSTREAM_IP_RESTRICTED"].includes(error.code)) {
    return { statusCode: 503, code: "V2_UPSTREAM_UNAVAILABLE", message: "指标数据源当前不可用" };
  }
  return { statusCode: 502, code: "V2_UPSTREAM_FAILED", message: "指标数据源返回异常，查询未完成" };
}

async function requirePrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  identityProvider: IdentityProvider,
  identityTimeoutMs: number
): Promise<Principal | null> {
  reply.header("cache-control", "no-store");
  let rawResolution: IdentityResolution;
  const clientAbortController = new AbortController();
  const unbindClientAbort = bindClientRequestAbort(
    request.raw,
    reply.raw,
    clientAbortController,
    "v2_identity_request_aborted"
  );
  try {
    rawResolution = await resolveIdentity(
      identityProvider,
      { headers: request.headers, ip: request.ip, signal: clientAbortController.signal },
      identityTimeoutMs
    );
  } catch (error) {
    request.log.error({ requestId: request.id, outcome: "identity_provider_failed" }, "v2 identity provider failed");
    sendV2Error(request, reply, 503, "IDENTITY_PROVIDER_UNAVAILABLE", "正式身份来源当前不可用");
    return null;
  } finally {
    unbindClientAbort();
  }
  const resolution = rawResolution;
  if (resolution.status === "unavailable") {
    request.log.warn({ requestId: request.id, identityStatus: resolution.status }, "v2 request rejected by identity boundary");
    sendV2Error(request, reply, 503, "IDENTITY_PROVIDER_UNAVAILABLE", "正式身份来源当前不可用");
    return null;
  }
  if (resolution.status === "unauthenticated") {
    request.log.warn({ requestId: request.id, identityStatus: resolution.status }, "v2 request rejected by identity boundary");
    sendV2Error(request, reply, 401, "AUTHENTICATION_REQUIRED", "请先登录后再访问新版 BI");
    return null;
  }
  if (!resolution.principal.permissions.includes("bi:read")) {
    request.log.warn({ requestId: request.id, identityStatus: resolution.status, outcome: "bi_read_denied" }, "v2 request rejected by permission boundary");
    sendV2Error(request, reply, 403, "BI_READ_ACCESS_DENIED", "当前账号没有新版 BI 只读权限");
    return null;
  }
  return normalizedPrincipal(resolution.principal);
}

function canAccessPid(principal: Principal, pid: string) {
  const existsInCurrentCatalog = listV2Platforms("all").some((platform) => platform.pid === pid);
  return existsInCurrentCatalog && (principal.pidScope === "all" || principal.pidScope.includes(pid));
}

function canAccessCoreOverviewScope(principal: Principal, query: CoreOverviewQuery) {
  if (query.scope.kind === "official_overall") return principal.pidScope === "all";
  return query.scope.pids.every((pid) => canAccessPid(principal, pid));
}

function normalizeCoreOverviewQueryScope(query: CoreOverviewQuery): CoreOverviewQuery {
  if (query.scope.kind === "official_overall") return query;
  const orderByPid = new Map(listV2Platforms("all").map((platform, index) => [platform.pid, index]));
  return {
    ...query,
    scope: {
      kind: "pids",
      pids: [...query.scope.pids].sort((left, right) => (
        (orderByPid.get(left) ?? Number.MAX_SAFE_INTEGER) - (orderByPid.get(right) ?? Number.MAX_SAFE_INTEGER)
      ))
    }
  };
}

function coreOverviewResponseUsesCurrentAdmissions(
  response: CoreOverviewQuerySuccess,
  resolveMetricDefinition: (metricId: string) => MetricDefinitionItem | undefined
) {
  return response.data.scopeResults.every((scopeResult) => scopeResult.cards.every((card) => {
    if (!("provenance" in card.result)) return true;
    const definition = resolveMetricDefinition(card.metricId);
    if (!definition || definition.analysis.status !== "available" || !hasCurrentExecutableMetricMapping(definition)) return false;
    return card.result.provenance.validationStatus === "passed"
      && card.result.provenance.authorityVersion === definition.authority.version
      && card.result.provenance.mappingVersion === definition.ypbiMapping.mappingVersion
      && definition.validation.status === "passed"
      && definition.validation.authorityVersion === definition.authority.version
      && definition.validation.mappingVersion === definition.ypbiMapping.mappingVersion;
  }));
}

function metricQueryResponseMatchesRequest(result: V2MetricQuerySuccess, query: V2MetricQuery) {
  return result.data.metric.id === query.metricId
    && result.data.scope.pid === query.pid
    && result.data.grain === query.grain
    && result.data.dateRange[0] === query.dateRange[0]
    && result.data.dateRange[1] === query.dateRange[1];
}

export const v2BiPlugin: FastifyPluginAsync<V2BiPluginOptions> = async (app, options) => {
  const identityTimeoutMs = options.identityTimeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS;
  const resolveMetricDefinition = options.metricDefinitionResolver ?? getV2MetricDefinition;
  const requireContext = async (request: FastifyRequest, reply: FastifyReply): Promise<V2RequestContext | null> => {
    const principal = await requirePrincipal(request, reply, options.identityProvider, identityTimeoutMs);
    if (!principal) return null;
    const rawEnvironment = request.headers["x-ypbi-data-environment"];
    const requestedEnvironment = Array.isArray(rawEnvironment) ? null : rawEnvironment;
    if (requestedEnvironment === undefined || requestedEnvironment === "production") {
      return { principal, environment: { mode: "production" } };
    }
    if (requestedEnvironment !== "test") {
      sendV2Error(request, reply, 400, "INVALID_DATA_ENVIRONMENT", "数据环境参数不合法");
      return null;
    }
    if (!options.dataEnvironmentResolver?.testAvailable) {
      sendV2Error(request, reply, 409, "DATA_PREVIEW_DISABLED", "测试数据模式尚未启用");
      return null;
    }
    const resolved = options.dataEnvironmentResolver.resolveTest(request, principal);
    if (resolved.status !== "active") {
      const message = resolved.status === "expired"
        ? "测试数据会话已过期，请重新验证测试 Token"
        : "测试数据会话无效，请重新验证测试 Token";
      sendV2Error(request, reply, 409, "DATA_PREVIEW_SESSION_REQUIRED", message);
      return null;
    }
    return { principal, environment: { mode: "test", expiresAt: resolved.expiresAt, profile: resolved.profile } };
  };
  const runInEnvironment = <T>(context: V2RequestContext, operation: () => Promise<T>) => (
    context.environment.mode === "test"
      ? runWithUpstreamRequestProfile(context.environment.profile, operation)
      : operation()
  );
  // Keep the new public error contract encapsulated to V2. Legacy routes keep
  // their pre-existing Fastify response semantics until a separate migration.
  app.setErrorHandler((error, request, reply) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const rawCode = typeof error === "object" && error !== null && "code" in error ? Reflect.get(error, "code") : null;
    const statusCode = typeof rawCode === "string" ? transportStatusByCode[rawCode] ?? 500 : 500;
    if (statusCode === 500) {
      request.log.error({ requestId: request.id, route: request.routeOptions.url, errorName }, "v2 BI request failed unexpectedly");
      return sendV2Error(request, reply, 500, "INTERNAL_ERROR", "BI 服务处理失败");
    }
    request.log.warn({ requestId: request.id, route: request.routeOptions.url, errorName, statusCode }, "v2 BI request rejected by transport boundary");
    const code = statusCode === 400
      ? "INVALID_V2_REQUEST"
      : statusCode === 413
        ? "V2_REQUEST_TOO_LARGE"
        : "V2_UNSUPPORTED_MEDIA_TYPE";
    const message = statusCode === 413 ? "请求内容过大" : statusCode === 415 ? "请求内容类型不受支持" : "请求格式不合法";
    return sendV2Error(request, reply, statusCode, code, message);
  });

  app.get("/catalog/metrics", async (request, reply) => {
    const context = await requireContext(request, reply);
    if (!context) return;
    reply.header("cache-control", "no-store");
    return { success: true, data: { items: [...v2MetricCatalog] } };
  });

  app.get("/data-environment", async (request, reply) => {
    const context = await requireContext(request, reply);
    if (!context) return;
    reply.header("cache-control", "no-store");
    return context.environment.mode === "test"
      ? { success: true, data: { mode: "test" as const, testAvailable: true as const, expiresAt: new Date(context.environment.expiresAt).toISOString(), userName: context.environment.profile.userName } }
      : { success: true, data: { mode: "production" as const, testAvailable: Boolean(options.dataEnvironmentResolver?.testAvailable), expiresAt: null, userName: null } };
  });

  app.get("/catalog/readable-dashboards", async (request, reply) => {
    const context = await requireContext(request, reply);
    if (!context) return;
    const enabled = context.environment.mode === "test" || options.productionDailyDashboardEnabled === true;
    return dailyDashboardCatalog(enabled && Boolean(options.dailyDashboardService));
  });

  app.post("/queries/dashboards/daily-reading", async (request, reply) => {
    const startedAt = Date.now();
    const context = await requireContext(request, reply);
    if (!context) return;
    const { principal } = context;
    const dailyReadingEnabled = context.environment.mode === "test" || options.productionDailyDashboardEnabled === true;
    if (!dailyReadingEnabled || !options.dailyDashboardService) return sendV2Error(request, reply, 422, "DAILY_READING_DISABLED", "当前环境未开启真实看板读取");
    const query = dailyDashboardQuerySchema.safeParse(request.body);
    const board = query.success ? dailyDashboardCatalog(true).data.items.find(item => item.id === query.data.boardId) : undefined;
    if (!query.success || !board) return sendV2Error(request, reply, 400, "INVALID_DAILY_READING_QUERY", "看板查询参数不合法");
    if (!canAccessPid(principal, query.data.pid)) return sendV2Error(request, reply, 403, "PID_ACCESS_DENIED", "当前账号无权访问所选业务平台");
    if (!board.metricIds.length) return sendV2Error(request, reply, 422, "DAILY_BOARD_NOT_READY", "该看板尚无可读取的数据");
    try {
      const result = dailyDashboardSuccessSchema.safeParse(await runInEnvironment(context, () => options.dailyDashboardService!.execute(query.data)));
      if (!result.success || !dailyDashboardMatchesQuery(result.data, query.data, board.metricIds) || !dailyDashboardMatchesMapping(result.data)) {
        request.log.warn({ outcome: "response_contract_conflict", durationMs: Date.now() - startedAt }, "daily dashboard query rejected");
        return sendV2Error(request, reply, 502, "DAILY_SOURCE_CONFLICT", "数据结构或范围异常，未显示本次结果");
      }
      request.log.info({ outcome: "success", durationMs: Date.now() - startedAt, boardId: board.id }, "daily dashboard query completed");
      return result.data;
    } catch (error) {
      request.log.warn({ outcome: "query_failed", durationMs: Date.now() - startedAt, errorCode: error instanceof UpstreamError ? error.code : "invalid_response" }, "daily dashboard query failed");
      if (error instanceof UpstreamError && error.code !== "DAILY_SOURCE_CONFLICT") {
        const failure = mapUpstreamFailure(error);
        return sendV2Error(request, reply, failure.statusCode, failure.code, failure.message);
      }
      return sendV2Error(request, reply, 502, "DAILY_SOURCE_CONFLICT", "数据结构或范围异常，未显示本次结果");
    }
  });

  app.get("/catalog/metric-definitions", async (request, reply) => {
    const context = await requireContext(request, reply);
    if (!context) return;
    reply.header("cache-control", "no-store");
    return v2MetricDefinitionsResponse;
  });

  app.get("/catalog/platforms", async (request, reply) => {
    const context = await requireContext(request, reply);
    if (!context) return;
    const { principal } = context;
    reply.header("cache-control", "no-store");
    return { success: true, data: { items: listV2Platforms(principal.pidScope) } };
  });

  app.post("/queries/metrics", async (request, reply) => {
    const startedAt = Date.now();
    const context = await requireContext(request, reply);
    if (!context) return;
    const { principal } = context;
    const parsed = v2MetricQuerySchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ requestId: request.id, outcome: "invalid_query" }, "v2 metric query rejected");
      return sendV2Error(request, reply, 400, "INVALID_V2_METRIC_QUERY", "指标查询参数不合法");
    }
    if (!canAccessPid(principal, parsed.data.pid)) {
      request.log.warn({ requestId: request.id, metricId: parsed.data.metricId, outcome: "pid_access_denied" }, "v2 metric query rejected");
      return sendV2Error(request, reply, 403, "PID_ACCESS_DENIED", "当前账号无权访问所选业务 PID");
    }
    const metricDefinition = resolveMetricDefinition(parsed.data.metricId);
    const mappingIsExecutable = metricDefinition ? hasCurrentExecutableMetricMapping(metricDefinition) : false;
    const mayRunFormalQuery = mappingIsExecutable && metricDefinition?.analysis.status === "available";
    const mayRunValidationQuery = mappingIsExecutable
      && (metricDefinition?.validation.status === "not_started" || metricDefinition?.validation.status === "running")
      && principal.roles.includes("maintainer")
      && principal.permissions.includes("bi:data-source-maintenance:enter");
    if (!mayRunFormalQuery && !mayRunValidationQuery) {
      request.log.warn({ requestId: request.id, metricId: parsed.data.metricId, outcome: "metric_not_ready" }, "v2 metric query rejected");
      const message = mappingIsExecutable
        ? "该指标尚未完成当前映射版本验数"
        : "该指标当前没有可执行的有效映射";
      return sendV2Error(request, reply, 422, "METRIC_NOT_READY", message);
    }
    try {
      reply.header("cache-control", "no-store");
      const result = await runInEnvironment(context, () => options.metricQueryService.execute(parsed.data));
      const parsedResult = v2MetricQuerySuccessSchema.safeParse(result);
      if (!parsedResult.success) {
        request.log.warn({
          requestId: request.id,
          metricId: parsed.data.metricId,
          outcome: "response_contract_conflict",
          durationMs: Date.now() - startedAt
        }, "v2 metric query response rejected");
        return sendV2Error(
          request,
          reply,
          502,
          "V2_METRIC_SOURCE_CONFLICT",
          "指标查询结果不满足公共契约，查询已停止"
        );
      }
      const validatedResult = parsedResult.data;
      if (!metricQueryResponseMatchesRequest(validatedResult, parsed.data)) {
        request.log.warn({
          requestId: request.id,
          metricId: parsed.data.metricId,
          outcome: "response_query_mismatch",
          durationMs: Date.now() - startedAt
        }, "v2 metric query response rejected");
        return sendV2Error(
          request,
          reply,
          502,
          "V2_METRIC_SOURCE_CONFLICT",
          "指标查询结果与请求范围不一致，查询已停止"
        );
      }
      request.log.info({
        requestId: request.id,
        queryId: validatedResult.meta.queryId,
        metricId: parsed.data.metricId,
        outcome: validatedResult.data.seriesStatus,
        durationMs: Date.now() - startedAt
      }, "v2 metric query completed");
      return validatedResult;
    } catch (error) {
      if (error instanceof V2MetricQueryError) {
        request.log.warn({ requestId: request.id, metricId: parsed.data.metricId, outcome: error.code, durationMs: Date.now() - startedAt }, "v2 metric query failed");
        return sendV2Error(request, reply, error.statusCode, error.code, error.message);
      }
      if (error instanceof UpstreamError) {
        const mapped = mapUpstreamFailure(error);
        request.log.warn({ requestId: request.id, metricId: parsed.data.metricId, outcome: mapped.code, durationMs: Date.now() - startedAt }, "v2 metric query upstream failed");
        return sendV2Error(request, reply, mapped.statusCode, mapped.code, mapped.message);
      }
      throw error;
    }
  });

  app.post("/queries/dashboards/core-overview", async (request, reply) => {
    const startedAt = Date.now();
    const context = await requireContext(request, reply);
    if (!context) return;
    const { principal } = context;
    if (options.coreOverviewQueryEnabled !== true) {
      request.log.info({ requestId: request.id, outcome: "feature_disabled" }, "v2 core overview query rejected");
      return sendV2Error(
        request,
        reply,
        503,
        "CORE_OVERVIEW_QUERY_DISABLED",
        "核心经营总览真实查询尚未开放"
      );
    }
    if (!options.coreOverviewQueryService) {
      request.log.error({ requestId: request.id, outcome: "executor_unavailable" }, "v2 core overview query unavailable");
      return sendV2Error(
        request,
        reply,
        503,
        "CORE_OVERVIEW_QUERY_UNAVAILABLE",
        "核心经营总览查询服务尚未就绪"
      );
    }

    const parsed = coreOverviewQuerySchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ requestId: request.id, outcome: "invalid_query" }, "v2 core overview query rejected");
      return sendV2Error(request, reply, 400, "INVALID_CORE_OVERVIEW_QUERY", "核心经营总览查询参数不合法");
    }
    if (!canAccessCoreOverviewScope(principal, parsed.data)) {
      request.log.warn({ requestId: request.id, scopeKind: parsed.data.scope.kind, outcome: "pid_access_denied" }, "v2 core overview query rejected");
      return sendV2Error(request, reply, 403, "PID_ACCESS_DENIED", "当前账号无权访问所选业务范围");
    }

    const normalizedQuery = normalizeCoreOverviewQueryScope(parsed.data);
    const clientAbortController = new AbortController();
    const unbindClientAbort = bindClientRequestAbort(
      request.raw,
      reply.raw,
      clientAbortController,
      "v2_core_overview_request_aborted"
    );
    try {
      reply.header("cache-control", "no-store");
      const result = await runInEnvironment(context, () => options.coreOverviewQueryService!.execute(normalizedQuery, {
        signal: clientAbortController.signal
      }));
      const parsedResult = coreOverviewQuerySuccessSchema.safeParse(result);
      if (!parsedResult.success) {
        request.log.warn({
          requestId: request.id,
          scopeKind: normalizedQuery.scope.kind,
          metricCount: normalizedQuery.metricIds.length,
          outcome: "response_contract_conflict",
          durationMs: Date.now() - startedAt
        }, "v2 core overview query response rejected");
        return sendV2Error(
          request,
          reply,
          502,
          "CORE_OVERVIEW_SOURCE_CONFLICT",
          "核心经营总览结果不满足公共契约，查询已停止"
        );
      }
      const validatedResult = parsedResult.data;
      if (
        !coreOverviewResponseMatchesQuery(validatedResult, normalizedQuery)
        || !coreOverviewResponseUsesCurrentAdmissions(validatedResult, resolveMetricDefinition)
      ) {
        request.log.warn({
          requestId: request.id,
          scopeKind: normalizedQuery.scope.kind,
          metricCount: normalizedQuery.metricIds.length,
          outcome: "response_query_or_admission_mismatch",
          durationMs: Date.now() - startedAt
        }, "v2 core overview query response rejected");
        return sendV2Error(
          request,
          reply,
          502,
          "CORE_OVERVIEW_SOURCE_CONFLICT",
          "核心经营总览结果与请求或当前数据准入不一致，查询已停止"
        );
      }
      request.log.info({
        requestId: request.id,
        queryId: validatedResult.meta.queryId,
        scopeKind: normalizedQuery.scope.kind,
        metricCount: normalizedQuery.metricIds.length,
        scopeCount: validatedResult.data.scopeResults.length,
        outcome: validatedResult.meta.partial ? "partial" : "complete",
        durationMs: Date.now() - startedAt
      }, "v2 core overview query completed");
      return validatedResult;
    } catch (error) {
      if (error instanceof CoreOverviewPeriodResolutionError) {
        request.log.warn({
          requestId: request.id,
          scopeKind: normalizedQuery.scope.kind,
          metricCount: normalizedQuery.metricIds.length,
          outcome: error.code,
          durationMs: Date.now() - startedAt
        }, "v2 core overview query period unavailable");
        return sendV2Error(
          request,
          reply,
          422,
          "METRIC_NOT_READY",
          "所选核心指标或查询周期尚无共同可信数据水位"
        );
      }
      if (error instanceof UpstreamError) {
        const mapped = mapUpstreamFailure(error);
        request.log.warn({
          requestId: request.id,
          scopeKind: normalizedQuery.scope.kind,
          metricCount: normalizedQuery.metricIds.length,
          outcome: mapped.code,
          durationMs: Date.now() - startedAt
        }, "v2 core overview query upstream failed");
        return sendV2Error(request, reply, mapped.statusCode, mapped.code, mapped.message);
      }
      throw error;
    } finally {
      unbindClientAbort();
    }
  });
};
