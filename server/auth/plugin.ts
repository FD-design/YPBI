import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { BiAuthApiErrorCode } from "../../contracts/bi-auth";
import { biChangePasswordRequestSchema, biLoginRequestSchema } from "../../contracts/bi-auth";
import {
  type BiSessionCookieConfiguration,
  clearAuthCookie,
  readUniqueOpaqueCookie,
  resolveSessionCookieConfiguration,
  sessionCookie
} from "./cookies";
import { AuthServiceError, type BiAuthService } from "./service";
import { PasswordWorkCapacityError } from "./password";
import { bindClientRequestAbort } from "../http/client-request-abort";

export interface BiAuthPluginOptions {
  authService: BiAuthService;
  sessionCookie?: BiSessionCookieConfiguration;
  expectedOrigin?: string;
  sessionLookupTimeoutMs?: number;
  onSecurityContextChanged?: (subjectId: string) => void | Promise<void>;
}

const DEFAULT_SESSION_LOOKUP_TIMEOUT_MS = 3_000;

const transportStatusByCode = {
  FST_ERR_CTP_INVALID_JSON_BODY: 400,
  FST_ERR_CTP_EMPTY_JSON_BODY: 400,
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 400,
  FST_ERR_CTP_BODY_TOO_LARGE: 413,
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 415
} as const;

function cookieHeader(request: FastifyRequest) {
  const raw = request.headers.cookie;
  return Array.isArray(raw) ? raw.join(";") : raw;
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: BiAuthApiErrorCode,
  message: string
) {
  return reply.code(statusCode).send({ success: false, error: { code, message, requestId: request.id } });
}

function normalizeConfiguredOrigin(origin: string) {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("BI auth expectedOrigin 必须是合法的 http(s) Origin");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.origin === "null"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("BI auth expectedOrigin 必须是合法的 http(s) Origin");
  }
  return parsed.origin;
}

function requestOriginMatches(originHeader: string | string[] | undefined, expectedOrigin: string) {
  return typeof originHeader === "string" && originHeader === expectedOrigin;
}

async function authenticatedSession(
  request: FastifyRequest,
  reply: FastifyReply,
  service: BiAuthService,
  cookieName: string,
  timeoutMs: number
) {
  const token = readUniqueOpaqueCookie(cookieHeader(request), cookieName);
  if (!token) return { token, session: null };

  const controller = new AbortController();
  const unbindClientAbort = bindClientRequestAbort(
    request.raw,
    reply.raw,
    controller,
    "auth_request_aborted"
  );
  const timeout = setTimeout(
    () => controller.abort(new Error("auth_session_lookup_timeout")),
    timeoutMs
  );
  timeout.unref();
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectForAbort = () => {
      reject(controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("auth_session_lookup_aborted"));
    };
    if (controller.signal.aborted) rejectForAbort();
    else controller.signal.addEventListener("abort", rejectForAbort, { once: true });
  });

  try {
    const session = await Promise.race([
      service.resolveSession(token, controller.signal),
      aborted
    ]);
    return { token, session };
  } finally {
    clearTimeout(timeout);
    unbindClientAbort();
  }
}

