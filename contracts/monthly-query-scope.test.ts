import { describe, expect, test } from "bun:test";
import { monthlyMetricMetadataSchema, monthlyQueryScopes } from "./monthly-query-scope";

describe("自然月统计元数据", () => {
  test("分别保留后端可选字段，月份是否结束不代表加工已就绪", () => {
    for (const metadata of [
      { month: "2026-10" }, { cutoffDate: "2026-10-08" },
      { isComplete: true }, { isComplete: false },
      { month: "2026-10", cutoffDate: "2026-10-08", isComplete: false },
      { month: "2026-09", cutoffDate: "2026-09-30", isComplete: true }
    ]) expect(monthlyMetricMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  test("空、未知字段、非法日期及月份冲突不进入响应", () => {
    for (const metadata of [
      {}, { unknown: true }, { month: "2026-1" }, { month: "2026-13" }, { month: "2026-00" },
      { month: null }, { cutoffDate: "2026-02-30" }, { cutoffDate: null },
      { isComplete: "true" }, { isComplete: 0 }, { isComplete: null },
      { month: "2026-09", cutoffDate: "2026-10-01" }
    ]) expect(monthlyMetricMetadataSchema.safeParse(metadata).success).toBe(false);
  });
});

describe("自然月查询范围", () => {
  test("跨年闰月按完整自然月生成范围，月中选择只决定显示锚点", () => {
    expect(monthlyQueryScopes("2019-12-20", "2020-03-04", "2026-10-09")).toEqual([
      { month: "2019-12", anchor: "2019-12-31", monthStart: "2019-12-01", monthEnd: "2019-12-31", queryStart: "2019-12-01", queryEnd: "2019-12-31" },
      { month: "2020-01", anchor: "2020-01-31", monthStart: "2020-01-01", monthEnd: "2020-01-31", queryStart: "2020-01-01", queryEnd: "2020-01-31" },
      { month: "2020-02", anchor: "2020-02-29", monthStart: "2020-02-01", monthEnd: "2020-02-29", queryStart: "2020-02-01", queryEnd: "2020-02-29" },
      { month: "2020-03", anchor: "2020-03-04", monthStart: "2020-03-01", monthEnd: "2020-03-31", queryStart: "2020-03-01", queryEnd: "2020-03-31" }
    ]);
  });

  test("当前月查询截至昨日，未来选择与月初未结束业务日不产生请求范围", () => {
    expect(monthlyQueryScopes("2026-10-03", "2026-10-06", "2026-10-09")).toEqual([
      { month: "2026-10", anchor: "2026-10-06", monthStart: "2026-10-01", monthEnd: "2026-10-31", queryStart: "2026-10-01", queryEnd: "2026-10-08" }
    ]);
    for (const [start, end, today] of [
      ["2026-10-09", "2026-10-09", "2026-10-09"],
      ["2026-10-20", "2026-10-30", "2026-10-09"],
      ["2026-11-01", "2026-11-30", "2026-10-09"],
      ["2026-10-01", "2026-10-01", "2026-10-01"]
    ]) expect(monthlyQueryScopes(start, end, today)[0]).toMatchObject({ queryStart: null, queryEnd: null });
  });
});
