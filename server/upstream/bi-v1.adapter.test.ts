import { describe, expect, test } from "bun:test";
import { aggregateBiV1Playback, queryBiV1Playback, type BiV1MetricRow } from "./bi-v1.adapter";

const row = (metricCode: "M034" | "M036" | "M097", videoType: string, value: number | null, numerator: number, denominator: number): BiV1MetricRow => ({
  metricCode,
  businessDate: "2026-09-21",
  dimensions: { pid: "PH", videoType },
  value,
  numerator,
  denominator,
  unit: metricCode === "M036" ? "ratio" as const : "count" as const,
  dataStatus: "READY" as const,
  metricVersion: "bi-v1" as const,
  ruleVersion: "effective_play_v3"
});

const message = (rows: ReturnType<typeof row>[]) => ({
  metricVersion: "bi-v1" as const,
  generatedAt: "2026-09-22T10:00:00+08:00",
  watermark: "2026-09-22 10:00:00.000",
  rows
});
const query = { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21" };
const group = (videoType = "default", effective = 7, starts = 8) => [
  row("M034", videoType, effective, effective, 0),
  row("M036", videoType, starts ? effective / starts : null, effective, starts),
  row("M097", videoType, starts, starts, 0)
];

describe("bi-v1 adapter", () => {
  test("v3 的 7 次有效观看与 8 次起播保留同批比率及请求范围", async () => {
    const result = await queryBiV1Playback({ get: async (path, params) => {
      expect(path).toBe("/api/admin/bi/v1/playback");
      expect(params).toEqual({ pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", granularity: "day",
        metricCodes: "M034,M036,M097", dimensions: "videoType", includeIncomplete: "true" });
      return { code: 200, msg: { ...message(group()), diagnostics: { complete: true } } };
    } }, query);
    const points = aggregateBiV1Playback(result, query)[0].metrics;
    expect(points.M034).toMatchObject({ state: "available", value: 7 });
    expect(points.M097).toMatchObject({ state: "available", value: 8 });
    expect(points.M036).toMatchObject({ state: "available", value: 7 / 8, numerator: 7, denominator: 8 });
  });

  for (const ruleVersion of ["effective_play_v2", "", undefined]) {
    test(`有效观看规则 ${ruleVersion ?? "缺失"} 不进入结果，起播独立保留`, async () => {
      const rows = group().map(item => item.metricCode === "M097" ? { ...item, ruleVersion: "successful-start-v1" } : { ...item, ruleVersion });
      const parsed = await queryBiV1Playback({ get: async () => ({ code: 200, msg: message(rows) }) }, query);
      const points = aggregateBiV1Playback(parsed, query)[0].metrics;
      for (const code of ["M034", "M036"] as const) expect(points[code]).toMatchObject({ state: "invalid_value", value: null, numerator: null, denominator: null });
      expect(points.M097).toMatchObject({ state: "available", value: 8 });
    });
  }

  test("同一组或不同视频类型的有效规则混用均不产生总体有效结果", () => {
    const cases = [
      group().map(item => item.metricCode === "M036" ? { ...item, ruleVersion: "effective_play_v2" } : item),
      [...group(), ...group("long_video", 1, 2).map(item => ({ ...item, ruleVersion: "effective_play_v2" }))]
    ];
    for (const rows of cases) {
      const points = aggregateBiV1Playback(message(rows), query)[0].metrics;
      expect(points.M034.state).toBe("invalid_value");
      expect(points.M036.state).toBe("invalid_value");
      expect(points.M097).toMatchObject({ state: "available", value: rows.length === 3 ? 8 : 10 });
    }
  });

  test("跨日旧规则结果不进入可汇总的有效观看序列", () => {
    const rows = [...group(), ...group().map(item => ({ ...item, businessDate: "2026-09-22", ruleVersion: "effective_play_v2" }))];
    const days = aggregateBiV1Playback(message(rows), { ...query, endDate: "2026-09-22" });
    expect(days.map(day => day.metrics.M034.state)).toEqual(["available", "invalid_value"]);
    expect(days.map(day => day.metrics.M097.value)).toEqual([8, 8]);
  });

  for (const [field, value] of [["videoId", "v-1"], ["clientPlatform", "android"], ["channel", "a"], ["futureDimension", "x"]]) {
    test(`未请求的 ${field} 切片不能作为总体`, async () => {
      const rows = group().map(item => ({ ...item, dimensions: { ...item.dimensions, [field]: value } }));
      await expect(queryBiV1Playback({ get: async () => ({ code: 200, msg: message(rows) }) }, query)).rejects.toMatchObject({ code: "BI_V1_SCOPE_CONFLICT" });
      expect(() => aggregateBiV1Playback(message(rows), query)).toThrow("未请求的分组维度");
    });
  }

  test("总体与类型分组同时返回时不重复累加", () => {
    const overall = group().map(item => ({ ...item, dimensions: { pid: "PH" } }));
    expect(() => aggregateBiV1Playback(message([...overall, ...group()]), query)).toThrow("不能混合汇总");
  });

  test("v3 真实 0 次和 0/0 保留为不同状态", () => {
    const points = aggregateBiV1Playback(message(group("default", 0, 0)), query)[0].metrics;
    expect(points.M034).toMatchObject({ state: "available", value: 0 });
    expect(points.M097).toMatchObject({ state: "available", value: 0 });
    expect(points.M036).toMatchObject({ state: "zero_denominator", value: null, numerator: 0, denominator: 0 });
  });

  for (const [dataStatus, state] of [["SOURCE_INCOMPLETE", "no_value"], ["PROCESSING", "no_value"], ["NOT_MATURE", "immature"], ["FAILED", "source_failure"]] as const) {
    test(`${dataStatus} 无规则版本保留来源状态并清空输入`, async () => {
      const rows = group().map(item => ({ ...item, value: null, ruleVersion: undefined, dataStatus }));
      const parsed = await queryBiV1Playback({ get: async () => ({ code: 200, msg: message(rows) }) }, query);
      const points = aggregateBiV1Playback(parsed, query)[0].metrics;
      for (const point of Object.values(points)) expect(point).toEqual({ dataStatus, state, value: null, numerator: null, denominator: null });
    });
  }

  test("按视频类型汇总计数并用总分子总分母计算有效观影率", () => {
    const result = aggregateBiV1Playback(message([
      row("M034", "default", 27, 27, 0), row("M036", "default", 27 / 89, 27, 89), row("M097", "default", 89, 89, 0),
      row("M034", "long_video", 6, 6, 0), row("M036", "long_video", 6 / 9, 6, 9), row("M097", "long_video", 9, 9, 0)
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21" });

    expect(result[0].metrics.M034.value).toBe(33);
    expect(result[0].metrics.M097.value).toBe(98);
    expect(result[0].metrics.M036).toMatchObject({ value: 33 / 98, numerator: 33, denominator: 98, state: "available" });
  });

  test("缺日保持无记录，未接通状态不转换为0", () => {
    const result = aggregateBiV1Playback({ ...message([]), rows: [{
      metricCode: "M034", dimensions: { pid: "PH" }, value: null, numerator: 0, denominator: 0,
      unit: "count", dataStatus: "SOURCE_INCOMPLETE", metricVersion: "bi-v1", ruleVersion: ""
    }, {
      metricCode: "M036", dimensions: { pid: "PH" }, value: null, numerator: 0, denominator: 0,
      unit: "ratio", dataStatus: "SOURCE_INCOMPLETE", metricVersion: "bi-v1", ruleVersion: ""
    }, {
      metricCode: "M097", dimensions: { pid: "PH" }, value: null, numerator: 0, denominator: 0,
      unit: "count", dataStatus: "SOURCE_INCOMPLETE", metricVersion: "bi-v1", ruleVersion: ""
    }] }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22" });
    expect(result).toHaveLength(2);
    expect(result.every((day) => day.metrics.M034.value === null && day.metrics.M034.dataStatus === "SOURCE_INCOMPLETE")).toBe(true);
  });

  test("业务 code 非200即使HTTP成功也拒绝", async () => {
    const client = { get: async () => ({ code: 400, err: "当前账号没有 TT 权限" }) };
    await expect(queryBiV1Playback(client as never, { pid: "TT", startDate: "2026-09-21", endDate: "2026-09-21" })).rejects.toMatchObject({ code: "BI_V1_REQUEST_REJECTED" });
  });

  test("PID回显、重复维度和分子分母冲突均失败关闭", () => {
    const valid = [
      row("M034", "default", 1, 1, 0), row("M036", "default", 0.5, 1, 2), row("M097", "default", 2, 2, 0)
    ];
    expect(() => aggregateBiV1Playback({ ...message(valid), rows: [...valid, valid[0]] }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21" })).toThrow();
    expect(() => aggregateBiV1Playback(message(valid.map((item) => ({ ...item, dimensions: { ...item.dimensions, pid: "TT" } }))), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21" })).toThrow();
    expect(() => aggregateBiV1Playback(message(valid.map((item) => item.metricCode === "M036" ? { ...item, numerator: 2 } : item)), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21" })).toThrow();
  });
});
