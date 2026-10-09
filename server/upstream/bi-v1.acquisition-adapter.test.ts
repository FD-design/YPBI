import { describe, expect, test } from "bun:test";
import { dailyAcquisitionGroupsSchema, type DailyReadingMetric } from "../../contracts/daily-dashboard";
import { ACQUISITION_GROUP_METRICS, readBiV1AcquisitionGroups, type AcquisitionGroupMetric } from "./bi-v1.acquisition-adapter";

const query = { pid: "PH", dateRange: ["2026-09-21", "2026-09-22"] as [string, string] };
const metricFor = (id: AcquisitionGroupMetric): DailyReadingMetric => ({ id, name: id, unit: ["M001", "M003"].includes(id) ? "次" : "%",
  definition: "test", authorityVersion: "test", formula: null, referenceMetricId: id, sourceNote: null,
  inputs: ["M001", "M003"].includes(id) ? [{ key: "count", name: "次数", unit: "次" }] : [{ key: "numerator", name: "分子", unit: "次" }, { key: "denominator", name: "分母", unit: "次" }] });
const row = (overrides: Record<string, unknown> = {}) => ({ metricCode: "M003", businessDate: query.dateRange[0], dimensions: { pid: "PH", channel: "A-B" },
  value: 3, numerator: 3, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "actual-rule", ...overrides });