export const biAuthPlugin: FastifyPluginAsync<BiAuthPluginOptions> = async (app, options) => {
  const cookieConfiguration = resolveSessionCookieConfiguration(options.sessionCookie);
  const sessionLookupTimeoutMs = options.sessionLookupTimeoutMs ?? DEFAULT_SESSION_LOOKUP_TIMEOUT_MS;
  if (!Number.isInteger(sessionLookupTimeoutMs) || sessionLookupTimeoutMs < 1 || sessionLookupTimeoutMs > 30_000) {
    throw new Error("BI auth sessionLookupTimeoutMs 必须是 1～30000 毫秒的整数");
  }
  const expectedOrigin = options.expectedOrigin === undefined
    ? undefined
    : normalizeConfiguredOrigin(options.expectedOrigin);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (
      expectedOrigin
      && (request.method === "POST" || request.method === "PUT")
      && !requestOriginMatches(request.headers.origin, expectedOrigin)
    ) {
      request.log.warn(
        { requestId: request.id, outcome: "auth_origin_rejected" },
        "BI auth request origin rejected"
      );
      return sendError(
        request,
        reply,
        403,
        "ORIGIN_VALIDATION_FAILED",
        "请求来源校验失败，请从 BI 页面重试"
      );
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const rawCode = typeof error === "object" && error !== null && "code" in error
      ? Reflect.get(error, "code")
      : null;
    const transportStatus = typeof rawCode === "string"
      ? transportStatusByCode[rawCode as keyof typeof transportStatusByCode]
      : undefined;
    if (transportStatus) {
      request.log.warn({ requestId: request.id, outcome: "invalid_auth_transport" }, "BI auth request rejected");
      return sendError(request, reply, transportStatus, "INVALID_AUTH_REQUEST", "请求格式不合法");
    }
    request.log.error({ requestId: request.id, outcome: "auth_route_failed" }, "BI auth route failed unexpectedly");
    return sendError(request, reply, 503, "AUTH_SERVICE_UNAVAILABLE", "登录服务当前不可用");
  });

  app.post("/login", async (request, reply) => {
    const parsed = biLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(request, reply, 400, "INVALID_AUTH_REQUEST", "账号或密码格式不合法");
    try {
      const login = await options.authService.login(parsed.data.username, parsed.data.password);
      reply.header(
        "set-cookie",
        sessionCookie(login.sessionToken, options.authService.sessionTtlSeconds(), cookieConfiguration)
      );
      request.log.info({ requestId: request.id, subjectId: login.principal.subjectId, outcome: "login_succeeded" }, "BI user login completed");
      return {
        success: true,
        data: {
          user: login.principal,
          expiresAt: login.expiresAt.toISOString(),
          mustChangePassword: login.mustChangePassword,
          csrfToken: login.csrfToken
        }
      };
    } catch (error) {
      if (error instanceof AuthServiceError && error.code === "INVALID_CREDENTIALS") {
        request.log.warn({ requestId: request.id, outcome: "login_rejected" }, "BI user login rejected");
        return sendError(request, reply, 401, "INVALID_CREDENTIALS", "账号或密码错误");
      }
      if (error instanceof PasswordWorkCapacityError) {
        reply.header("retry-after", "5");
        request.log.warn({ requestId: request.id, outcome: "login_capacity_exceeded" }, "BI password work capacity exceeded");
        return sendError(request, reply, 503, "AUTH_SERVICE_UNAVAILABLE", "登录请求较多，请稍后重试");
      }
      request.log.error({ requestId: request.id, outcome: "login_failed" }, "BI user login failed");
      return sendError(request, reply, 503, "AUTH_SERVICE_UNAVAILABLE", "登录服务当前不可用");
    }
  });

  app.get("/session", async (request, reply) => {
    try {
      const { session } = await authenticatedSession(
        request,
        reply,
        options.authService,
        cookieConfiguration.name,
        sessionLookupTimeoutMs
      );
      if (!session) {
        reply.header("set-cookie", clearAuthCookie(cookieConfiguration));
        return sendError(request, reply, 401, "AUTHENTICATION_REQUIRED", "请先登录");
      }
      const token = readUniqueOpaqueCookie(cookieHeader(request), cookieConfiguration.name)!;
      return { success: true, data: options.authService.sessionData(token, session) };
    } catch {
      request.log.error({ requestId: request.id, outcome: "session_failed" }, "BI user session lookup failed");
      return sendError(request, reply, 503, "AUTH_SERVICE_UNAVAILABLE", "登录服务当前不可用");
    }
  });

  app.post("/logout", async (request, reply) => {
    let sessionRevoked = false;
    try {
      const { token, session } = await authenticatedSession(
        request,
        reply,
        options.authService,
        cookieConfiguration.name,
        sessionLookupTimeoutMs
      );
      if (!session) {
        reply.header("set-cookie", clearAuthCookie(cookieConfiguration));
        return sendError(request, reply, 401, "AUTHENTICATION_REQUIRED", "登录已失效");
      }
      const csrfHeader = Array.isArray(request.headers["x-csrf-token"])
        ? undefined
        : request.headers["x-csrf-token"];
      if (!token || !options.authService.csrfMatches(token, csrfHeader)) {
        return sendError(request, reply, 403, "CSRF_VALIDATION_FAILED", "安全校验失败，请刷新页面后重试");
      }
      await options.authService.logout(token);
      sessionRevoked = true;
      await options.onSecurityContextChanged?.(session.principal.subjectId);
      reply.header("set-cookie", clearAuthCookie(cookieConfiguration));
      request.log.info({ requestId: request.id, subjectId: session.principal.subjectId, outcome: "logout_succeeded" }, "BI user logout completed");
      return { success: true, data: { loggedOut: true } };
    } catch {
      if (sessionRevoked) reply.header("set-cookie", clearAuthCookie(cookieConfiguration));
      request.log.error({ requestId: request.id, outcome: "logout_failed" }, "BI user logout failed");
      return sendError(request, reply, 503, "AUTH_SERVICE_UNAVAILABLE", "退出未完成，请重试");
    }
  });

  app.put("/password", async (request, reply) => {
    const parsed = biChangePasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(request, reply, 400, "INVALID_AUTH_REQUEST", "密码格式不合法");
    let passwordChanged = false;
    try {
      const { session } = await authenticatedSession(
        request,
        reply,
        options.authService,
        cookieConfiguration.name,
        sessionLookupTimeoutMs
      );
      if (!session) {
        reply.header("set-cookie", clearAuthCookie(cookieConfiguration));
        return sendError(request, reply, 401, "AUTHENTICATION_REQUIRED", "登录已失效");
      }
      const sessionToken = readUniqueOpaqueCookie(cookieHeader(request), cookieConfiguration.name);
      const csrfHeader = Array.isArray(request.headers["x-csrf-token"])
        ? undefined
        : request.headers["x-csrf-token"];
      if (!sessionToken || !options.authService.csrfMatches(sessionToken, csrfHeader)) {
        return sendError(request, reply, 403, "CSRF_VALIDATION_FAILED", "安全校验失败，请刷新页面后重试");
      }
      const changed = await options.authService.changePassword(session, parsed.data.currentPassword, parsed.data.newPassword);
      passwordChanged = true;
      await options.onSecurityContextChanged?.(session.principal.subjectId);
      reply.header(
        "set-cookie",
        sessionCookie(changed.sessionToken, options.authService.sessionTtlSeconds(), cookieConfiguration)
      );
      request.log.info({ requestId: request.id, subjectId: session.principal.subjectId, outcome: "password_changed" }, "BI user password changed");
      return {
        success: true,
        data: {
          user: changed.principal,
          expiresAt: changed.expiresAt.toISOString(),
          mustChangePassword: changed.mustChangePassword,
          csrfToken: changed.csrfToken
        }
      };
    } catch (error) {
      if (error instanceof AuthServiceError && error.code === "CURRENT_PASSWORD_INVALID") {
        return sendError(request, reply, 400, "CURRENT_PASSWORD_INVALID", "当前密码错误");
      }
      if (error instanceof PasswordWorkCapacityError) {
        reply.header("retry-after", "5");
        request.log.warn({ requestId: request.id, outcome: "password_change_capacity_exceeded" }, "BI password work capacity exceeded");
        return sendError(request, reply, 503, "AUTH_SERVICE_UNAVAILABLE", "密码操作较多，请稍后重试");
      }
      if (passwordChanged) reply.header("set-cookie", clearAuthCookie(cookieConfiguration));
      request.log.error({ requestId: request.id, outcome: "password_change_failed" }, "BI user password change failed");
      return sendError(request, reply, 503, "AUTH_SERVICE_UNAVAILABLE", "密码修改未完成，请重试");
    }
  });
};
