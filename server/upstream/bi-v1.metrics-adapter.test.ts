import { describe, expect, test } from "bun:test";
import { aggregateBiV1MetricDays, queryBiV1Metrics, type BiV1MetricCode, type BiV1MetricDataStatus } from "./bi-v1.metrics-adapter";

const makeRow = (metricCode: BiV1MetricCode, unit: "count" | "ratio", value: number | null, numerator: number, denominator: number, dimensions: Record<string, string> = {}, dataStatus: BiV1MetricDataStatus = "READY") => ({
  metricCode,
  businessDate: "2026-09-21",
  dimensions: { pid: "PH", ...dimensions },
  value,
  numerator,
  denominator,
  unit,
  dataStatus,
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

  test("异常指标按指标隔离，不影响同批正常指标", () => {
    const count = makeRow("M003", "count", 1, 1, 0, { channel: "a" });
    const duplicate = aggregateBiV1MetricDays(message([count, count, makeRow("M016", "count", 2, 2, 0)]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003", "M016"] });
    expect(duplicate[0].metrics.M003).toMatchObject({ state: "invalid_value", dataStatus: null, value: null });
    expect(duplicate[0].metrics.M016).toMatchObject({ state: "available", value: 2 });

    const badValues = aggregateBiV1MetricDays(message([
      { ...makeRow("M003", "count", 1, 1, 0), value: 1.5, numerator: 1.5 },
      makeRow("M005", "ratio", .5, 1, 3),
      makeRow("M016", "count", 2, 2, 0)
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003", "M005", "M016"] });
    expect(badValues[0].metrics.M003?.state).toBe("invalid_value");
    expect(badValues[0].metrics.M005?.state).toBe("invalid_value");
    expect(badValues[0].metrics.M016).toMatchObject({ state: "available", value: 2 });
  });

  test("未就绪指标携带错误业务值时只忽略该值，正常兄弟指标继续返回", async () => {
    const payload = message([
      makeRow("M001", "count", 120, 120, 0),
      makeRow("M006", "ratio", 15, 15, 100, {}, "SOURCE_INCOMPLETE")
    ]);
    const client = { get: async () => ({ code: 200, msg: payload }) };
    const query = { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M001", "M006"] as const };
    const result = aggregateBiV1MetricDays(await queryBiV1Metrics(client as never, query), query);
    expect(result[0].metrics.M001).toMatchObject({ state: "available", value: 120, dataStatus: "READY" });
    expect(result[0].metrics.M006).toMatchObject({ state: "no_value", value: null, dataStatus: "SOURCE_INCOMPLETE" });
  });
});