const envelope = (rows: unknown[]) => ({ code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-23T01:00:00+08:00", watermark: "actual-watermark", rows } });
type Params = Record<string, string>;
const run = (getRows: (params: Params) => unknown[] = () => [], q = query) => readBiV1AcquisitionGroups({ get: async (_path, params) => envelope(getRows(params)) }, q, metricFor);
const onlyDay = (rows: unknown[]) => run(params => params.dimensions === "channel" && params.granularity === "day" ? rows : []);
const series = (result: Awaited<ReturnType<typeof run>>, id: string, key = "A-B") => result.channel.groups.find(group => group.key === key)!.series.find(item => item.metric.id === id)!;

describe("获客动态分组独立读取", () => {
  test("四路并发、显式维度、排除结束日、跨日 M099 不查询 summary", async () => {
    const calls: Params[] = []; let active = 0, maxActive = 0;
    const result = await readBiV1AcquisitionGroups({ get: async (path, params) => {
      expect(path).toBe("/api/admin/bi/v1/metrics"); calls.push(params); maxActive = Math.max(maxActive, ++active);
      await Promise.resolve(); active--; return envelope([]);
    } }, query, metricFor);
    expect(maxActive).toBe(4);
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call).toMatchObject({ pid: "PH", startDate: "2026-09-21", endDate: "2026-09-23", includeIncomplete: "true" });
    expect(calls.map(call => [call.dimensions, call.granularity, call.metricCodes])).toEqual([
      ["channel", "day", "M001,M003,M005,M006,M007,M099"], ["channel", "summary", "M001,M003,M005,M006,M007"],
      ["downloadPlatform", "day", "M003"], ["downloadPlatform", "summary", "M003"]
    ]);
    expect(result.channel).toMatchObject({ completeness: "unknown", day: { state: "empty" }, summary: { state: "empty" }, groups: [] });
    expect(dailyAcquisitionGroupsSchema.safeParse(result).success).toBe(true);
  });
  test("原键大小写、符号与未知字符串保持独立；区间结果不从日值累计", async () => {
    const keys = ["A-B", "a_b", "unknown", "a b", "未知来源"];
    const result = await run(params => keys.map(key => row({ dimensions: { pid: "PH", [params.dimensions]: key },
      ...(params.granularity === "summary" ? { businessDate: undefined, value: 80, numerator: 80 } : {}) })));
    expect(result.channel.groups.map(group => group.key)).toEqual(keys);
    expect(result.downloadPlatform.groups.map(group => group.label)).toEqual(keys);
    expect(series(result, "M003").points.map(point => [point.state, point.value])).toEqual([["available", 3], ["no_record", null]]);
    expect(series(result, "M003").summary).toMatchObject({ state: "available", value: 80, ruleVersion: "actual-rule" });
    expect(series(result, "M099").summary).toMatchObject({ state: "unsupported", value: null, ruleVersion: null });
    expect(result.channel.summary).toMatchObject({ generatedAt: "2026-09-23T01:00:00+08:00", watermark: "actual-watermark" });
    expect(dailyAcquisitionGroupsSchema.safeParse(result).success).toBe(true);
  });
  test("真实0、零分母与大于1趋势比率保持原语义", async () => {
    const result = await onlyDay([row({ value: 0, numerator: 0 }), row({ metricCode: "M005", unit: "ratio", value: 2, numerator: 4, denominator: 2 }),
      row({ metricCode: "M006", unit: "ratio", value: 2, numerator: 4, denominator: 2 }), row({ metricCode: "M007", unit: "ratio", value: 2, numerator: 4, denominator: 2 }),
      row({ metricCode: "M099", unit: "ratio", value: null, numerator: 0, denominator: 0 })]);
    expect(series(result, "M003").points[0]).toMatchObject({ state: "available", value: 0, inputs: [{ value: 0 }] });
    for (const id of ["M005", "M006", "M007"]) expect(series(result, id).points[0]).toMatchObject({ state: "available", value: 2, inputs: [{ value: 4 }, { value: 2 }] });
    expect(series(result, "M099").points[0]).toMatchObject({ state: "zero_denominator", value: null, inputs: [{ value: 0 }, { value: 0 }] });
    expect(dailyAcquisitionGroupsSchema.safeParse(result).success).toBe(true);
  });
  for (const sourceStatus of ["PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"]) test(`${sourceStatus} 不读取污染数值且保留原规则版本`, async () => {
    const result = await onlyDay([row({ dataStatus: sourceStatus, value: 999, numerator: "invalid", denominator: -1 })]);
    expect(series(result, "M003").points[0]).toMatchObject({ sourceStatus, value: null, inputs: [{ value: null }], ruleVersion: "actual-rule" });
    expect(dailyAcquisitionGroupsSchema.safeParse(result).success).toBe(true);
  });
  test("范围非READY不生成分组，并覆盖同范围READY行", async () => {
    const scope = row({ dimensions: { pid: "PH" }, businessDate: undefined, dataStatus: "SOURCE_INCOMPLETE", value: 888 });
    const empty = await onlyDay([scope]);
    expect(empty.channel.groups).toEqual([]);
    expect(empty.channel.day).toMatchObject({ state: "returned", scopeStatuses: [{ metricId: "M003", sourceStatus: "SOURCE_INCOMPLETE" }] });
    const result = await onlyDay([scope, row()]);
    for (const point of series(result, "M003").points) expect(point).toMatchObject({ sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: [{ value: null }] });
  });
  test("带日期的范围状态只覆盖对应日，缺日期的分组非READY覆盖本组全部日", async () => {
    const result = await onlyDay([row(), row({ dimensions: { pid: "PH" }, businessDate: query.dateRange[1], dataStatus: "PROCESSING" }),
      row({ metricCode: "M001", businessDate: undefined, dataStatus: "NOT_MATURE" })]);
    expect(series(result, "M003").points.map(point => point.state)).toEqual(["available", "no_value"]);
    expect(series(result, "M001").points.map(point => point.state)).toEqual(["immature", "immature"]);
    expect(result.channel.day.scopeStatuses[0].businessDate).toBe(query.dateRange[1]);
  });
  for (const [label, changes] of [
    ["wrong pid", { dimensions: { pid: "OTHER", channel: "A-B" } }], ["wrong dimension", { dimensions: { pid: "PH", downloadPlatform: "A-B" } }],
    ["extra dimension", { dimensions: { pid: "PH", channel: "A-B", clientPlatform: "web" } }], ["blank group", { dimensions: { pid: "PH", channel: " " } }],
    ["null group", { dimensions: { pid: "PH", channel: null } }], ["out of range", { businessDate: "2026-09-23" }],
    ["missing READY date", { businessDate: undefined }], ["READY overall", { dimensions: { pid: "PH" } }], ["unrequested metric", { metricCode: "M008" }],
    ["missing rule", { ruleVersion: undefined }]
  ] as const) test(`${label} 拒绝整路错误响应`, async () => {
    const result = await onlyDay([row(changes)]);
    expect(result.channel.day.state).toBe("invalid_response"); expect(result.channel.groups).toEqual([]);
  });
  test("重复分组键日期、重复范围状态与矛盾范围状态都拒绝", async () => {
    for (const rows of [[row(), row()], [row({ dimensions: { pid: "PH" }, dataStatus: "PROCESSING" }), row({ dimensions: { pid: "PH" }, dataStatus: "SOURCE_INCOMPLETE" })],
      [row({ dimensions: { pid: "PH" }, businessDate: undefined, dataStatus: "PROCESSING" }), row({ dimensions: { pid: "PH" }, dataStatus: "SOURCE_INCOMPLETE" })]]) {
      expect((await onlyDay(rows)).channel.day.state).toBe("invalid_response");
    }
  });
  test("summary不能带日期，单日M099可直返", async () => {
    const invalid = await run(params => params.dimensions === "channel" && params.granularity === "summary" ? [row()] : []);
    expect(invalid.channel.summary.state).toBe("invalid_response");
    const result = await run(params => {
      if (params.dimensions !== "channel" || params.granularity !== "summary") return [];
      expect(params.metricCodes).toContain("M099");
      return [row({ metricCode: "M099", businessDate: undefined, unit: "ratio", value: 0.5, numerator: 2, denominator: 4 })];
    }, { ...query, dateRange: [query.dateRange[0], query.dateRange[0]] });
    expect(series(result, "M099").summary).toMatchObject({ value: 0.5, inputs: [{ value: 2 }, { value: 4 }] });
  });
  test("M099不添加无来源依据的比率上限；浮点校验采用现有adapter尺度", async () => {
    const result = await onlyDay([row({ metricCode: "M099", unit: "ratio", value: 2, numerator: 4, denominator: 2 }),
      row({ metricCode: "M005", unit: "ratio", value: 1 / 3 + 1e-13, numerator: 1, denominator: 3 })]);
    expect(series(result, "M099").points[0]).toMatchObject({ state: "available", value: 2 });
    expect(series(result, "M005").points[0]).toMatchObject({ state: "available", value: 1 / 3 + 1e-13 });
  });
  test("单路网络失败和非200不污染其他路，summary仍直返", async () => {
    const result = await readBiV1AcquisitionGroups({ get: async (_path, params) => {
      if (params.dimensions === "channel" && params.granularity === "day") throw new Error("network");
      if (params.dimensions === "downloadPlatform" && params.granularity === "summary") return { code: 422, err: "unsupported" };
      return envelope([row({ dimensions: { pid: "PH", [params.dimensions]: "A-B" }, ...(params.granularity === "summary" ? { businessDate: undefined } : {}) })]);
    } }, query, metricFor);
    expect(result.channel.day.state).toBe("source_failure"); expect(series(result, "M003").points[0].state).toBe("source_failure");
    expect(series(result, "M003").summary.value).toBe(3);
    expect(result.downloadPlatform.summary.state).toBe("source_failure"); expect(result.downloadPlatform.groups[0].series[0].points[0].value).toBe(3);
    expect(dailyAcquisitionGroupsSchema.safeParse(result).success).toBe(true);
  });
  for (const changes of [{ value: 1.5, numerator: 1.5 }, { value: Number.MAX_SAFE_INTEGER + 1, numerator: Number.MAX_SAFE_INTEGER + 1 },
    { value: 3, numerator: 4 }, { value: 3, denominator: 1 }, { unit: "ratio" },
    { metricCode: "M005", unit: "ratio", value: 0.5, numerator: 1, denominator: 4 }]) test(`非法数值局部不可用 ${JSON.stringify(changes)}`, async () => {
    const result = await onlyDay([row(changes)]);
    expect(result.channel.day.state).toBe("returned"); const point = series(result, changes.metricCode ?? "M003").points[0];
    expect(point).toMatchObject({ state: "invalid_value", sourceStatus: "READY", value: null, ruleVersion: "actual-rule" });
    expect(point.inputs.every(input => input.value === null)).toBe(true);
  });
  test("分组与输出点数超限拒绝，不截断", async () => {
    const many = await onlyDay(Array.from({ length: 1001 }, (_, i) => row({ dimensions: { pid: "PH", channel: `group-${i}` } })));
    expect(many.channel.day.state).toBe("invalid_response"); expect(many.channel.groups).toEqual([]);
    const expanded = await run(params => params.dimensions === "channel" && params.granularity === "day" ? Array.from({ length: 100 }, (_, i) => row({ dimensions: { pid: "PH", channel: `group-${i}` }, businessDate: "2026-01-01" })) : [], { pid: "PH", dateRange: ["2026-01-01", "2026-12-31"] });
    expect(expanded.channel.day.state).toBe("invalid_response"); expect(expanded.channel.summary.state).toBe("invalid_response"); expect(expanded.channel.groups).toEqual([]);
  });
  test("未知完整性不附带总体或分组相加值", async () => {
    const result = await onlyDay([row()]);
    expect(Object.keys(result.channel)).toEqual(["dimension", "completeness", "day", "summary", "groups"]);
    expect(result.channel.groups[0].series.map(item => item.metric.id)).toEqual([...ACQUISITION_GROUP_METRICS.channel]);
  });
});
