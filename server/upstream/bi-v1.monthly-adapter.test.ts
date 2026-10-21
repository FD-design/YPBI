import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { projectBiV1MonthlyMetricScope, readBiV1MonthlyMetricDays } from "./bi-v1.monthly-adapter";
import { normalizeBiV1MetricUnit } from "./bi-v1.metrics-adapter";
import { monthlyQueryScopes } from "../../contracts/monthly-query-scope";
import { UpstreamError } from "./client";

const query = { pid: "PH", startDate: "2020-01-01", endDate: "2020-01-31" };
const today = "2026-10-09";
const row = (overrides: Record<string, unknown> = {}) => ({
  metricCode: "M018",
  dimensions: { pid: "PH" },
  value: 37,
  numerator: 37,
  denominator: 0,
  unit: "count",
  dataStatus: "READY",
  metricVersion: "bi-v1",
  ruleVersion: "rule-v1",
  ...overrides
});
const payload = (rows: ReturnType<typeof row>[]) => ({
  code: 200,
  msg: { metricVersion: "bi-v1", generatedAt: "2026-10-09T10:00:00+08:00", watermark: null, rows }
});
const clientFor = (rows: ReturnType<typeof row>[]) => ({ get: async () => payload(rows) });

test("实际异步月活FAILED保留自然月截止日，复用同步单月投影", async () => {
  const evidence = JSON.parse(readFileSync(new URL("../v2/fixtures/query-jobs-http-20261021.json", import.meta.url), "utf8"));
  const unit = evidence.result.msg.results[3];
  const selected = { pid: "PH", startDate: "2026-10-10", endDate: "2026-10-17" };
  const at = "2026-10-21", scope = monthlyQueryScopes(selected.startDate, selected.endDate, at)[0];
  const source = normalizeBiV1MetricUnit(unit, { pid: "PH", startDate: scope.queryStart!, endDate: scope.queryEnd!, metricCodes: ["M018"], granularity: "summary" });
  const projected = projectBiV1MonthlyMetricScope(source, scope, at);
  expect(projected).toMatchObject({ date: "2026-10-17", queryEnd: "2026-10-20", monthlyMetadata: { month: "2026-10", cutoffDate: "2026-10-20", isComplete: false },
    metrics: { M018: { state: "source_failure", dataStatus: "FAILED", value: null } } });
  const sync = await readBiV1MonthlyMetricDays({ get: async () => ({ code: 200, msg: { ...unit, metricVersion: "bi-v1" } }) }, selected, at);
  expect(sync.days.at(-1)).toEqual(projected);
  expect(() => projectBiV1MonthlyMetricScope({ ...source, rows: source.rows.map(row => ({ ...row, cutoffDate: "2026-10-17" })) }, scope, at)).toThrow("截止日");
});

