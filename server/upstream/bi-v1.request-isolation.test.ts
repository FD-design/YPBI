import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { UpstreamClient, UpstreamError } from "./client";
import { loadEnv } from "../config/env";
import { canIsolateBiV1Request, isBiV1MetricSelectionRejection } from "./bi-v1.request-isolation";
import { readBiV1MetricDays } from "./bi-v1.metrics-adapter";
import { readBiV1AcquisitionGroups, type AcquisitionGroupMetric } from "./bi-v1.acquisition-adapter";
import type { DailyReadingMetric } from "../../contracts/daily-dashboard";

const selectionMessages = [
  "Unsupported metricCodes: M007", "Unsupported metricCodes: M008",
  "不支持的指标编码 M007", "不支持的指标编码 M008",
  "未知指标", "未知指标 M008", "不支持指标 M008",
  "Unsupported metricCodes: M007；请调整指标编码",
  "Unknown metric code: M999", "Invalid metricCodes: M007, M008",
  "metricCodes M007 are not supported", "Metric M008 is unknown.",
  "指标编码 M008 不存在", "无效的指标代码：M007，M008。",
  "未知指标 M008；不支持指标 M007", "Unsupported metrics: M007\n请检查指标编码"
];
const otherMessages = [
  "Invalid metric query: endDate must be later than startDate",
  "Unsupported metricCodes: access denied",
  "Invalid metric request: startDate must be valid",
  "Invalid metric date range", "metric query unavailable",
  "Unsupported metricCodes: M007; endDate must be later than startDate",
  "Unsupported metricCodes: M007；日期范围无效",
  "Unsupported metricCodes: M007; permission denied",
  "Unsupported metricCodes: M007; access denied",
  "Unsupported metricCodes: M007 because authentication failed",
  "Unsupported metricCodes: M007 (token expired)",
  "Access denied: Unsupported metricCodes: M007",
  "指标查询没有权限，token无效", "指标请求无效：日期范围错误",
  "不支持的指标编码 M007；当前账号无权访问",
  "不支持指标 M007，需要登录", "不支持指标查询的日期范围",
  "未知指标查询范围", "指标编码 M007 未开放给当前账号",
  "Unsupported metricCodes: M007, startDate", "Unsupported dimension: metricCodes",
  "endDate必须晚于startDate", "请调整指标编码", ""
];

describe("bi-v1 显式指标选择拒绝语法", () => {
  for (const message of selectionMessages) for (const [code, status] of [
    ["UPSTREAM_INVALID_REQUEST", 422], ["BI_V1_REQUEST_REJECTED", 400], ["BI_V1_REQUEST_REJECTED", 422]
  ] as const) test(`${code}/${status} 保留 ${message}`, () => {
    const error = new UpstreamError(code, message, status);
    expect(isBiV1MetricSelectionRejection(error)).toBe(true);
    expect(canIsolateBiV1Request(error)).toBe(true);
  });

  for (const message of otherMessages) test(`${message || "空消息"}不属于指标选择拒绝`, () => {
    for (const [code, status] of [["UPSTREAM_INVALID_REQUEST", 422], ["BI_V1_REQUEST_REJECTED", 400]] as const) {
      const error = new UpstreamError(code, message, status);
      expect(isBiV1MetricSelectionRejection(error)).toBe(false);
      expect(canIsolateBiV1Request(error)).toBe(false);
    }
  });

  for (const [code, status] of [
    ["UPSTREAM_AUTH_FAILED", 401], ["UPSTREAM_AUTH_FAILED", 403], ["UPSTREAM_IP_RESTRICTED", 403],
    ["UPSTREAM_RATE_LIMITED", 429], ["UPSTREAM_FAILED", 502], ["UPSTREAM_NETWORK_ERROR", 502],
    ["UPSTREAM_TIMEOUT", 504], ["UPSTREAM_INVALID_REQUEST", 400], ["BI_V1_REQUEST_REJECTED", 500],
    ["BI_V1_SCOPE_CONFLICT", 502]
  ] as const) test(`${code}/${status}保留整路失败边界`, () => {
    const error = new UpstreamError(code, selectionMessages[0], status);
    expect(isBiV1MetricSelectionRejection(error)).toBe(false);
    expect(canIsolateBiV1Request(error)).toBe(false);
  });
  test("通用响应结构错误维持原有隔离能力，普通Error不参与隔离", () => {
    const structural = new UpstreamError("BI_V1_RESPONSE_INVALID", "结构不完整", 502);
    expect(isBiV1MetricSelectionRejection(structural)).toBe(false);
    expect(canIsolateBiV1Request(structural)).toBe(true);
    expect(canIsolateBiV1Request(new Error(selectionMessages[0]))).toBe(false);
  });
});

describe("HTTP 语义近例通过真实Client保持整路失败", () => {
  const metricFor = (id: AcquisitionGroupMetric): DailyReadingMetric => ({ id, name: id, unit: "次",
    definition: "fixture", authorityVersion: "fixture", referenceMetricId: id, formula: null, sourceNote: null,
    inputs: [{ key: "count", name: "次数", unit: "次" }] });
  for (const status of [200, 400, 422]) for (const message of otherMessages.slice(0, 2)) {
    test(`HTTP ${status} ${message}在通用指标和获客分组中均不拆单`, async () => {
      const env = loadEnv({ NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://fixture.invalid", UPSTREAM_X_TOKEN: "fixture-only",
        UPSTREAM_CREDENTIALS_FILE: join(tmpdir(), `bi-isolation-${randomUUID()}.json`) });
      const calls: Record<string, string>[] = [];
      const client = new UpstreamClient(env, async input => {
        const params = Object.fromEntries(new URL(String(input)).searchParams); calls.push(params);
        return new Response(JSON.stringify({ code: 400, err: message }), { status, headers: { "content-type": "application/json" } });
      });
      await expect(readBiV1MetricDays(client, { pid: "PH", startDate: "2020-01-01", endDate: "2020-01-01", metricCodes: ["M001", "M003"] }))
        .rejects.toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422 });
      expect(calls).toHaveLength(1);
      calls.length = 0;
      const groups = await readBiV1AcquisitionGroups(client, { pid: "PH", dateRange: ["2020-01-01", "2020-01-01"] }, metricFor);
      expect(calls).toHaveLength(4);
      expect(groups.channel).toMatchObject({ groups: [], day: { state: "source_failure" }, summary: { state: "source_failure" } });
      expect(groups.downloadPlatform).toMatchObject({ groups: [], day: { state: "source_failure" }, summary: { state: "source_failure" } });
    });
  }
});
