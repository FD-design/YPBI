import { describe, expect, test } from "bun:test";
import { aggregateBiV1MetricDays, queryBiV1Metrics, type BiV1MetricCode } from "./bi-v1.metrics-adapter";

const makeRow = (metricCode: BiV1MetricCode, unit: "count" | "ratio", value: number | null, numerator: number, denominator: number, dimensions: Record<string, string> = {}) => ({
  metricCode,
  businessDate: "2026-09-21",
  dimensions: { pid: "PH", ...dimensions },
  value,
  numerator,
  denominator,
  unit,
  dataStatus: "READY" as const,
  metricVersion: "bi-v1" as const,
  ruleVersion: "rule-v1"
});

const message = (rows: ReturnType<typeof makeRow>[]) => ({
  metricVersion: "bi-v1" as const,
  generatedAt: "2026-09-22T10:00:00+08:00",
  watermark: "2026-09-22 10:00:00.000",
  rows
});

describe("bi-v1 通用指标适配", () => {
  test("只消费可直接映射的总体计数与同批比率", () => {
    const result = aggregateBiV1MetricDays(message([
      makeRow("M003", "count", 20, 20, 0),
      makeRow("M005", "ratio", 20 / 60, 20, 60)
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003", "M005"] });
    expect(result[0].metrics.M003).toMatchObject({ state: "available", value: 20, numerator: 20, denominator: 0, unit: "count" });
    expect(result[0].metrics.M005).toMatchObject({ state: "available", value: 20 / 60, numerator: 20, denominator: 60, unit: "ratio" });
  });

  test("未知维度行不在 BI 内擅自求和", () => {
    expect(() => aggregateBiV1MetricDays(message([
      makeRow("M003", "count", 12, 12, 0, { channel: "a" }),
      makeRow("M003", "count", 8, 8, 0, { channel: "b" })
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003"] })).toThrow();
  });

  test("SOURCE_INCOMPLETE 和缺日保持状态，不补0", () => {
    const result = aggregateBiV1MetricDays({ ...message([]), rows: [{
      metricCode: "M016" as const,
      dimensions: { pid: "PH" },
      value: null,
      numerator: 0,
      denominator: 0,
      unit: "count" as const,
      dataStatus: "SOURCE_INCOMPLETE" as const,
      metricVersion: "bi-v1" as const,
      ruleVersion: ""
    }] }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", metricCodes: ["M016", "M026"] });
    expect(result[0].metrics.M016).toMatchObject({ state: "no_value", value: null, dataStatus: "SOURCE_INCOMPLETE" });
    expect(result[1].metrics.M016).toMatchObject({ state: "no_value", value: null, dataStatus: "SOURCE_INCOMPLETE" });
    expect(result[0].metrics.M026).toMatchObject({ state: "no_record", value: null, dataStatus: null });
  });

  test("请求使用排他结束日期并拒绝范围外指标", async () => {
    let params: Record<string, string> = {};
    const client = { get: async (_path: string, query: Record<string, string>) => {
      params = query;
      return { code: 200, msg: message([makeRow("M003", "count", 1, 1, 0)]) };
    } };
    await expect(queryBiV1Metrics(client as never, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016"] })).rejects.toMatchObject({ code: "BI_V1_SCOPE_CONFLICT" });
    expect(params.endDate).toBe("2026-09-22");
    expect(params.metricCodes).toBe("M016");
  });

  test("重复维度、坏计数和比率冲突均失败关闭", () => {
    const count = makeRow("M003", "count", 1, 1, 0, { channel: "a" });
    expect(() => aggregateBiV1MetricDays(message([count, count]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003"] })).toThrow();
    expect(() => aggregateBiV1MetricDays(message([{ ...count, value: 1.5, numerator: 1.5 }]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003"] })).toThrow();
    expect(() => aggregateBiV1MetricDays(message([makeRow("M005", "ratio", .5, 1, 3)]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M005"] })).toThrow();
  });
});
