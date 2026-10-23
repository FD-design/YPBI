import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { biQueryJobHandleSchema } from "../contracts/query-jobs";
import { OPERATING_QUERY_VALIDATION_PATH, operatingQueryValidationCapabilitiesSchema } from "../contracts/operating-query-validation";
import type { Principal } from "./identity/identity-provider";
import { bindClientRequestAbort } from "./http/client-request-abort";
import { platformRegistry, type PlatformSiteId } from "./platforms/registry";
import { UpstreamError } from "./upstream/client";
import { QueryJobBusinessError } from "./upstream/query-jobs";
import { BiQueryJobError } from "./v2/query-jobs.service";
import type { OperatingQueryJobService } from "./v2/operating-query-jobs.service";

interface AdminOperatingQueryJobsOptions {
  enabled: boolean;
  service?: Pick<OperatingQueryJobService, "create" | "status" | "result">;
  requireMaintenanceSession(request: FastifyRequest, reply: FastifyReply): unknown;
  principalFor(request: FastifyRequest): Principal | undefined;
}

function fail(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ success: false, error: { code, message, requestId: request.id } });
}

/** Maintenance aliases keep production validation separate from ordinary dashboard admission. */
export function registerAdminOperatingQueryJobs(app: FastifyInstance, options: AdminOperatingQueryJobsOptions) {
  const enabled = options.enabled && Boolean(options.service);
  const errorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = error.statusCode;
    if (status === 400 || status === 413 || status === 415) {
      return fail(request, reply, status, "QUERY_JOB_INVALID", "查询任务请求格式或大小不合法");
    }
    request.log.warn({ errorCode: "admin_operating_query_job_route_failure" }, "BI production validation route failed");
    return fail(request, reply, 502, "QUERY_JOB_RESULT_INVALID", "查询任务请求未完成");
  };
  const authorize = (request: FastifyRequest, reply: FastifyReply): Principal | null => {
    reply.header("cache-control", "no-store");
    if (options.requireMaintenanceSession(request, reply)) return null;
    const principal = options.principalFor(request);
    if (!principal || !principal.permissions.includes("bi:read")) {
      fail(request, reply, 403, "BI_READ_ACCESS_DENIED", "当前账号没有BI数据读取权限");
      return null;
    }
    const environment = request.headers["x-ypbi-data-environment"];
    const alias = request.headers["x-bi-data-environment"];
    if (environment !== "production" || alias !== undefined && alias !== "production") {
      fail(request, reply, 400, "INVALID_DATA_ENVIRONMENT", "正式异步验收必须显式选择正式数据环境");
      return null;
    }
    return principal;
  };

  app.get(`${OPERATING_QUERY_VALIDATION_PATH}/capabilities`, { exposeHeadRoute: false, errorHandler }, async (request, reply) => {
    const principal = authorize(request, reply);
    if (!principal) return;
    const bySite = new Map<PlatformSiteId, string[]>();
    if (enabled) for (const platform of platformRegistry) {
      if (!platform.enabled || principal.pidScope !== "all" && !principal.pidScope.includes(platform.pid)) continue;
      const pids = bySite.get(platform.siteId) ?? [];
      pids.push(platform.pid); bySite.set(platform.siteId, pids);
    }
    const groups = [...bySite].flatMap(([site, pids]) => Array.from({ length: Math.ceil(pids.length / 20) }, (_, index) => ({ site, pids: pids.slice(index * 20, (index + 1) * 20) })));
    return operatingQueryValidationCapabilitiesSchema.parse({ success: true, data: { environment: "production", enabled, groups } });
  });

  const handler = (operation: "create" | "status" | "result") => async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = authorize(request, reply);
    if (!principal) return;
    if (!enabled || !options.service) return fail(request, reply, 422, "QUERY_JOBS_DISABLED", "当前环境尚未启用正式异步验收");
    const parsedHandle = operation === "create" ? null : biQueryJobHandleSchema.safeParse((request.params as { handle?: unknown }).handle);
    if (parsedHandle && !parsedHandle.success) return fail(request, reply, 400, "QUERY_JOB_INVALID", "查询任务编号格式不合法");
    const handle = parsedHandle?.success ? parsedHandle.data : "";
    const controller = new AbortController();
    const unbind = bindClientRequestAbort(request.raw, reply.raw, controller, "admin_operating_query_job_request_aborted");
    try {
      return operation === "create"
        ? await options.service.create(principal, request.body, controller.signal)
        : await options.service[operation](principal, handle, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return reply.hijack();
      if (error instanceof BiQueryJobError) return fail(request, reply, error.statusCode, error.code, error.message);
      if (error instanceof QueryJobBusinessError) {
        const status = [400, 404, 409].includes(error.businessCode) ? error.businessCode : 502;
        return reply.code(status).send({ success: false, error: { code: "QUERY_JOB_UPSTREAM_REJECTED", message: "数据源未完成查询任务请求", requestId: request.id,
          upstreamBusinessCode: error.businessCode, upstreamHttpStatus: error.httpStatus } });
      }
      if (error instanceof UpstreamError) {
        if (error.code === "UPSTREAM_QUERY_JOB_CONTEXT_CHANGED") return fail(request, reply, 409, "QUERY_JOB_CONTEXT_CHANGED", "数据源或会话已变化，请重新查询");
        if (error.code === "UPSTREAM_TIMEOUT") return fail(request, reply, 504, "V2_UPSTREAM_TIMEOUT", "指标数据源响应超时，请稍后重试");
        if (error.code === "UPSTREAM_RATE_LIMITED") return fail(request, reply, 503, "V2_UPSTREAM_RATE_LIMITED", "指标数据源当前繁忙，请稍后重试");
        if (["UPSTREAM_NOT_CONFIGURED", "UPSTREAM_AUTH_FAILED", "UPSTREAM_IP_RESTRICTED"].includes(error.code)) {
          return fail(request, reply, 503, "V2_UPSTREAM_UNAVAILABLE", "指标数据源当前不可用");
        }
        return fail(request, reply, 502, "V2_UPSTREAM_FAILED", "指标数据源返回异常，查询未完成");
      }
      request.log.warn({ operation, errorCode: "admin_operating_query_job_unknown_failure" }, "BI production validation request failed");
      return fail(request, reply, 502, "QUERY_JOB_RESULT_INVALID", "查询任务响应未通过校验");
    } finally { unbind(); }
  };
  app.post(OPERATING_QUERY_VALIDATION_PATH, { bodyLimit: 60 * 1024, errorHandler }, handler("create"));
  app.get(`${OPERATING_QUERY_VALIDATION_PATH}/:handle`, { exposeHeadRoute: false, errorHandler }, handler("status"));
  app.get(`${OPERATING_QUERY_VALIDATION_PATH}/:handle/result`, { exposeHeadRoute: false, errorHandler }, handler("result"));
}
