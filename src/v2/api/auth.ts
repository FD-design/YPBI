import { z } from "zod";
import {
  biAuthErrorResponseSchema,
  biLogoutSuccessSchema,
  biRoleSchema,
  biSessionSuccessSchema,
  type BiRole,
  type BiSessionData
} from "../../../contracts/bi-auth";
import { notifyAuthenticationRequired } from "./authEvents";

export { biRoleSchema as userRoleSchema };
export type AuthenticatedSession = BiSessionData;
export type UserRole = BiRole;
export type AuthFailureKind = "unauthenticated" | "forbidden" | "validation" | "locked" | "unavailable" | "error";

export class AuthRequestError extends Error {
  readonly kind: AuthFailureKind;
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;

  constructor(message: string, options: { kind: AuthFailureKind; code: string; status: number; requestId?: string }) {
    super(message);
    this.name = "AuthRequestError";
    this.kind = options.kind;
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

function failureKind(status: number, code: string): AuthFailureKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 400 || status === 422) return "validation";
  if (status === 429 || code.includes("LOCKED")) return "locked";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "error";
}

function invalidResponse(status: number) {
  return new AuthRequestError("登录服务返回了无法识别的内容", {
    kind: "error",
    code: "INVALID_AUTH_RESPONSE",
    status
  });
}

async function requestJson<T>(
  path: string,
  successSchema: z.ZodType<T>,
  init: RequestInit = {},
  options: { notifyOnUnauthorized?: boolean } = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const controller = new AbortController();
  let callerAborted = false;
  const forwardAbort = () => { callerAborted = true; controller.abort(); };
  if (init.signal?.aborted) forwardAbort();
  else init.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = globalThis.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal
    });
    if (response.status === 401 && options.notifyOnUnauthorized) notifyAuthenticationRequired();
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw invalidResponse(response.status);
    }
    if (response.ok) {
      const parsed = successSchema.safeParse(payload);
      if (!parsed.success) throw invalidResponse(response.status);
      return parsed.data;
    }
    const problem = biAuthErrorResponseSchema.safeParse(payload);
    if (!problem.success) throw invalidResponse(response.status);
    const error = new AuthRequestError(problem.data.error.message, {
      kind: failureKind(response.status, problem.data.error.code),
      code: problem.data.error.code,
      status: response.status,
      requestId: problem.data.error.requestId
    });
    throw error;
  } catch (error) {
    if (error instanceof AuthRequestError) throw error;
    if (callerAborted) throw error;
    if (controller.signal.aborted) {
      throw new AuthRequestError("登录服务响应超时，请稍后重试", {
        kind: "unavailable",
        code: "AUTH_REQUEST_TIMEOUT",
        status: 0
      });
    }
    throw new AuthRequestError("无法连接登录服务，请检查网络后重试", {
      kind: "unavailable",
      code: "AUTH_NETWORK_ERROR",
      status: 0
    });
  } finally {
    globalThis.clearTimeout(timer);
    init.signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function fetchUserSession(signal?: AbortSignal) {
  try {
    const payload = await requestJson("/api/bi/v2/auth/session", biSessionSuccessSchema, { signal });
    return payload.data;
  } catch (error) {
    if (error instanceof AuthRequestError && error.status === 401) return null;
    throw error;
  }
}

export async function loginUser(username: string, password: string) {
  const payload = await requestJson("/api/bi/v2/auth/login", biSessionSuccessSchema, {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  return payload.data;
}

export async function logoutUser(csrfToken: string) {
  const payload = await requestJson("/api/bi/v2/auth/logout", biLogoutSuccessSchema, {
    method: "POST",
    headers: { "x-csrf-token": csrfToken }
  }, { notifyOnUnauthorized: true });
  return payload.data;
}

export async function changeUserPassword(currentPassword: string, newPassword: string, csrfToken: string) {
  const payload = await requestJson("/api/bi/v2/auth/password", biSessionSuccessSchema, {
    method: "PUT",
    headers: { "x-csrf-token": csrfToken },
    body: JSON.stringify({ currentPassword, newPassword })
  }, { notifyOnUnauthorized: true });
  return payload.data;
}
