import { describe, expect, test } from "bun:test";
import { aggregateMetric } from "./aggregate";

describe("aggregateMetric", () => {
  test("DAU 跨日期显示日均而不是累加", () => expect(aggregateMetric("dau", [
    { date: "2026-07-01", dau: 10 },
    { date: "2026-07-02", dau: 20 }
  ])).toBe(15));
  test("DAU 同日多平台先汇总再按天平均", () => expect(aggregateMetric("dau", [
    { date: "2026-07-01", platform: "A", dau: 10 },
    { date: "2026-07-01", platform: "B", dau: 20 },
    { date: "2026-07-02", platform: "A", dau: 30 },
    { date: "2026-07-02", platform: "B", dau: 40 }
  ])).toBe(50));
  test("累计活跃人天跨日期求和", () => expect(aggregateMetric("dauUserDays", [
    { date: "2026-07-01", dauUserDays: 10 },
    { date: "2026-07-02", dauUserDays: 20 }
  ])).toBe(30));
  test("比例使用分子分母加权", () => {
    expect(aggregateMetric("viewRate", [
      { viewerCount: 10, dau: 20 },
      { viewerCount: 90, dau: 180 }
    ])).toBe(0.5);
  });
  test("分母为零返回 null", () => expect(aggregateMetric("payRate", [{ payerCount: 0, dau: 0 }])).toBeNull());
  test("广告与新增付费比例按原始分子分母加权", () => {
    expect(aggregateMetric("adClickUserRate", [{ adClickUsers: 20, dau: 100 }, { adClickUsers: 15, dau: 50 }])).toBeCloseTo(35 / 150);
    expect(aggregateMetric("newPayRate", [{ newPayerCount: 3, newUsers: 20 }, { newPayerCount: 7, newUsers: 30 }])).toBe(0.2);
  });
  test("新增 ARPU 与 ARPPU 使用新增收入分别除以新增和新增付费人数", () => {
    const rows = [{ newRevenue: 120, newUsers: 20, newPayerCount: 4 }, { newRevenue: 180, newUsers: 30, newPayerCount: 6 }];
    expect(aggregateMetric("newArpu", rows)).toBe(6);
    expect(aggregateMetric("newArppu", rows)).toBe(30);
  });
  test("老用户广告与充值比例使用派生汇总分子分母", () => {
    const rows = [
      { oldAdClickUsers: 18, oldPayerCount: 4, oldRevenue: 120, oldUsers: 60 },
      { oldAdClickUsers: 12, oldPayerCount: 6, oldRevenue: 180, oldUsers: 40 }
    ];
    expect(aggregateMetric("oldAdClickUserRate", rows)).toBe(0.3);
    expect(aggregateMetric("oldPayRate", rows)).toBe(0.1);
    expect(aggregateMetric("oldArpu", rows)).toBe(3);
    expect(aggregateMetric("oldArppu", rows)).toBe(30);
  });
  test("空数据返回 null", () => expect(aggregateMetric("revenue", [])).toBeNull());
});
