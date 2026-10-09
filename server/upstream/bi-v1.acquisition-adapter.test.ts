import { describe, expect, test } from "bun:test";
import { dailyAcquisitionGroupsSchema, type DailyReadingMetric } from "../../contracts/daily-dashboard";
import { ACQUISITION_GROUP_METRICS, readBiV1AcquisitionGroups, type AcquisitionGroupMetric } from "./bi-v1.acquisition-adapter";
import { UpstreamError } from "./client";

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

describe("获客批量指标选择拒绝的有界隔离", () => {
  const target = (params: Params) => params.dimensions === "channel" && params.granularity === "day";
  const rejected = () => new UpstreamError("UPSTREAM_INVALID_REQUEST", "不支持的指标编码 M007", 422);
  const metricRow = (id: string, changes: Record<string, unknown> = {}) => row({ metricCode: id,
    ...(!["M001", "M003"].includes(id) ? { unit: "ratio", value: 0.5, numerator: 1, denominator: 2 } : {}), ...changes });
  const validSingle = (params: Params) => envelope([metricRow(params.metricCodes)]);

  for (const rejection of ["400", "422", "client"] as const) test(`${rejection}单指标拒绝保留健康原键、缺记录、真零和非READY`, async () => {
    const calls: Params[] = []; let active = 0, maxActive = 0;
    const result = await readBiV1AcquisitionGroups({ get: async (_path, params) => {
      if (!target(params)) return envelope([]);
      calls.push(params); maxActive = Math.max(maxActive, ++active); await Promise.resolve(); active--;
      if (params.metricCodes.includes("M007")) {
        if (rejection === "client") throw rejected();
        return { code: Number(rejection), err: "Unsupported metricCodes: M007" };
      }
      if (params.metricCodes === "M005") return envelope([]);
      if (params.metricCodes === "M006") return envelope([metricRow("M006", { dimensions: { pid: "PH" }, businessDate: undefined, dataStatus: "SOURCE_INCOMPLETE" })]);
      return envelope(["A-B", "a_b", "unknown"].map(key => metricRow(params.metricCodes, { dimensions: { pid: "PH", channel: key }, ...(params.metricCodes === "M001" ? { value: 0, numerator: 0 } : {}) })));
    } }, query, metricFor);
    expect(calls.map(params => params.metricCodes)).toEqual([ACQUISITION_GROUP_METRICS.channel.join(","), ...ACQUISITION_GROUP_METRICS.channel]);
    expect(maxActive).toBe(1);
    for (const call of calls) expect(call).toMatchObject({ pid: "PH", startDate: "2026-09-21", endDate: "2026-09-23", dimensions: "channel", granularity: "day", includeIncomplete: "true" });
    expect(result.channel.groups.map(group => group.key)).toEqual(["A-B", "a_b", "unknown"]);
    expect(result.channel.day).toMatchObject({ state: "returned", generatedAt: null, watermark: null, scopeStatuses: [{ metricId: "M006", sourceStatus: "SOURCE_INCOMPLETE" }] });
    expect(series(result, "M001").points[0]).toMatchObject({ state: "available", value: 0, ruleVersion: "actual-rule" });
    expect(series(result, "M003").points.map(point => point.state)).toEqual(["available", "no_record"]);
    expect(series(result, "M005").points.every(point => point.state === "no_record")).toBe(true);
    expect(series(result, "M006").points.every(point => point.sourceStatus === "SOURCE_INCOMPLETE")).toBe(true);
    for (const point of series(result, "M007").points) {
      expect(point).toMatchObject({ state: "source_failure", value: null, ruleVersion: null });
      expect(point.sourceStatus).toBeUndefined(); expect(point.inputs.every(input => input.value === null)).toBe(true);
    }
    expect(result.channel.summary).toMatchObject({ state: "empty", generatedAt: "2026-09-23T01:00:00+08:00" });
    expect(dailyAcquisitionGroupsSchema.safeParse(result).success).toBe(true);
  });

  test("summary恢复使用独立直返值；其他三路不受影响，跨日M099不请求", async () => {
    const calls: Params[] = [];
    const result = await readBiV1AcquisitionGroups({ get: async (_path, params) => {
      calls.push(params);
      if (params.dimensions === "channel" && params.granularity === "summary" && params.metricCodes.includes("M007")) throw rejected();
      const codes = params.metricCodes.split(",");
      return envelope(codes.map(id => metricRow(id, { dimensions: { pid: "PH", [params.dimensions]: "A-B" },
        ...(params.granularity === "summary" ? { businessDate: undefined, ...(["M001", "M003"].includes(id) ? { value: 80, numerator: 80 } : {}) } : {}) })));
    } }, query, metricFor);
    const summaryCalls = calls.filter(params => params.dimensions === "channel" && params.granularity === "summary");
    expect(summaryCalls).toHaveLength(6); expect(summaryCalls.every(params => !params.metricCodes.includes("M099"))).toBe(true);
    expect(calls).toHaveLength(9);
    expect(series(result, "M003").summary).toMatchObject({ state: "available", value: 80, ruleVersion: "actual-rule" });
    expect(series(result, "M003").points[0].value).toBe(3);
    expect(series(result, "M007").summary).toMatchObject({ state: "source_failure", value: null });
    expect(series(result, "M099").summary.state).toBe("unsupported");
    expect(result.downloadPlatform.groups[0].series[0].summary.value).toBe(80);
    expect(result.channel.day.generatedAt).toBe("2026-09-23T01:00:00+08:00");
    expect(result.channel.summary.generatedAt).toBeNull();
    expect(dailyAcquisitionGroupsSchema.safeParse(result).success).toBe(true);
  });

  for (const remaining of ["empty", "scope", "failed"] as const) test(`没有真实分组时${remaining}与失败组合保持整路失败`, async () => {
    let calls = 0;
    const result = await readBiV1AcquisitionGroups({ get: async (_path, params) => {
      if (!target(params)) return envelope([]);
      calls++;
      if (params.metricCodes.includes("M007") || remaining === "failed") throw rejected();
      return envelope(remaining === "scope" ? [metricRow(params.metricCodes, { dimensions: { pid: "PH" }, businessDate: undefined, dataStatus: "PROCESSING" })] : []);
    } }, query, metricFor);
    expect(calls).toBe(7);
    expect(result.channel).toMatchObject({ groups: [], day: { state: "source_failure", scopeStatuses: [], generatedAt: null, watermark: null } });
    expect(dailyAcquisitionGroupsSchema.safeParse(result).success).toBe(true);
  });

  test("恢复全部为空仍为空；下载目标单指标拒绝不重复请求", async () => {
    const calls: Params[] = [];
    const result = await readBiV1AcquisitionGroups({ get: async (_path, params) => {
      calls.push(params);
      if (params.metricCodes.includes(",") || params.dimensions === "downloadPlatform") throw rejected();
      return envelope([]);
    } }, query, metricFor);
    expect(calls).toHaveLength(15);
    expect(calls.filter(params => params.dimensions === "downloadPlatform")).toHaveLength(2);
    expect(result.channel).toMatchObject({ groups: [], day: { state: "empty", generatedAt: null }, summary: { state: "empty", generatedAt: null } });
    expect(result.downloadPlatform).toMatchObject({ groups: [], day: { state: "source_failure" }, summary: { state: "source_failure" } });
    expect(dailyAcquisitionGroupsSchema.safeParse(result).success).toBe(true);
  });

  for (const error of [
    new UpstreamError("UPSTREAM_AUTH_FAILED", "后台登录状态无效", 401),
    new UpstreamError("UPSTREAM_IP_RESTRICTED", "IP限制", 403),
    new UpstreamError("UPSTREAM_RATE_LIMITED", "请求过于频繁", 429),
    new UpstreamError("UPSTREAM_TIMEOUT", "后台接口请求超时", 504),
    new UpstreamError("UPSTREAM_NETWORK_ERROR", "无法连接后台接口", 502),
    new UpstreamError("UPSTREAM_FAILED", "后台接口返回500", 502),
    new UpstreamError("UPSTREAM_INVALID_REQUEST", "指标查询没有权限，token无效", 422),
    new UpstreamError("UPSTREAM_INVALID_REQUEST", "endDate必须晚于startDate", 422),
    new UpstreamError("BI_V1_RESPONSE_INVALID", "无法识别结构", 502)
  ]) for (const recovery of [false, true]) test(`${error.code}/${error.message}在${recovery ? "恢复中" : "首批"}停止整路`, async () => {
    const calls: string[] = [];
    const result = await readBiV1AcquisitionGroups({ get: async (_path, params) => {
      if (!target(params)) return envelope([]);
      calls.push(params.metricCodes);
      if (recovery && params.metricCodes.includes(",")) throw rejected();
      if (recovery && params.metricCodes === "M001") return validSingle(params);
      throw error;
    } }, query, metricFor);
    expect(calls).toHaveLength(recovery ? 3 : 1);
    expect(result.channel).toMatchObject({ groups: [], day: { state: "source_failure" } });
  });

  for (const changes of [
    { dimensions: { pid: "OTHER", channel: "A-B" } }, { businessDate: "2026-09-23" },
    { metricCode: "M008" }, { dimensions: { pid: "PH", downloadPlatform: "A-B" } },
    { dimensions: { pid: "PH", channel: "A-B", clientPlatform: "web" } },
    { dimensions: { pid: "PH", channel: null } }, { businessDate: undefined }, { ruleVersion: undefined }
  ]) for (const recovery of [false, true]) test(`结构与范围异常不拆分或保留部分结果 ${JSON.stringify(changes)}/${recovery}`, async () => {
    let calls = 0;
    const result = await readBiV1AcquisitionGroups({ get: async (_path, params) => {
      if (!target(params)) return envelope([]);
      calls++;
      if (recovery && params.metricCodes.includes(",")) throw rejected();
      if (recovery && params.metricCodes === "M001") return validSingle(params);
      return envelope([metricRow("M003", { ...changes, numerator: null })]);
    } }, query, metricFor);
    expect(calls).toBe(recovery ? 3 : 1);
    expect(result.channel).toMatchObject({ groups: [], day: { state: "invalid_response" } });
  });

  test("恢复后的非法数值仍只影响该项，跨指标组数上限仍拒绝", async () => {
    for (const excessive of [false, true]) {
      const result = await readBiV1AcquisitionGroups({ get: async (_path, params) => {
        if (!target(params)) return envelope([]);
        if (params.metricCodes.includes(",")) throw rejected();
        if (excessive) return envelope(Array.from({ length: 501 }, (_, i) => metricRow(params.metricCodes, { dimensions: { pid: "PH", channel: `${params.metricCodes}-${i}` } })));
        return envelope([metricRow(params.metricCodes, params.metricCodes === "M003" ? { value: 99 } : {})]);
      } }, query, metricFor);
      if (excessive) expect(result.channel).toMatchObject({ groups: [], day: { state: "invalid_response" } });
      else {
        expect(series(result, "M003").points[0]).toMatchObject({ state: "invalid_value", sourceStatus: "READY" });
        expect(series(result, "M001").points[0].state).toBe("available");
      }
      expect(dailyAcquisitionGroupsSchema.safeParse(result).success).toBe(true);
    }
  });

  for (const conflict of ["duplicate", "scope"] as const) test(`恢复途中${conflict}冲突丢弃本路已恢复数据`, async () => {
    const calls: string[] = [];
    const result = await readBiV1AcquisitionGroups({ get: async (_path, params) => {
      if (!target(params)) return envelope([]);
      calls.push(params.metricCodes);
      if (params.metricCodes.includes(",")) throw rejected();
      if (params.metricCodes === "M001") return validSingle(params);
      return envelope(conflict === "duplicate" ? [row(), row()] : [
        row({ dimensions: { pid: "PH" }, businessDate: undefined, dataStatus: "PROCESSING" }),
        row({ dimensions: { pid: "PH" }, dataStatus: "SOURCE_INCOMPLETE" })
      ]);
    } }, query, metricFor);
    expect(calls).toEqual([ACQUISITION_GROUP_METRICS.channel.join(","), "M001", "M003"]);
    expect(result.channel).toMatchObject({ groups: [], day: { state: "invalid_response", generatedAt: null, watermark: null } });
    expect(dailyAcquisitionGroupsSchema.safeParse(result).success).toBe(true);
  });
});
