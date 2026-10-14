import { UpstreamError } from "../upstream/client";

const SOURCE_READ_ERROR_CODES = [
  "UPSTREAM_AUTH_FAILED",
  "UPSTREAM_IP_RESTRICTED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_NETWORK_ERROR",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_NOT_CONFIGURED",
  "UPSTREAM_PID_NOT_AVAILABLE",
  "UPSTREAM_INVALID_REQUEST",
  "UPSTREAM_FAILED",
  "DATA_PREVIEW_DISABLED",
  "BI_V1_REQUEST_REJECTED",
  "BI_V1_RESPONSE_INVALID",
  "BI_V1_SCOPE_CONFLICT",
  "BI_V1_VALUE_CONFLICT",
  "DAILY_SOURCE_CONFLICT"
] as const;

type SourceReadErrorCode = typeof SOURCE_READ_ERROR_CODES[number] | "unknown";
export type SourceReadErrorCodeCounts = Partial<Record<SourceReadErrorCode, number>>;

export function sourceReadErrorCode(error: unknown): SourceReadErrorCode {
  if (error instanceof UpstreamError) {
    for (const code of SOURCE_READ_ERROR_CODES) {
      if (error.code === code) return code;
    }
  }
  return "unknown";
}
