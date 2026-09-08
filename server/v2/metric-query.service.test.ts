import { describe, expect, test } from "bun:test";
import type { M016Source } from "./m016-source";
import { V2MetricQueryError, V2MetricQueryService } from "./metric-query.service";

const query = {
  metricId: "M016" as const,
  pid: "PH",
  dateRange: ["2026-09-01", "2026-09-03"] as [string, string],
  grain: "day" as const
};

describe("V2MetricQueryService", () => {
  test("未开放指标由能力层返回 422，而不是把它当成格式错误", async () => {
    const source: M016Source = { queryDailyActiveUsers: async () => [] };
    await expect(new V2MetricQueryService(source).execute({ ...query, metricId: "M999" })).rejects.toMatchObject({
      code: "UNSUPPORTED_V2_METRIC_QUERY",
      statusCode: 422
    } satisfies Partial<V2MetricQueryError>);
  });

  test("保留真实 0，并把未返回日期标记为 no_record 而不是补 0", async () => {
    const source: M016Source = {
      queryDailyActiveUsers: async () => [
        { businessDate: "2026-09-01", pid: "PH", value: 0 },
        { businessDate: "2026-09-02", pid: "PH", value: 21 }
      ]
    };
    const result = await new V2MetricQueryService(source).execute(query);
    expect(result.data.seriesStatus).toBe("partial");
    expect(result.data.points).toEqual([
      { businessDate: "2026-09-01", value: 0, state: "available" },
      { businessDate: "2026-09-02", value: 21, state: "available" }
    ]);
    expect(result.data.unavailableDates).toEqual([{ businessDate: "2026-09-03", state: "no_record" }]);
  });

  test("字段为空与整日无记录使用不同状态", async () => {
    const source: M016Source = {
      queryDailyActiveUsers: async () => [{ businessDate: "2026-09-01", pid: "PH", value: null }]
    };
    const result = await new V2MetricQueryService(source).execute(query);
    expect(result.data.seriesStatus).toBe("no_values");
    expect(result.data.unavailableDates).toEqual([
      { businessDate: "2026-09-01", state: "no_value" },
      { businessDate: "2026-09-02", state: "no_record" },
      { businessDate: "2026-09-03", state: "no_record" }
    ]);
  });

  test("所有业务日均无上游行时使用 no_records", async () => {
    const source: M016Source = { queryDailyActiveUsers: async () => [] };
    const result = await new V2MetricQueryService(source).execute(query);
    expect(result.data.seriesStatus).toBe("no_records");
    expect(result.data.unavailableDates.every((item) => item.state === "no_record")).toBe(true);
  });

  test("同一 PID 同一业务日多行时拒绝擅自合并", async () => {
    const source: M016Source = {
      queryDailyActiveUsers: async () => [
        { businessDate: "2026-09-01", pid: "PH", value: 10 },
        { businessDate: "2026-09-01", pid: "PH", value: 11 }
      ]
    };
    await expect(new V2MetricQueryService(source).execute(query)).rejects.toMatchObject({
      code: "V2_METRIC_SOURCE_CONFLICT",
      statusCode: 502
    } satisfies Partial<V2MetricQueryError>);
  });

  test("上游返回错误 PID 或范围外日期时停止查询而不是静默忽略", async () => {
    for (const row of [
      { businessDate: "2026-09-01", pid: "TT", value: 10 },
      { businessDate: "2026-08-31", pid: "PH", value: 10 }
    ]) {
      const source: M016Source = { queryDailyActiveUsers: async () => [row] };
      await expect(new V2MetricQueryService(source).execute(query)).rejects.toMatchObject({
        code: "V2_METRIC_SOURCE_CONFLICT",
        statusCode: 502
      } satisfies Partial<V2MetricQueryError>);
    }
  });
});
