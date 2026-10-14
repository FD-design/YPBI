import { describe, expect, test } from "bun:test";
import { UpstreamError } from "../upstream/client";
import { sourceReadErrorCode } from "./source-read-diagnostics";

describe("private source read error classification", () => {
  test.each([
    "UPSTREAM_AUTH_FAILED", "UPSTREAM_IP_RESTRICTED", "UPSTREAM_TIMEOUT", "UPSTREAM_NETWORK_ERROR",
    "UPSTREAM_RATE_LIMITED", "UPSTREAM_NOT_CONFIGURED", "UPSTREAM_PID_NOT_AVAILABLE", "UPSTREAM_INVALID_REQUEST",
    "UPSTREAM_FAILED", "DATA_PREVIEW_DISABLED", "BI_V1_REQUEST_REJECTED", "BI_V1_RESPONSE_INVALID",
    "BI_V1_SCOPE_CONFLICT", "BI_V1_VALUE_CONFLICT", "DAILY_SOURCE_CONFLICT"
  ])("仅将已知 UpstreamError 错误码 %s 转为固定分类", code => {
    const error = new UpstreamError(code, "secret-token Cookie=password https://secret.example/?filter=private", 502);
    for (const field of ["message", "stack", "statusCode"]) {
      Object.defineProperty(error, field, { get() { throw new Error("private error fields must not be read"); } });
    }
    expect(sourceReadErrorCode(error)).toBe(code);
  });

  test("未知 UpstreamError 及非 UpstreamError 固定归类 unknown", () => {
    for (const error of [
      new UpstreamError("secret-token Cookie=password https://secret.example/?filter=private", "private detail"),
      new UpstreamError("__proto__", "private detail"),
      Object.assign(new Error("private detail"), { code: "UPSTREAM_AUTH_FAILED" }),
      { code: "UPSTREAM_TIMEOUT", message: "private detail" },
      "private detail", null, undefined
    ]) {
      expect(sourceReadErrorCode(error)).toBe("unknown");
    }
  });
});
