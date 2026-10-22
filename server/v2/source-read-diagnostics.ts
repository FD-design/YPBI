import { UpstreamError } from "../upstream/client";
import { UPSTREAM_READ_ERROR_CODES, type UpstreamReadErrorCode as SourceReadErrorCode } from "../upstream/read-failure";
export type SourceReadErrorCodeCounts = Partial<Record<SourceReadErrorCode, number>>;

export function sourceReadErrorCode(error: unknown): SourceReadErrorCode {
  if (error instanceof UpstreamError) {
    for (const code of UPSTREAM_READ_ERROR_CODES) {
      if (error.code === code) return code;
    }
  }
  return "unknown";
}
