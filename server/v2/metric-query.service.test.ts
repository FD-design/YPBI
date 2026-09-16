import { describe, expect, test } from "bun:test";
import type { M016Source, M016SourceResult } from "./m016-source";
import { projectLegacyV2MetricCatalog } from "./catalog";
import { getV2MetricDefinition } from "./metric-definitions";
import { V2MetricQueryError, V2MetricQueryService } from "./metric-query.service";
import { createMetricWatermarkSourceRegistry } from "./metric-watermark-source-registry";

const M016_TEST_COMPLETION_STATUS_API = "/api/test/metric-completion/M016";
const registeredTestWatermarkSources = createMetricWatermarkSourceRegistry([{
  metricId: "M016",
  sourceKind: "upstream_completion_api",
  sourceApiId: M016_TEST_COMPLETION_STATUS_API
}]);

const query = {
  metricId: "M016" as const,
  pid: "PH",
  dateRange: ["2026-09-01", "2026-09-03"] as [string, string],
  grain: "day" as const
};

const trustedWatermark: NonNullable<M016SourceResult["watermark"]> = {
  type: "complete_through_business_date",
  completeThrough: "2026-09-03",
  timeZone: "Asia/Shanghai",
  pid: "PH",
  sourceApiId: M016_TEST_COMPLETION_STATUS_API,
  sourceKind: "upstream_completion_api",
  observedAt: "2026-09-04T00:10:00+08:00"
};

function sourceResult(
  rows: M016SourceResult["rows"],
  watermark: M016SourceResult["watermark"] = null
): M016SourceResult {
  return { rows, watermark };
}

const currentDefinition = getV2MetricDefinition("M016");
if (!currentDefinition) throw new Error("测试目录缺少 M016");
const configuredDefinition = structuredClone(currentDefinition);
configuredDefinition.authority.version = "v0.23-draft";
configuredDefinition.ypbiMapping.status = "configured";
configuredDefinition.analysis = { status: "unavailable", reasonCodes: ["validation_not_passed"] };
// Explicit test dependencies exercise row and watermark handling independently of release admission.
const currentMetric = projectLegacyV2MetricCatalog([configuredDefinition])[0];
if (!currentMetric) throw new Error("测试样例映射不匹配");
const configuredMapping = { executable: true, version: "m016-pday-sum-v1" };
const passedMetric = {
  ...currentMetric,
  authority: {
    ...currentMetric.authority,
    validationStatus: "passed" as const,
    statusLabel: "真实验数已通过" as const
  }
};

function passedService(source: M016Source) {
  return new V2MetricQueryService(source, "passed", () => passedMetric, registeredTestWatermarkSources, configuredMapping);
}

function configuredService(source: M016Source, validationStatus: "pending_validation" | "passed" = "pending_validation") {
  return new V2MetricQueryService(source, validationStatus, () => currentMetric, undefined, configuredMapping);
}

