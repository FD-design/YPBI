import { describe, expect, test } from "bun:test";
import { aggregateBiV1MetricDays, biV1MetricKey, queryBiV1Metrics, type BiV1MetricCode, type BiV1MetricDataStatus } from "./bi-v1.metrics-adapter";

const makeRow = (metricCode: BiV1MetricCode, unit: "count" | "ratio", value: number | null, numerator: number, denominator: number, dimensions: Record<string, unknown> = {}, dataStatus: BiV1MetricDataStatus = "READY") => ({
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
      makeRow("M005", "ratio", 20 / 60, 20, 60),
      makeRow("M103", "ratio", 3 / 5, 3, 5)
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003", "M005", "M103"] });
    expect(result[0].metrics.M003).toMatchObject({ state: "available", value: 20, numerator: 20, denominator: 0, unit: "count" });
    expect(result[0].metrics.M005).toMatchObject({ state: "available", value: 20 / 60, numerator: 20, denominator: 60, unit: "ratio" });
    expect(result[0].metrics.M103).toMatchObject({ state: "available", value: 3 / 5, numerator: 3, denominator: 5, unit: "ratio" });
  });

  test("未知维度行不在 BI 内擅自求和", () => {
    const result = aggregateBiV1MetricDays(message([
      makeRow("M003", "count", 12, 12, 0, { channel: "a" }),
      makeRow("M003", "count", 8, 8, 0, { channel: "b" })
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003"] });
    expect(result[0].metrics.M003).toMatchObject({ state: "invalid_value", dataStatus: null, value: null });
    expect(result[0].metrics[biV1MetricKey("M003", { channel: "a" })]).toMatchObject({ state: "available", value: 12 });
    expect(result[0].metrics[biV1MetricKey("M003", { channel: "b" })]).toMatchObject({ state: "available", value: 8 });
  });

  test("总体与交叉维度独立返回，字段名别名不改变业务切片", () => {
    const result = aggregateBiV1MetricDays(message([
      makeRow("M016", "count", 10, 10, 0),
      makeRow("M016", "count", 4, 4, 0, { clientPlatform: "Android", userType: "old_user" }),
      makeRow("M016", "count", 3, 3, 0, { platform: "iOS", audience: "老用户" }),
      makeRow("M020", "ratio", .6, 6, 10, { d0Platform: "Android" }),
      makeRow("M113", "count", 2, 2, 0, { payment_method: "ali_pay" })
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016", "M020", "M113"] });
    expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 10 });
    expect(result[0].metrics[biV1MetricKey("M016", ["android", "old"])]).toMatchObject({ state: "available", value: 4 });
    expect(result[0].metrics[biV1MetricKey("M016", ["ios", "old"])]).toMatchObject({ state: "available", value: 3 });
    expect(result[0].metrics[biV1MetricKey("M020", ["android"])]).toMatchObject({ state: "available", value: .6, numerator: 6, denominator: 10 });
    expect(result[0].metrics[biV1MetricKey("M113", ["alipay"])]).toMatchObject({ state: "available", value: 2 });
  });

  test("只把对应字段的合法值映射为已登记切片，未知字段与错配值独立保留", () => {
    const rows = [
      makeRow("M016", "count", 20, 20, 0),
      makeRow("M016", "count", 8, 8, 0, { clientPlatform: "android" }),
      makeRow("M016", "count", 6, 6, 0, { channel: "android" }),
      makeRow("M016", "count", 5, 5, 0, { videoType: "android" }),
      makeRow("M016", "count", 4, 4, 0, { userType: "old" }),
      makeRow("M016", "count", 3, 3, 0, { clientPlatform: "old" }),
      makeRow("M016", "count", 2, 2, 0, { channel: "android+old" }),
      makeRow("M016", "count", 1, 1, 0, { clientPlatform: "android", channel: "old" }),
      makeRow("M113", "count", 9, 9, 0, { payment_method: "alipay" }),
      makeRow("M113", "count", 7, 7, 0, { channel: "alipay" })
    ];
    const result = aggregateBiV1MetricDays(message(rows), {
      pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016", "M113"]
    });
    expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 20 });
    expect(result[0].metrics[biV1MetricKey("M016", ["android"])]).toMatchObject({ state: "available", value: 8 });
    expect(result[0].metrics[biV1MetricKey("M016", ["old"])]).toMatchObject({ state: "available", value: 4 });
    expect(result[0].metrics[biV1MetricKey("M016", ["android", "old"])]).toBeUndefined();
    expect(result[0].metrics[biV1MetricKey("M113", ["alipay"])]).toMatchObject({ state: "available", value: 9 });
    for (const row of rows) {
      expect(result[0].metrics[biV1MetricKey(row.metricCode, row.dimensions)]).toMatchObject({ state: "available", value: row.value });
    }
  });

  test("空值和非字符串维度不变成总体，也不通过字符串转换命中业务切片", () => {
    const dimensions: Record<string, unknown>[] = [
      { channel: "" }, { channel: null }, { clientPlatform: " " }, { clientPlatform: null },
      { clientPlatform: ["android"] }, { clientPlatform: "unknown" },
      { clientPlatform: "android", channel: "" }
    ];
    for (const dimension of dimensions) {
      const result = aggregateBiV1MetricDays(message([
        makeRow("M016", "count", 12, 12, 0),
        makeRow("M016", "count", 3, 3, 0, dimension)
      ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016"] });
      expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 12 });
      expect(result[0].metrics[biV1MetricKey("M016", ["android"])]).toBeUndefined();
      const dimensionOnly = aggregateBiV1MetricDays(message([
        makeRow("M016", "count", 3, 3, 0, dimension)
      ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016"] });
      expect(dimensionOnly[0].metrics.M016).toMatchObject({ state: "invalid_value", value: null });
    }
  });

  test("字段别名、合法值别名与维度顺序继续匹配同一切片", () => {
    expect(biV1MetricKey("M016", { userCohort: "老用户", platform: "Android" }))
      .toBe(biV1MetricKey("M016", { clientPlatform: "android", userType: "old_user" }));
    expect(biV1MetricKey("M008", { registerPlatform: "iOS" })).toBe(biV1MetricKey("M008", ["ios"]));
    expect(biV1MetricKey("M008", { sourceType: "organic" })).toBe(biV1MetricKey("M008", ["natural"]));
    expect(biV1MetricKey("M020", { acquisitionType: "internal_channel" })).toBe(biV1MetricKey("M020", ["internal"]));
    expect(biV1MetricKey("M016", { audience: "android_old_user" })).toBe(biV1MetricKey("M016", ["android", "old"]));
    expect(biV1MetricKey("M016", { channel: "old", clientPlatform: "android" }))
      .toBe(biV1MetricKey("M016", { clientPlatform: "android", channel: "old" }));
  });

  test("同值未知维度的全局状态不污染已登记切片，重复别名只隔离相应切片", () => {
    const globalRow = (dimensions: Record<string, unknown>, dataStatus: BiV1MetricDataStatus) => ({
      ...makeRow("M016", "count", null, 0, 0, dimensions, dataStatus), businessDate: undefined
    });
    const result = aggregateBiV1MetricDays({ ...message([]), rows: [
      globalRow({ channel: "android" }, "FAILED"),
      globalRow({ videoType: "android" }, "SOURCE_INCOMPLETE"),
      globalRow({ channel: "" }, "PROCESSING"),
      makeRow("M016", "count", 10, 10, 0),
      makeRow("M016", "count", 4, 4, 0, { clientPlatform: "android" }),
      makeRow("M016", "count", 3, 3, 0, { clientPlatform: "ios" }),
      makeRow("M016", "count", 3, 3, 0, { platform: "iOS" })
    ] }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", metricCodes: ["M016"] });
    expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 10 });
    expect(result[0].metrics[biV1MetricKey("M016", ["android"])]).toMatchObject({ state: "available", value: 4 });
    expect(result[0].metrics[biV1MetricKey("M016", ["ios"])]).toMatchObject({ state: "invalid_value", value: null });
    for (const day of result) {
      expect(day.metrics[biV1MetricKey("M016", { channel: "android" })]).toMatchObject({ state: "source_failure", dataStatus: "FAILED", value: null });
      expect(day.metrics[biV1MetricKey("M016", { videoType: "android" })]).toMatchObject({ state: "no_value", dataStatus: "SOURCE_INCOMPLETE", value: null });
    }
    expect(result[1].metrics.M016).toMatchObject({ state: "no_record", dataStatus: null, value: null });
    expect(result[1].metrics[biV1MetricKey("M016", ["android"])]).toBeUndefined();
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