describe("bi-v1 自然月月活读取", () => {
  test("2020年1月独立请求 summary 和排他2月1日，无日期的总体结果只落在月末 anchor", async () => {
    const calls: Record<string, string>[] = [];
    const result = await readBiV1MonthlyMetricDays({ get: async (path, params) => {
      expect(path).toBe("/api/admin/bi/v1/metrics");
      calls.push(params);
      return payload([row()]);
    } }, query, today);
    expect(calls).toEqual([{
      pid: "PH", startDate: "2020-01-01", endDate: "2020-02-01",
      granularity: "summary", metricCodes: "M018", includeIncomplete: "true"
    }]);
    expect(result.days).toHaveLength(31);
    expect(result.days.slice(0, -1).every(day => Object.keys(day.metrics).length === 0 && day.queryStart === undefined)).toBe(true);
    expect(result.days[30]).toEqual({
      date: "2020-01-31", queryStart: "2020-01-01", queryEnd: "2020-01-31",
      metrics: { M018: { state: "available", dataStatus: "READY", value: 37, numerator: 37, denominator: 0, unit: "count" } }
    });
  });

  test("历史月份的月中查询仍读取整月，所选末日只用作 anchor", async () => {
    let actual: Record<string, string> | undefined;
    const result = await readBiV1MonthlyMetricDays({ get: async (_path, params) => {
      actual = params;
      return payload([row()]);
    } }, { ...query, startDate: "2020-01-12", endDate: "2020-01-17" }, today);
    expect(actual).toMatchObject({ startDate: "2020-01-01", endDate: "2020-02-01", granularity: "summary" });
    expect(result.days.filter(day => day.metrics.M018).map(day => day.date)).toEqual(["2020-01-17"]);
    expect(result.days.at(-1)).toMatchObject({ queryStart: "2020-01-01", queryEnd: "2020-01-31" });
  });

  test("跨年、闰月与跨月分别请求完整月份且各月只保留一个结果", async () => {
    const calls: Record<string, string>[] = [];
    const result = await readBiV1MonthlyMetricDays({ get: async (_path, params) => {
      calls.push(params);
      return payload([row({ value: calls.length, numerator: calls.length })]);
    } }, { ...query, startDate: "2019-12-20", endDate: "2020-03-04" }, today);
    expect(calls.map(call => [call.startDate, call.endDate])).toEqual([
      ["2019-12-01", "2020-01-01"], ["2020-01-01", "2020-02-01"],
      ["2020-02-01", "2020-03-01"], ["2020-03-01", "2020-04-01"]
    ]);
    expect(result.days.filter(day => day.metrics.M018).map(day => [day.date, day.queryEnd, day.metrics.M018.value])).toEqual([
      ["2019-12-31", "2019-12-31", 1], ["2020-01-31", "2020-01-31", 2],
      ["2020-02-29", "2020-02-29", 3], ["2020-03-04", "2020-03-31", 4]
    ]);
  });

  test("当前月读取月初至昨日，日期筛选与查询截至日分别保存", async () => {
    const calls: Record<string, string>[] = [];
    const result = await readBiV1MonthlyMetricDays({ get: async (_path, params) => {
      calls.push(params);
      return payload([row()]);
    } }, { ...query, startDate: "2026-10-03", endDate: "2026-10-06" }, today);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ startDate: "2026-10-01", endDate: "2026-10-09", granularity: "summary" });
    expect(result.days.at(-1)).toMatchObject({ date: "2026-10-06", queryStart: "2026-10-01", queryEnd: "2026-10-08" });
  });

  for (const [startDate, endDate, currentDate] of [
    ["2026-11-01", "2026-11-30", today],
    ["2026-10-20", "2026-10-30", today],
    ["2026-10-09", "2026-10-09", today],
    ["2026-10-01", "2026-10-01", "2026-10-01"]
  ]) {
    test(`${startDate}没有已完成业务日时不请求、保留空值`, async () => {
      let calls = 0;
      const result = await readBiV1MonthlyMetricDays({ get: async () => { calls++; return payload([row()]); } }, { ...query, startDate, endDate }, currentDate);
      expect(calls).toBe(0);
      expect(result.days.at(-1)).toEqual({ date: endDate, metrics: { M018: { state: "no_value", dataStatus: null, value: null, numerator: null, denominator: null, unit: null } } });
    });
  }

  test("零值与无记录分别保留", async () => {
    const zero = await readBiV1MonthlyMetricDays(clientFor([row({ value: 0, numerator: 0 })]), query, today);
    const missing = await readBiV1MonthlyMetricDays(clientFor([]), query, today);
    expect(zero.days.at(-1)?.metrics.M018).toMatchObject({ state: "available", dataStatus: "READY", value: 0 });
    expect(missing.days.at(-1)?.metrics.M018).toMatchObject({ state: "no_record", dataStatus: null, value: null });
  });

  test("历史月已结束与READY 0独立保留", async () => {
    const monthlyMetadata = { month: "2020-01", cutoffDate: "2020-01-31", isComplete: true };
    const result = await readBiV1MonthlyMetricDays(clientFor([row({ ...monthlyMetadata, value: 0, numerator: 0 })]), query, today);
    expect(result.days.at(-1)).toMatchObject({
      monthlyMetadata,
      metrics: { M018: { state: "available", dataStatus: "READY", value: 0, numerator: 0, denominator: 0, unit: "count" } }
    });
    expect(result.days.slice(0, -1).every(day => !day.monthlyMetadata)).toBe(true);
  });

  test("当前月进行中且READY时展示月初至北京时间昨天的去重人数", async () => {
    const monthlyMetadata = { month: "2026-10", cutoffDate: "2026-10-08", isComplete: false };
    const result = await readBiV1MonthlyMetricDays(clientFor([row(monthlyMetadata)]), { ...query, startDate: "2026-10-03", endDate: "2026-10-06" }, today);
    expect(result.days.at(-1)).toMatchObject({ queryStart: "2026-10-01", queryEnd: "2026-10-08", monthlyMetadata, metrics: { M018: { state: "available", value: 37 } } });
  });

  test("当前月仅返回月份状态false时保留字段，READY真实0仍可展示", async () => {
    const result = await readBiV1MonthlyMetricDays(clientFor([row({ isComplete: false, value: 0, numerator: 0 })]),
      { ...query, startDate: "2026-10-03", endDate: "2026-10-06" }, today);
    expect(result.days.at(-1)).toMatchObject({ monthlyMetadata: { isComplete: false }, metrics: { M018: { state: "available", dataStatus: "READY", value: 0 } } });
  });

  for (const monthlyMetadata of [
    { month: "2020-01" }, { cutoffDate: "2020-01-31" }, { isComplete: true }
  ]) {
    test(`月活来源元数据部分返回时只保留已提供项：${JSON.stringify(monthlyMetadata)}`, async () => {
      const result = await readBiV1MonthlyMetricDays(clientFor([row(monthlyMetadata)]), query, today);
      expect(result.days.at(-1)?.monthlyMetadata).toEqual(monthlyMetadata);
    });
  }

  test("旧响应不由业务日、查询日期或READY推断来源元数据", async () => {
    const result = await readBiV1MonthlyMetricDays(clientFor([row({ businessDate: "2020-01-08" })]), query, today);
    expect(result.days.at(-1)).not.toHaveProperty("monthlyMetadata");
  });

  test("业务FAILED保留来源元数据且不泄露无效值，读取失败不生成元数据", async () => {
    const monthlyMetadata = { month: "2020-01", cutoffDate: "2020-01-31", isComplete: true };
    const failed = await readBiV1MonthlyMetricDays(clientFor([row({ ...monthlyMetadata, dataStatus: "FAILED" })]), query, today);
    expect(failed.days.at(-1)).toMatchObject({ monthlyMetadata, metrics: { M018: { state: "source_failure", dataStatus: "FAILED", value: null } } });
    const transport = await readBiV1MonthlyMetricDays({ get: async () => { throw new UpstreamError("UPSTREAM_TIMEOUT", "请求超时", 504); } }, query, today);
    expect(transport.days.at(-1)).not.toHaveProperty("monthlyMetadata");
    expect(transport.days.at(-1)?.metrics.M018).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
  });

  for (const monthlyMetadata of [
    { month: "2020-1" }, { month: "2020-00" }, { month: "2020-13" }, { month: null }, { month: "2019-12" },
    { cutoffDate: "2020-02-30" }, { cutoffDate: null }, { cutoffDate: "2019-12-31" }, { cutoffDate: "2020-02-01" },
    { month: "2020-01", cutoffDate: "2020-02-01" }, { cutoffDate: "2020-01-20" },
    { isComplete: false }, { isComplete: "true" }, { isComplete: 0 }, { isComplete: null }
  ]) {
    test(`月活来源元数据格式或范围冲突失败关闭：${JSON.stringify(monthlyMetadata)}`, async () => {
      const result = await readBiV1MonthlyMetricDays(clientFor([row(monthlyMetadata)]), query, today);
      expect(result.days.at(-1)?.metrics.M018).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
      expect(result.days.at(-1)).not.toHaveProperty("monthlyMetadata");
    });
  }

  for (const monthlyMetadata of [
    { cutoffDate: "2026-10-05" }, { cutoffDate: today }, { isComplete: true }
  ]) {
    test(`当前月统计截止与月份状态冲突失败关闭：${JSON.stringify(monthlyMetadata)}`, async () => {
      const result = await readBiV1MonthlyMetricDays(clientFor([row(monthlyMetadata)]),
        { ...query, startDate: "2026-10-03", endDate: "2026-10-06" }, today);
      expect(result.days.at(-1)?.metrics.M018).toMatchObject({ state: "source_failure", value: null });
      expect(result.days.at(-1)).not.toHaveProperty("monthlyMetadata");
    });
  }

  test("额外分组的错误月元数据不污染精确总体结果", async () => {
    const monthlyMetadata = { month: "2020-01", cutoffDate: "2020-01-31", isComplete: true };
    const result = await readBiV1MonthlyMetricDays(clientFor([
      row(monthlyMetadata), row({ month: "1999-12", cutoffDate: "1999-12-31", dimensions: { pid: "PH", clientPlatform: "android" } })
    ]), query, today);
    expect(result.days.at(-1)).toMatchObject({ monthlyMetadata, metrics: { M018: { state: "available", value: 37 } } });
  });

  test("跨月元数据按独立月份校验，错误月份不清空下一月", async () => {
    const result = await readBiV1MonthlyMetricDays({ get: async (_path, params) => payload([
      row(params.startDate === "2020-01-01"
        ? { month: "2020-02", cutoffDate: "2020-02-29", isComplete: true }
        : { month: "2020-02", cutoffDate: "2020-02-29", isComplete: true })
    ]) }, { ...query, endDate: "2020-02-29" }, today);
    expect(result.days.find(day => day.date === "2020-01-31")?.metrics.M018).toMatchObject({ state: "source_failure", value: null });
    expect(result.days.at(-1)).toMatchObject({ monthlyMetadata: { month: "2020-02", cutoffDate: "2020-02-29", isComplete: true }, metrics: { M018: { state: "available", value: 37 } } });
  });

  for (const [dataStatus, state] of [
    ["PROCESSING", "no_value"], ["NOT_MATURE", "immature"],
    ["SOURCE_INCOMPLETE", "no_value"], ["FAILED", "source_failure"]
  ] as const) {
    test(`${dataStatus}保留状态并清空上游数值`, async () => {
      for (const value of [null, 37]) {
        const result = await readBiV1MonthlyMetricDays(clientFor([row({ dataStatus, value,
          month: "2020-01", cutoffDate: "2020-01-31", isComplete: true })]), query, today);
        expect(result.days.at(-1)?.metrics.M018).toEqual({ state, dataStatus, value: null, numerator: null, denominator: null, unit: null });
        expect(result.days.at(-1)?.monthlyMetadata).toEqual({ month: "2020-01", cutoffDate: "2020-01-31", isComplete: true });
      }
    });
  }

  for (const overrides of [
    { value: null }, { value: .5, numerator: .5 }, { value: 2 ** 53, numerator: 2 ** 53 },
    { numerator: 36 }, { denominator: 1 }, { unit: "ratio" }
  ]) {
    test(`READY非法计数不生成结果：${JSON.stringify(overrides)}`, async () => {
      const result = await readBiV1MonthlyMetricDays(clientFor([row(overrides)]), query, today);
      expect(result.days.at(-1)?.metrics.M018).toMatchObject({ state: "invalid_value", dataStatus: null, value: null });
    });
  }

  for (const [index, rows] of [
    [row(), row()],
    [row(), row({ dataStatus: "SOURCE_INCOMPLETE", value: null })],
    [row({ businessDate: "2020-01-01" }), row({ businessDate: "2020-01-02" })]
  ].entries()) {
    test(`重复或多行 summary 不相加且失败关闭：场景${index + 1}`, async () => {
      const result = await readBiV1MonthlyMetricDays(clientFor(rows), query, today);
      expect(result.days.at(-1)?.metrics.M018).toMatchObject({ state: "invalid_value", value: null });
    });
  }

  for (const overrides of [
    { businessDate: "2019-12-31" }, { businessDate: "2020-02-01" },
    { dimensions: { pid: "OTHER" } }, { metricCode: "M016" },
    { dimensions: { pid: "PH", clientPlatform: "android" } },
    { dimensions: { pid: "PH", unknownDimension: "overall" } },
    { value: -1, numerator: -1 }, { numerator: null }
  ]) {
    test(`范围或结构冲突保留来源失败：${JSON.stringify(overrides)}`, async () => {
      const result = await readBiV1MonthlyMetricDays(clientFor([row(overrides)]), query, today);
      expect(result.days.at(-1)?.metrics.M018).toMatchObject({ state: "source_failure", value: null });
    });
  }

  test("精确总体结果不被附带的额外分组污染", async () => {
    const result = await readBiV1MonthlyMetricDays(clientFor([row(), row({ dimensions: { pid: "PH", clientPlatform: "android" } })]), query, today);
    expect(result.days.at(-1)?.metrics.M018).toMatchObject({ state: "available", dataStatus: "READY", value: 37 });
  });

  test("summary携带请求范围内业务日时仍只保留独立月值", async () => {
    const result = await readBiV1MonthlyMetricDays(clientFor([row({ businessDate: "2020-01-01" })]), query, today);
    expect(result.days.filter(day => day.metrics.M018)).toHaveLength(1);
    expect(result.days.at(-1)?.metrics.M018).toMatchObject({ state: "available", value: 37 });
  });

  test("某月范围冲突只阻断该月，下一月按独立请求继续", async () => {
    const result = await readBiV1MonthlyMetricDays({ get: async (_path, params) => payload([
      row(params.startDate === "2020-01-01" ? { businessDate: "2020-02-01" } : {})
    ]) }, { ...query, endDate: "2020-02-29" }, today);
    expect(result.days.find(day => day.date === "2020-01-31")?.metrics.M018).toMatchObject({ state: "source_failure", value: null });
    expect(result.days.at(-1)?.metrics.M018).toMatchObject({ state: "available", value: 37 });
  });

  for (const error of [
    new UpstreamError("UPSTREAM_AUTH_FAILED", "权限失效", 401),
    new UpstreamError("UPSTREAM_TIMEOUT", "请求超时", 504),
    new UpstreamError("UPSTREAM_NETWORK_ERROR", "请求失败", 502)
  ]) {
    test(`${error.code}不重试、不回退其他来源`, async () => {
      let calls = 0;
      const result = await readBiV1MonthlyMetricDays({ get: async () => { calls++; throw error; } }, query, today);
      expect(calls).toBe(1);
      expect(result.days.at(-1)?.metrics.M018).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
    });
  }

  test("输入日期非法时在请求前拒绝", async () => {
    let calls = 0;
    const client = { get: async () => { calls++; return payload([row()]); } };
    for (const invalid of [
      { ...query, startDate: "2020-02-30" },
      { ...query, startDate: "2020-02-01" },
      { ...query, endDate: "invalid" }
    ]) {
      await expect(readBiV1MonthlyMetricDays(client, invalid, today)).rejects.toMatchObject({ code: "BI_V1_REQUEST_REJECTED" });
    }
    await expect(readBiV1MonthlyMetricDays(client, query, "invalid")).rejects.toMatchObject({ code: "BI_V1_REQUEST_REJECTED" });
    expect(calls).toBe(0);
  });
});
