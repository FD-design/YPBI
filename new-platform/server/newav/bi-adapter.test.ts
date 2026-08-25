import { describe, expect, test } from "bun:test";
import { adRow, channelRow, periodRow } from "./bi-adapter";

describe("NewAV 旧 BI 兼容映射", () => {
  test("周期行派生活跃、播放成功率和注册转化", () => {
    const row = periodRow({ date: "2026-08-25", activeNew: 185, activeOld: 216, registNew: 219, ipUniq: 8021, viewers: 2125, playOk: 9882, playErr: 4099 });
    expect(row.dau).toBe(401);
    expect(row.visitRegisterRate).toBeCloseTo(219 / 8021);
    expect(row.playRate).toBeCloseTo(9882 / (9882 + 4099));
  });

  test("渠道行保留渠道和自然日维度", () => {
    const row = channelRow({ date: "2026-08-25", channelName: "测试渠道", visitors: 100, newUsers: 8, activeUsers: 30, viewers: 20, adClicks: 12, newRevenue: 60, vipBuyers: 2 });
    expect(row).toMatchObject({ platform: "NewAV", channel: "测试渠道", date: "2026-08-25", dau: 30, newUsers: 8, newRevenue: 60 });
    expect(row.visitRegisterRate).toBe(0.08);
  });

  test("广告行将素材和广告位映射为旧 BI 内容维度", () => {
    const row = adRow({ slot: "floating", title: "活动素材", shows: 1000, clicks: 45, clickUsers: 32, ctr: 4.5 });
    expect(row).toMatchObject({ position: "floating", content: "活动素材", pageViews: 1000, adClickCount: 45, adClickUsers: 32, adClickRate: 0.045 });
  });
});
