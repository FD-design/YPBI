import { z } from "zod";
import {
  v2ApiErrorSchema,
  v2MetricCatalogSuccessSchema,
  v2MetricQuerySuccessSchema,
  v2PlatformCatalogSuccessSchema,
  type V2MetricQuery
} from "../../../contracts/bi-v2";

export type V2FailureKind = "identity_unavailable" | "unauthenticated" | "forbidden" | "error";

export class V2RequestError extends Error {
  readonly kind: V2FailureKind;
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;

  constructor(message: string, options: { kind: V2FailureKind; code: string; status: number; requestId?: string }) {
    super(message);
    this.name = "V2RequestError";
    this.kind = options.kind;
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

function failureKind(status: number, code: string): V2FailureKind {
  if (code === "IDENTITY_PROVIDER_UNAVAILABLE") return "identity_unavailable";
  if (status === 401 || code === "AUTHENTICATION_REQUIRED") return "unauthenticated";
  if (status === 403 || code === "PID_ACCESS_DENIED") return "forbidden";
  return "error";
}

function invalidResponse(status: number) {
  return new V2RequestError("数据服务返回了无法识别的内容", {
    kind: "error",
    code: "INVALID_V2_RESPONSE",
    status
  });
}

async function parseResponse<T>(response: Response, successSchema: z.ZodType<T>): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw invalidResponse(response.status);
  }
  if (response.ok) {
    const parsedSuccess = successSchema.safeParse(payload);
    if (!parsedSuccess.success) throw invalidResponse(response.status);
    return parsedSuccess.data;
  }
  const parsedProblem = v2ApiErrorSchema.safeParse(payload);
  if (!parsedProblem.success) throw invalidResponse(response.status);
  const problem = parsedProblem.data;
  const code = problem.error.code;
  throw new V2RequestError(problem.error.message, {
      kind: failureKind(response.status, code),
      code,
      status: response.status,
      requestId: problem.error.requestId
  });
}

async function getCatalog<T>(path: string, schema: z.ZodType<{ success: true; data: { items: T[] } }>, signal?: AbortSignal) {
  const response = await fetch(path, { signal, cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } });
  const payload = await parseResponse(response, schema);
  return payload.data.items;
}

export function fetchMetricCatalog(signal?: AbortSignal) {
  return getCatalog("/api/bi/v2/catalog/metrics", v2MetricCatalogSuccessSchema, signal);
}

export function fetchPlatformCatalog(signal?: AbortSignal) {
  return getCatalog("/api/bi/v2/catalog/platforms", v2PlatformCatalogSuccessSchema, signal);
}

export async function queryMetric(request: V2MetricQuery, signal?: AbortSignal) {
  const response = await fetch("/api/bi/v2/queries/metrics", {
    method: "POST",
    signal,
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  const payload = await parseResponse(response, v2MetricQuerySuccessSchema);
  const responseRange = payload.data.dateRange;
  if (
    payload.data.metric.id !== request.metricId
    || payload.data.scope.pid !== request.pid
    || payload.data.grain !== request.grain
    || responseRange[0] !== request.dateRange[0]
    || responseRange[1] !== request.dateRange[1]
  ) {
    throw new V2RequestError("查询服务回显与请求不一致", { kind: "error", code: "INVALID_V2_QUERY_RESPONSE", status: response.status });
  }
  return payload;
}
