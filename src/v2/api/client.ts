import { z } from "zod";
import {
  coreOverviewQuerySchema,
  coreOverviewQuerySuccessSchema,
  coreOverviewResponseMatchesQuery,
  type CoreOverviewQueryInput
} from "../../../contracts/core-overview";
import {
  v2ApiErrorSchema,
  v2MetricCatalogSuccessSchema,
  v2MetricDefinitionsSuccessSchema,
  v2MetricQuerySuccessSchema,
  v2PlatformCatalogSuccessSchema,
  type V2MetricQuery
} from "../../../contracts/bi-v2";
import { notifyAuthenticationRequired } from "./authEvents";
import { dailyDashboardCatalogSchema, dailyDashboardSuccessSchema, dailyDashboardMatchesQuery, type DailyDashboardQuery } from "../../../contracts/daily-dashboard";

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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function metricDefinitionsContentHashIsValid(payload: z.infer<typeof v2MetricDefinitionsSuccessSchema>) {
  const { contentSha256, ...snapshot } = payload.data.snapshot;
  const hashInput = {
    snapshot,
    categories: payload.data.categories,
    items: payload.data.items
  };
  return await sha256(JSON.stringify(canonicalize(hashInput))) === contentSha256;
}

async function parseResponse<T>(response: Response, successSchema: z.ZodType<T>): Promise<T> {
  if (response.status === 401) notifyAuthenticationRequired();
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

export async function fetchReadableDashboards(signal?: AbortSignal) {
  const response = await fetch("/api/bi/v2/catalog/readable-dashboards", { signal, cache: "no-store", credentials: "same-origin" });
  return (await parseResponse(response, dailyDashboardCatalogSchema)).data;
}

export async function fetchDailyDashboard(query: DailyDashboardQuery, metricIds: readonly string[], signal?: AbortSignal) {
  const response = await fetch("/api/bi/v2/queries/dashboards/daily-reading", { method: "POST", signal, cache: "no-store", credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(query) });
  const result = await parseResponse(response, dailyDashboardSuccessSchema);
  if (!dailyDashboardMatchesQuery(result, query, metricIds)) throw invalidResponse(response.status);
  return result;
}

export async function fetchMetricDefinitions(signal?: AbortSignal) {
  const response = await fetch("/api/bi/v2/catalog/metric-definitions", {
    signal,
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" }
  });
  const payload = await parseResponse(response, v2MetricDefinitionsSuccessSchema);
  if (!await metricDefinitionsContentHashIsValid(payload)) throw invalidResponse(response.status);
  return payload.data;
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

export async function queryCoreOverview(request: CoreOverviewQueryInput, signal?: AbortSignal) {
  const parsedRequest = coreOverviewQuerySchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new V2RequestError("核心经营总览查询参数不合法", {
      kind: "error",
      code: "INVALID_CORE_OVERVIEW_QUERY",
      status: 400
    });
  }
  const response = await fetch("/api/bi/v2/queries/dashboards/core-overview", {
    method: "POST",
    signal,
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(parsedRequest.data)
  });
  const payload = await parseResponse(response, coreOverviewQuerySuccessSchema);
  if (!coreOverviewResponseMatchesQuery(payload, parsedRequest.data)) {
    throw new V2RequestError("核心经营总览查询回显与请求不一致", {
      kind: "error",
      code: "INVALID_CORE_OVERVIEW_QUERY_RESPONSE",
      status: response.status
    });
  }
  return payload;
}
