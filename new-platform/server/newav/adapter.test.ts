import { describe, expect, test } from "bun:test";
import { aggregateChannelDaily, normalizeChannelDaily } from "./adapter";

describe("NewAV channel daily adapter", () => {
  const payload = {
    totals: { visitors: 30, registNew: 6, active: 13, viewers: 17, rechargeNew: 90 },
    rows: [
      { date: "2026-08-24", code: "seo001", name: "SEO", visitors: 10, registNew: 1, active: 5, activeNew: 1, activeOld: 4, viewers: 7, viewersNew: 1, ipTotal: 20, ipUniq: 8, adClick: 2, rechargeNew: 30, vipBuyers: 1, convRate: 10 },
      { date: "2026-08-25", code: "seo001", name: "SEO", visitors: 20, registNew: 5, active: 8, activeNew: 4, activeOld: 4, viewers: 10, viewersNew: 4, ipTotal: 40, ipUniq: 16, adClick: 3, rechargeNew: 60, vipBuyers: 2, convRate: 25 }
    ]
  };

  test("保留渠道和自然日粒度，不把缺失字段伪造成零", () => {
    const result = normalizeChannelDaily(payload);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].date).toBe("2026-08-24");
    expect(result.rows[0].channelCode).toBe("seo001");
    expect(result.rows[0].adClickUsers).toBeNull();
  });

  test("注册转化按周期分子分母加权，而不是平均每日百分比", () => {
    const result = aggregateChannelDaily(normalizeChannelDaily(payload).rows);
    expect(result.registrationRate).toBeCloseTo(0.2);
  });

  test("活跃同时提供日均和累计人天", () => {
    const result = aggregateChannelDaily(normalizeChannelDaily(payload).rows);
    expect(result.averageActiveUsers).toBe(6.5);
    expect(result.activeUserDays).toBe(13);
  });

  test("兼容 data 包装响应", () => {
    expect(normalizeChannelDaily({ data: payload }).rows).toHaveLength(2);
  });
});
