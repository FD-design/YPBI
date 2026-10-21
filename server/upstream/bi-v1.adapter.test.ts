import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { aggregateBiV1Playback, normalizeBiV1PlaybackUnit, queryBiV1Playback, type BiV1MetricRow } from "./bi-v1.adapter";

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

describe("异步播放来源及逐指标状态", () => {
  const evidence = JSON.parse(readFileSync(new URL("../v2/fixtures/query-jobs-http-20261021.json", import.meta.url), "utf8"));
  const scope = { pid: "PH", startDate: "2026-10-17", endDate: "2026-10-17" };
  const unit = evidence.result.msg.results[4];

  test("实际混合状态保留起播6及有效率4/6诊断，coverage READY不晋升指标", async () => {
    const normalized = normalizeBiV1PlaybackUnit(unit, scope);
    expect(Object.hasOwn(normalized, "metricVersion")).toBe(false);
    expect(normalized.sourceCoverage).toEqual(unit.sourceCoverage);
    const points = aggregateBiV1Playback(normalized, scope)[0].metrics;
    expect(points.M097).toMatchObject({ dataStatus: "READY", state: "available", value: 6 });
    expect(points.M034).toMatchObject({ dataStatus: "SOURCE_INCOMPLETE", value: null, numerator: null });
    expect(points.M036).toMatchObject({ dataStatus: "SOURCE_INCOMPLETE", value: null, numerator: null, denominator: null,
      diagnosticInputs: { numerator: 4, denominator: 6 } });
    const sync = await queryBiV1Playback({ get: async () => ({ code: 200, msg: { ...unit, metricVersion: "bi-v1" } }) }, scope);
    expect(aggregateBiV1Playback(sync, scope)[0].metrics).toEqual(points);
  });

  test("实际空rows不造类型桶或0，coverage仍是独立证明", () => {
    const empty = normalizeBiV1PlaybackUnit(evidence.extraResult.msg.results[0], scope);
    expect(empty.rows).toEqual([]);
    expect(empty.sourceCoverage).toHaveLength(3);
    expect(Object.values(aggregateBiV1Playback(empty, scope)[0].metrics).every(point => point.state === "no_record" && point.value === null)).toBe(true);
    const absent = { ...unit }; delete absent.watermark;
    expect(Object.hasOwn(normalizeBiV1PlaybackUnit(absent, scope), "watermark")).toBe(false);
  });

  test("各指标跨类型按自身状态聚合，不以未就绪诊断计算正式比率", () => {
    const rows = [...group("short_video", 4, 6).map(item => ({ ...item, businessDate: scope.startDate,
      ...(item.metricCode === "M097" ? {} : { value: null, dataStatus: "SOURCE_INCOMPLETE" as const }) })),
    ...group("long_video", 2, 4).map(item => ({ ...item, businessDate: scope.startDate }))];
    const points = aggregateBiV1Playback(message(rows), scope)[0].metrics;
    expect(points.M097).toMatchObject({ value: 10, state: "available" });
    expect(points.M036).toMatchObject({ value: null, numerator: null, diagnosticInputs: { numerator: 6, denominator: 10 } });
    const independent = group().map(item => item.metricCode === "M097" ? { ...item, value: null, dataStatus: "PROCESSING" as const } : item);
    const alternate = aggregateBiV1Playback(message(independent), query)[0].metrics;
    expect(alternate.M097).toMatchObject({ value: null, dataStatus: "PROCESSING" });
    expect(alternate.M034.value).toBe(7);
    expect(alternate.M036.value).toBe(7 / 8);
  });

  test("越界或重复coverage、坏行级版本及未就绪非空值失败关闭", () => {
    for (const coverage of [
      [{ ...unit.sourceCoverage[0], pid: "TT" }], [{ ...unit.sourceCoverage[0], businessDate: "2026-10-18" }],
      [unit.sourceCoverage[0], unit.sourceCoverage[0]], [{ ...unit.sourceCoverage[0], reason: "unknown" }]
    ]) expect(() => normalizeBiV1PlaybackUnit({ ...unit, sourceCoverage: coverage }, scope)).toThrow();
    for (const rows of [
      unit.rows.map((row: BiV1MetricRow) => ({ ...row, metricVersion: "bi-v2" })),
      unit.rows.map((row: BiV1MetricRow) => ({ ...row, dimensions: { ...row.dimensions, pid: "TT" } })),
      unit.rows.map((row: BiV1MetricRow) => ({ ...row, ...(row.metricCode === "M036" ? { value: 4 / 6 } : {}) }))
    ]) expect(() => normalizeBiV1PlaybackUnit({ ...unit, rows }, scope)).toThrow();
  });
});

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
