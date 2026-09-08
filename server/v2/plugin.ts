import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { v2MetricQuerySchema } from "../../contracts/bi-v2";
import type { V2ApiErrorCode, V2MetricQuery, V2MetricQuerySuccess } from "../../contracts/bi-v2";
import type { IdentityProvider, IdentityResolution, Principal } from "../identity/identity-provider";
import { UpstreamError } from "../upstream/client";
import { listV2Platforms, v2MetricCatalog } from "./catalog";
import { V2MetricQueryError } from "./metric-query.service";

export interface V2MetricQueryExecutor {
  execute(query: V2MetricQuery): Promise<V2MetricQuerySuccess>;
}

export interface V2BiPluginOptions {
  identityProvider: IdentityProvider;
  metricQueryService: V2MetricQueryExecutor;
  identityTimeoutMs?: number;
}

const IDENTITY_TIMEOUT_MS = 3_000;
const transportStatusByCode: Readonly<Record<string, 400 | 413 | 415>> = {
  FST_ERR_CTP_INVALID_JSON_BODY: 400,
  FST_ERR_CTP_EMPTY_JSON_BODY: 400,
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 400,
  FST_ERR_CTP_BODY_TOO_LARGE: 413,
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 415
};
const principalSchema = z.object({
  subjectId: z.string().trim().min(1).max(256),
  displayName: z.string().trim().min(1).max(256).optional(),
  roles: z.array(z.string().trim().min(1).max(64)).max(64),
  permissions: z.array(z.string().trim().min(1).max(128)).max(128),
  pidScope: z.union([
    z.literal("all"),
    z.array(z.string().trim().min(1).max(32)).max(1_000)
  ])
}).strict();

const identityResolutionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("authenticated"), principal: principalSchema }).strict(),
  z.object({ status: z.literal("unauthenticated") }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string().max(256).optional() }).strict()
]);

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

async function resolveIdentity(request: FastifyRequest, identityProvider: IdentityProvider, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("identity_timeout")), { once: true });
    });
    return await Promise.race([
      identityProvider.resolve({ headers: request.headers, ip: request.ip, signal: controller.signal }),
      timedOut
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  try {
    rawResolution = await resolveIdentity(request, identityProvider, identityTimeoutMs);
  } catch (error) {
    request.log.error({ requestId: request.id, outcome: "identity_provider_failed" }, "v2 identity provider failed");
    sendV2Error(request, reply, 503, "IDENTITY_PROVIDER_UNAVAILABLE", "正式身份来源当前不可用");
    return null;
  }
  const parsedResolution = identityResolutionSchema.safeParse(rawResolution);
  if (!parsedResolution.success) {
    request.log.error({ requestId: request.id, outcome: "invalid_identity_resolution" }, "v2 identity provider returned an invalid result");
    sendV2Error(request, reply, 503, "IDENTITY_PROVIDER_UNAVAILABLE", "正式身份来源当前不可用");
    return null;
  }
  const resolution = parsedResolution.data;
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
  return principal.pidScope === "all" || principal.pidScope.includes(pid);
}

export const v2BiPlugin: FastifyPluginAsync<V2BiPluginOptions> = async (app, options) => {
  const identityTimeoutMs = options.identityTimeoutMs ?? IDENTITY_TIMEOUT_MS;
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
    const principal = await requirePrincipal(request, reply, options.identityProvider, identityTimeoutMs);
    if (!principal) return;
    reply.header("cache-control", "no-store");
    return { success: true, data: { items: [...v2MetricCatalog] } };
  });

  app.get("/catalog/platforms", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, options.identityProvider, identityTimeoutMs);
    if (!principal) return;
    reply.header("cache-control", "no-store");
    return { success: true, data: { items: listV2Platforms(principal.pidScope) } };
  });

  app.post("/queries/metrics", async (request, reply) => {
    const startedAt = Date.now();
    const principal = await requirePrincipal(request, reply, options.identityProvider, identityTimeoutMs);
    if (!principal) return;
    const parsed = v2MetricQuerySchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ requestId: request.id, outcome: "invalid_query" }, "v2 metric query rejected");
      return sendV2Error(request, reply, 400, "INVALID_V2_METRIC_QUERY", "指标查询参数不合法");
    }
    if (!canAccessPid(principal, parsed.data.pid)) {
      request.log.warn({ requestId: request.id, metricId: parsed.data.metricId, outcome: "pid_access_denied" }, "v2 metric query rejected");
      return sendV2Error(request, reply, 403, "PID_ACCESS_DENIED", "当前账号无权访问所选业务 PID");
    }
    try {
      reply.header("cache-control", "no-store");
      const result = await options.metricQueryService.execute(parsed.data);
      request.log.info({
        requestId: request.id,
        queryId: result.meta.queryId,
        metricId: parsed.data.metricId,
        outcome: result.data.seriesStatus,
        durationMs: Date.now() - startedAt
      }, "v2 metric query completed");
      return result;
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
};
