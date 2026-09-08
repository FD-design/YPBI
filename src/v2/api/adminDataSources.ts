import { z } from "zod";

export type CredentialSite = "primary" | "secondary";
export type AdminFailureKind = "login_required" | "disabled" | "locked" | "insecure" | "validation" | "upstream" | "error";

const credentialSiteSchema = z.enum(["primary", "secondary"]);
const tokenHintSchema = z.string().max(8).refine(
  (value) => value === "未配置" || /^••••\S{4}$/u.test(value),
  "Token 提示必须是固定掩码或未配置"
);
const dataSourceStatusSchema = z.object({
  site: credentialSiteSchema,
  configured: z.boolean(),
  tokenHint: tokenHintSchema,
  updatedAt: z.iso.datetime().nullable(),
  userName: z.string().max(256)
}).strict().superRefine((source, context) => {
  if (source.configured !== (source.tokenHint !== "未配置")) {
    context.addIssue({ code: "custom", path: ["tokenHint"], message: "Token 配置状态与脱敏提示不一致" });
  }
});

const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional()
  }).strict()
}).strict();

const statusResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(dataSourceStatusSchema).length(2)
}).strict().superRefine((payload, context) => {
  const sites = new Set(payload.data.map((item) => item.site));
  if (!sites.has("primary") || !sites.has("secondary")) {
    context.addIssue({ code: "custom", message: "数据源状态缺少站点" });
  }
});

const loginResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ expiresAt: z.iso.datetime() }).strict()
}).strict();

const logoutResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ loggedOut: z.literal(true) }).strict()
}).strict();

const testResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    site: credentialSiteSchema,
    valid: z.literal(true),
    checkedAt: z.iso.datetime()
  }).strict()
}).strict();

const updateResponseSchema = z.object({
  success: z.literal(true),
  data: dataSourceStatusSchema
}).strict();

export type DataSourceStatus = z.infer<typeof dataSourceStatusSchema>;
export type CredentialTestResult = z.infer<typeof testResponseSchema>["data"];

export class AdminRequestError extends Error {
  readonly kind: AdminFailureKind;
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;

  constructor(message: string, options: { kind: AdminFailureKind; code: string; status: number; requestId?: string }) {
    super(message);
    this.name = "AdminRequestError";
    this.kind = options.kind;
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

function failureKind(status: number, code: string): AdminFailureKind {
  if (status === 401 && code === "MAINTENANCE_LOGIN_REQUIRED") return "login_required";
  if (status === 503 && code === "MAINTENANCE_DISABLED") return "disabled";
  if (code === "MAINTENANCE_LOCKED") return "locked";
  if (status === 426 || code === "HTTPS_REQUIRED") return "insecure";
  if (status === 400 || code === "INVALID_CREDENTIAL_INPUT" || code === "INVALID_MAINTENANCE_PASSWORD") return "validation";
  if (code.startsWith("UPSTREAM_")) return "upstream";
  return "error";
}

function invalidResponse(status: number) {
  return new AdminRequestError("维护服务返回了无法识别的内容", {
    kind: "error",
    code: "INVALID_ADMIN_RESPONSE",
    status
  });
}

async function requestJson<T>(path: string, successSchema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
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
    const problem = errorResponseSchema.safeParse(payload);
    if (!problem.success) throw invalidResponse(response.status);
    throw new AdminRequestError(problem.data.error.message, {
      kind: failureKind(response.status, problem.data.error.code),
      code: problem.data.error.code,
      status: response.status,
      requestId: problem.data.error.requestId
    });
  } catch (error) {
    if (error instanceof AdminRequestError) throw error;
    if (callerAborted) throw error;
    if (controller.signal.aborted) {
      throw new AdminRequestError("维护服务响应超时，请检查网络后重试", {
        kind: "error",
        code: "ADMIN_REQUEST_TIMEOUT",
        status: 0
      });
    }
    throw new AdminRequestError("无法连接数据源维护服务，请检查网络后重试", {
      kind: "error",
      code: "ADMIN_NETWORK_ERROR",
      status: 0
    });
  } finally {
    globalThis.clearTimeout(timer);
    init.signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function fetchDataSourceStatus(signal?: AbortSignal) {
  const payload = await requestJson("/api/bi/admin/data-sources/status", statusResponseSchema, { signal });
  return payload.data;
}

export async function loginMaintenance(password: string) {
  const payload = await requestJson("/api/bi/admin/auth/login", loginResponseSchema, {
    method: "POST",
    body: JSON.stringify({ password })
  });
  return payload.data;
}

export async function logoutMaintenance() {
  const payload = await requestJson("/api/bi/admin/auth/logout", logoutResponseSchema, { method: "POST" });
  return payload.data;
}

export async function testDataSource(site: CredentialSite, token?: string) {
  const payload = await requestJson("/api/bi/admin/data-sources/test", testResponseSchema, {
    method: "POST",
    body: JSON.stringify(token === undefined ? { site } : { site, token })
  });
  if (payload.data.site !== site) throw invalidResponse(200);
  return payload.data;
}

export async function updateDataSourceToken(site: CredentialSite, token: string) {
  const payload = await requestJson("/api/bi/admin/data-sources/token", updateResponseSchema, {
    method: "PUT",
    body: JSON.stringify({ site, token })
  });
  if (payload.data.site !== site) throw invalidResponse(200);
  return payload.data;
}
