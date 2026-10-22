export const UPSTREAM_READ_ERROR_CODES = [
  "UPSTREAM_AUTH_FAILED", "UPSTREAM_IP_RESTRICTED", "UPSTREAM_TIMEOUT", "UPSTREAM_NETWORK_ERROR",
  "UPSTREAM_RATE_LIMITED", "UPSTREAM_NOT_CONFIGURED", "UPSTREAM_PID_NOT_AVAILABLE", "UPSTREAM_INVALID_REQUEST",
  "UPSTREAM_FAILED", "DATA_PREVIEW_DISABLED", "BI_V1_REQUEST_REJECTED", "BI_V1_RESPONSE_INVALID",
  "BI_V1_SCOPE_CONFLICT", "BI_V1_VALUE_CONFLICT", "DAILY_SOURCE_CONFLICT"
] as const;
export type UpstreamReadErrorCode = typeof UPSTREAM_READ_ERROR_CODES[number] | "unknown";

export const UPSTREAM_READ_FAILURE_ORIGINS = [
  "source_budget", "consumer_cancelled", "queue_deadline", "http_deadline",
  "http", "business", "network", "validation"
] as const;
export type UpstreamReadFailureOrigin = typeof UPSTREAM_READ_FAILURE_ORIGINS[number];
export interface UpstreamReadFailure {
  readonly origin: UpstreamReadFailureOrigin;
  readonly upstreamHttpStatus?: number;
  readonly upstreamBusinessCode?: number;
}

// Diagnostic metadata never becomes an error's enumerable/public payload.
const failures = new WeakMap<object, Readonly<UpstreamReadFailure>>();
export function rememberUpstreamReadFailure(error: object, input: UpstreamReadFailure): void {
  if (!UPSTREAM_READ_FAILURE_ORIGINS.includes(input.origin)) return;
  const http = input.upstreamHttpStatus;
  const business = input.upstreamBusinessCode;
  failures.set(error, Object.freeze({
    origin: input.origin,
    ...(Number.isInteger(http) && http! >= 100 && http! <= 599 ? { upstreamHttpStatus: http } : {}),
    ...(Number.isSafeInteger(business) && business! >= 0 ? { upstreamBusinessCode: business } : {})
  }));
}
export function getUpstreamReadFailure(error: unknown): Readonly<UpstreamReadFailure> | undefined {
  return error !== null && typeof error === "object" ? failures.get(error) : undefined;
}
