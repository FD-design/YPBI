import { afterEach, describe, expect, test } from "bun:test";
import {
  M016_AUTHORITY_VERSION,
  M016_METRIC_ID,
  v2ApiErrorSchema,
  v2MetricQuerySuccessSchema,
  type V2MetricQuery
} from "../../../contracts/bi-v2";
import { queryMetric, V2RequestError } from "./client";

const request: V2MetricQuery = {
  metricId: M016_METRIC_ID,
  pid: "PH",
  dateRange: ["2026-09-01", "2026-09-03"],
  grain: "day"
};

const metric = {
  id: M016_METRIC_ID,
  code: "daily_active_user_count" as const,
  name: "日活跃用户数" as const,
  definition: "当天打开并登录产品的去重用户数",
  unit: "人" as const,
  valueType: "integer" as const,
  authority: {
    document: "全站指标体系.md" as const,
    version: M016_AUTHORITY_VERSION,
    validationStatus: "pending_validation" as const,
    statusLabel: "技术称已实现（待验数）" as const
  },
  capabilities: {
    grains: ["day"] as ["day"],
    platformMode: "single_pid" as const,
    dimensions: [] as [],
    filters: [] as [],
    comparisons: [] as []
  }
};

function validResponse() {
  return {
    success: true as const,
    data: {
      metric,
      scope: { pid: "PH", platformName: "Pornhub" },
      grain: "day" as const,
      dateRange: ["2026-09-01", "2026-09-03"] as [string, string],
      seriesStatus: "partial" as const,
      points: [
        { businessDate: "2026-09-01", value: 0, state: "available" as const },
        { businessDate: "2026-09-02", value: 101, state: "available" as const }
      ],
      unavailableDates: [{ businessDate: "2026-09-03", state: "no_record" as const }]
    },
    meta: {
      queryId: "query-test",
      sourceApiIds: ["P_DAY_SUM"],
      fetchedAt: "2026-09-08T00:00:00.000Z",
      validationStatus: "pending_validation" as const,
      watermark: null,
      warnings: ["仍待验数"]
    }
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("V2 运行时响应契约", () => {
  test("接受逐日完整覆盖，并保留真实 0 与无记录", () => {
    expect(v2MetricQuerySuccessSchema.safeParse(validResponse()).success).toBe(true);
  });

  test("拒绝日期缺口、重复日期、负数及状态不一致", () => {
    const missing = validResponse();
    missing.data.points.splice(1, 1);
    expect(v2MetricQuerySuccessSchema.safeParse(missing).success).toBe(false);

    const duplicate = validResponse();
    duplicate.data.unavailableDates[0].businessDate = "2026-09-02";
    expect(v2MetricQuerySuccessSchema.safeParse(duplicate).success).toBe(false);

    const negative = validResponse();
    negative.data.points[0].value = -1;
    expect(v2MetricQuerySuccessSchema.safeParse(negative).success).toBe(false);

    const inconsistent = validResponse();
    inconsistent.data.seriesStatus = "available" as "partial";
    expect(v2MetricQuerySuccessSchema.safeParse(inconsistent).success).toBe(false);
  });

  test("错误响应必须使用闭合错误码并携带非空 requestId", () => {
    expect(v2ApiErrorSchema.safeParse({
      success: false,
      error: { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "暂不可用", requestId: "req-1" }
    }).success).toBe(true);
    expect(v2ApiErrorSchema.safeParse({
      success: false,
      error: { code: "UNKNOWN", message: "暂不可用", requestId: "" }
    }).success).toBe(false);
  });
});

describe("V2 客户端回显校验", () => {
  test("拒绝与原请求 PID 不一致的查询响应", async () => {
    const response = validResponse();
    response.data.scope.pid = "XH";
    globalThis.fetch = async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

    try {
      await queryMetric(request);
      throw new Error("expected queryMetric to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(V2RequestError);
      expect((error as V2RequestError).code).toBe("INVALID_V2_QUERY_RESPONSE");
    }
  });

  test("解析合法错误响应并保留 requestId", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: false,
      error: { code: "V2_UPSTREAM_TIMEOUT", message: "指标数据源响应超时", requestId: "req-timeout" }
    }), {
      status: 504,
      headers: { "content-type": "application/json" }
    });

    try {
      await queryMetric(request);
      throw new Error("expected queryMetric to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(V2RequestError);
      expect((error as V2RequestError).requestId).toBe("req-timeout");
    }
  });
});