describe("V2MetricQueryService", () => {
  test("真实发布映射过期时默认服务拒绝查询且不调用上游", async () => {
    let sourceCalls = 0;
    const source: M016Source = { queryDailyActiveUsers: async () => { sourceCalls += 1; return sourceResult([]); } };
    await expect(new V2MetricQueryService(source).execute(query)).rejects.toMatchObject({
      code: "UNSUPPORTED_V2_METRIC_QUERY", statusCode: 422
    });
    await expect(new V2MetricQueryService(source, "passed", () => passedMetric).execute(query)).rejects.toMatchObject({
      code: "UNSUPPORTED_V2_METRIC_QUERY", statusCode: 422
    });
    expect(sourceCalls).toBe(0);
  });

  test("未开放指标由能力层返回 422，而不是把它当成格式错误", async () => {
    const source: M016Source = { queryDailyActiveUsers: async () => sourceResult([]) };
    await expect(new V2MetricQueryService(source).execute({ ...query, metricId: "M999" })).rejects.toMatchObject({
      code: "UNSUPPORTED_V2_METRIC_QUERY",
      statusCode: 422
    } satisfies Partial<V2MetricQueryError>);
  });

  test("指标目录与查询准入状态不一致时在调用接口前失败关闭", async () => {
    let sourceCalls = 0;
    const source: M016Source = {
      queryDailyActiveUsers: async () => {
        sourceCalls += 1;
        return sourceResult([]);
      }
    };
    await expect(configuredService(source, "passed").execute(query)).rejects.toMatchObject({
      code: "V2_METRIC_SOURCE_CONFLICT",
      statusCode: 502,
      details: { reason: "validation_status_conflict" }
    } satisfies Partial<V2MetricQueryError>);
    expect(sourceCalls).toBe(0);
  });

  test("保留真实 0，并把未返回日期标记为 no_record 而不是补 0", async () => {
    const source: M016Source = {
      queryDailyActiveUsers: async () => sourceResult([
        { businessDate: "2026-09-01", pid: "PH", value: 0 },
        { businessDate: "2026-09-02", pid: "PH", value: 21 }
      ])
    };
    const result = await configuredService(source).execute(query);
    expect(result.data.seriesStatus).toBe("partial");
    expect(result.data.points).toEqual([
      { businessDate: "2026-09-01", value: 0, state: "available" },
      { businessDate: "2026-09-02", value: 21, state: "available" }
    ]);
    expect(result.data.unavailableDates).toEqual([{ businessDate: "2026-09-03", state: "no_record" }]);
    expect(result.meta).toMatchObject({
      mappingVersion: "m016-pday-sum-v1",
      validationStatus: "pending_validation",
      watermark: null
    });
    expect(result.meta.warnings).toContain("上游尚未提供正式数据水位，当前响应不推断成熟日期。");
  });

  test("验数通过后缺少可信水位会失败关闭，不把上游值返回为正式结果", async () => {
    let sourceCalls = 0;
    const source: M016Source = {
      queryDailyActiveUsers: async () => {
        sourceCalls += 1;
        return sourceResult([{ businessDate: "2026-09-01", pid: "PH", value: 17 }]);
      }
    };

    await expect(passedService(source).execute(query)).rejects.toMatchObject({
      code: "METRIC_NOT_READY",
      statusCode: 422,
      message: "M016 尚无可信数据水位，正式指标分析暂未开放"
    } satisfies Partial<V2MetricQueryError>);
    expect(sourceCalls).toBe(1);
  });

  test("验数通过且接口水位覆盖所选范围时返回正式结果", async () => {
    const source: M016Source = {
      queryDailyActiveUsers: async () => sourceResult([
        { businessDate: "2026-09-01", pid: "PH", value: 17 },
        { businessDate: "2026-09-02", pid: "PH", value: 18 },
        { businessDate: "2026-09-03", pid: "PH", value: 19 }
      ], trustedWatermark)
    };
    const result = await passedService(source).execute(query);
    expect(result.meta.watermark).toEqual(trustedWatermark);
    expect(result.meta.sourceApiIds).toEqual([
      "/api/admin/statistics/pDaySum",
      M016_TEST_COMPLETION_STATUS_API
    ]);
    expect(result.meta.warnings).not.toContain("上游尚未提供正式数据水位，当前响应不推断成熟日期。");
  });

  test("生产登记为空时拒绝测试完成状态来源，不能因契约支持对象而自动放行", async () => {
    const source: M016Source = {
      queryDailyActiveUsers: async () => sourceResult([
        { businessDate: "2026-09-01", pid: "PH", value: 17 },
        { businessDate: "2026-09-02", pid: "PH", value: 18 },
        { businessDate: "2026-09-03", pid: "PH", value: 19 }
      ], trustedWatermark)
    };
    await expect(new V2MetricQueryService(source, "passed", () => passedMetric, undefined, configuredMapping).execute(query)).rejects.toMatchObject({
      code: "V2_METRIC_SOURCE_CONFLICT",
      statusCode: 502,
      details: { reason: "unregistered_watermark_source" }
    } satisfies Partial<V2MetricQueryError>);
  });

  test("查询结束日晚于接口水位时返回 422，不静默截断", async () => {
    const source: M016Source = {
      queryDailyActiveUsers: async () => sourceResult([
        { businessDate: "2026-09-01", pid: "PH", value: 17 }
      ], { ...trustedWatermark, completeThrough: "2026-09-02", observedAt: "2026-09-03T00:10:00+08:00" })
    };
    await expect(passedService(source).execute(query)).rejects.toMatchObject({
      code: "METRIC_NOT_READY",
      statusCode: 422,
      message: "M016 数据仅完整至 2026-09-02，所选结束日尚未就绪"
    } satisfies Partial<V2MetricQueryError>);
  });

  test("水位 PID 或登记三元组与查询不一致时按上游冲突拒绝", async () => {
    for (const watermark of [
      { ...trustedWatermark, pid: "TT" },
      { ...trustedWatermark, sourceApiId: "/api/admin/statistics/unregisteredCompletion" },
      { ...trustedWatermark, sourceKind: "upstream_explicit" as const },
      {
        ...trustedWatermark,
        sourceKind: "upstream_explicit" as const,
        sourceApiId: "/api/admin/statistics/pDaySum"
      }
    ]) {
      const source: M016Source = {
        queryDailyActiveUsers: async () => sourceResult([], watermark)
      };
      await expect(passedService(source).execute(query)).rejects.toMatchObject({
        code: "V2_METRIC_SOURCE_CONFLICT",
        statusCode: 502
      } satisfies Partial<V2MetricQueryError>);
    }
  });

  test("来源登记必须精确绑定 metricId、sourceKind 与 sourceApiId", async () => {
    const mismatchedRegistries = [
      createMetricWatermarkSourceRegistry([{
        metricId: "M999",
        sourceKind: trustedWatermark.sourceKind,
        sourceApiId: trustedWatermark.sourceApiId
      }]),
      createMetricWatermarkSourceRegistry([{
        metricId: query.metricId,
        sourceKind: "upstream_explicit",
        sourceApiId: trustedWatermark.sourceApiId
      }]),
      createMetricWatermarkSourceRegistry([{
        metricId: query.metricId,
        sourceKind: trustedWatermark.sourceKind,
        sourceApiId: "/api/test/metric-completion/other"
      }])
    ];
    for (const registry of mismatchedRegistries) {
      const source: M016Source = {
        queryDailyActiveUsers: async () => sourceResult([], trustedWatermark)
      };
      await expect(new V2MetricQueryService(source, "passed", () => passedMetric, registry, configuredMapping).execute(query)).rejects.toMatchObject({
        code: "V2_METRIC_SOURCE_CONFLICT",
        statusCode: 502,
        details: { reason: "unregistered_watermark_source" }
      } satisfies Partial<V2MetricQueryError>);
    }
  });

  test("运行时拒绝结构畸形的水位对象", async () => {
    const source: M016Source = {
      queryDailyActiveUsers: async () => ({
        rows: [],
        watermark: {
          ...trustedWatermark,
          completeThrough: "not-a-date"
        }
      } as unknown as M016SourceResult)
    };
    await expect(passedService(source).execute(query)).rejects.toMatchObject({
      code: "V2_METRIC_SOURCE_CONFLICT",
      statusCode: 502,
      details: { reason: "invalid_watermark" }
    } satisfies Partial<V2MetricQueryError>);
  });

  test("运行时拒绝明显晚于查询时间的水位取证时间", async () => {
    const source: M016Source = {
      queryDailyActiveUsers: async () => sourceResult([], {
        ...trustedWatermark,
        observedAt: "2099-09-04T00:10:00+08:00"
      })
    };
    await expect(passedService(source).execute(query)).rejects.toMatchObject({
      code: "V2_METRIC_SOURCE_CONFLICT",
      statusCode: 502,
      details: { reason: "watermark_observed_in_future" }
    } satisfies Partial<V2MetricQueryError>);
  });

  test("已登记的独立完成状态接口会进入来源追溯", async () => {
    const completionApiWatermark: NonNullable<M016SourceResult["watermark"]> = {
      ...trustedWatermark,
      sourceApiId: M016_TEST_COMPLETION_STATUS_API
    };
    const source: M016Source = {
      queryDailyActiveUsers: async () => sourceResult([
        { businessDate: "2026-09-01", pid: "PH", value: 17 },
        { businessDate: "2026-09-02", pid: "PH", value: 18 },
        { businessDate: "2026-09-03", pid: "PH", value: 19 }
      ], completionApiWatermark)
    };
    const result = await passedService(source).execute(query);
    expect(result.meta.sourceApiIds).toEqual([
      "/api/admin/statistics/pDaySum",
      M016_TEST_COMPLETION_STATUS_API
    ]);
  });

  test("字段为空与整日无记录使用不同状态", async () => {
    const source: M016Source = {
      queryDailyActiveUsers: async () => sourceResult([{ businessDate: "2026-09-01", pid: "PH", value: null }])
    };
    const result = await configuredService(source).execute(query);
    expect(result.data.seriesStatus).toBe("no_values");
    expect(result.data.unavailableDates).toEqual([
      { businessDate: "2026-09-01", state: "no_value" },
      { businessDate: "2026-09-02", state: "no_record" },
      { businessDate: "2026-09-03", state: "no_record" }
    ]);
  });

  test("所有业务日均无上游行时使用 no_records", async () => {
    const source: M016Source = { queryDailyActiveUsers: async () => sourceResult([]) };
    const result = await configuredService(source).execute(query);
    expect(result.data.seriesStatus).toBe("no_records");
    expect(result.data.unavailableDates.every((item) => item.state === "no_record")).toBe(true);
  });

  test("同一 PID 同一业务日多行时拒绝擅自合并", async () => {
    const source: M016Source = {
      queryDailyActiveUsers: async () => sourceResult([
        { businessDate: "2026-09-01", pid: "PH", value: 10 },
        { businessDate: "2026-09-01", pid: "PH", value: 11 }
      ])
    };
    await expect(configuredService(source).execute(query)).rejects.toMatchObject({
      code: "V2_METRIC_SOURCE_CONFLICT",
      statusCode: 502
    } satisfies Partial<V2MetricQueryError>);
  });

  test("上游返回错误 PID 或范围外日期时停止查询而不是静默忽略", async () => {
    for (const row of [
      { businessDate: "2026-09-01", pid: "TT", value: 10 },
      { businessDate: "2026-08-31", pid: "PH", value: 10 }
    ]) {
      const source: M016Source = { queryDailyActiveUsers: async () => sourceResult([row]) };
      await expect(configuredService(source).execute(query)).rejects.toMatchObject({
        code: "V2_METRIC_SOURCE_CONFLICT",
        statusCode: 502
      } satisfies Partial<V2MetricQueryError>);
    }
  });
});
