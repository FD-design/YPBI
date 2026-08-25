import { describe, expect, test } from "bun:test";
import type { NewavAdapter } from "./adapter";
import { adRow, channelRow, NewavBiAdapter, periodRow } from "./bi-adapter";

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

  test("广告查询不会额外请求周期总览", async () => {
    const calls: string[] = [];
    const adapter = {
      query: async ({ datasetId }: { datasetId: string }) => {
        calls.push(datasetId);
        return { rows: [], summary: {}, warnings: [], definition: {} };
      }
    } as unknown as NewavAdapter;
    await new NewavBiAdapter(adapter).query({
      modelId: "custom_table", analysisType: "table", metricIds: ["pageViews"], dimensionIds: ["position"], eventIds: [],
      platformMode: "single", platformIds: ["newav"], dateRange: ["2026-08-19", "2026-08-25"], filters: {}, limit: 50
    });
    expect(calls).toEqual(["adStats"]);
  });

  test("渠道查询不会额外请求周期总览", async () => {
    const calls: string[] = [];
    const adapter = {
      query: async ({ datasetId }: { datasetId: string }) => {
        calls.push(datasetId);
        return { rows: [], summary: {}, warnings: [], definition: {} };
      }
    } as unknown as NewavAdapter;
    await new NewavBiAdapter(adapter).query({
      modelId: "acquisition_conversion", analysisType: "trend", metricIds: ["newUsers"], dimensionIds: ["channel"], eventIds: [],
      platformMode: "single", platformIds: ["newav"], dateRange: ["2026-08-19", "2026-08-25"], filters: {}, limit: 50
    });
    expect(calls).toEqual(["channelDaily"]);
  });

  test("跨天转化率按分子分母加权而不是平均每日百分比", async () => {
    const adapter = {
      query: async () => ({
        rows: [
          { date: "2026-08-02", registNew: 9, ipUniq: 90, playOk: 90, playErr: 10 },
          { date: "2026-08-01", registNew: 1, ipUniq: 10, playOk: 1, playErr: 9 }
        ],
        summary: {}, warnings: [], definition: {}
      })
    } as unknown as NewavAdapter;
    const response = await new NewavBiAdapter(adapter).query({
      modelId: "business_overview", analysisType: "trend", metricIds: ["visitRegisterRate", "playRate"], dimensionIds: ["date"], eventIds: [],
      platformMode: "single", platformIds: ["newav"], dateRange: ["2026-08-01", "2026-08-02"], filters: {}, limit: 50
    });
    expect(response.data.summary!.visitRegisterRate).toBeCloseTo(10 / 100);
    expect(response.data.summary!.playRate).toBeCloseTo(91 / 110);
  });

  test("累计充值总额取日期最大的周期末快照", async () => {
    const adapter = {
      query: async () => ({
        rows: [
          { date: "2026-08-03", rechargeTotal: 300 },
          { date: "2026-08-01", rechargeTotal: 100 },
          { date: "2026-08-02", rechargeTotal: 200 }
        ],
        summary: {}, warnings: [], definition: {}
      })
    } as unknown as NewavAdapter;
    const response = await new NewavBiAdapter(adapter).query({
      modelId: "business_overview", analysisType: "metric", metricIds: ["revenue"], dimensionIds: ["date"], eventIds: [],
      platformMode: "single", platformIds: ["newav"], dateRange: ["2026-08-01", "2026-08-03"], filters: {}, limit: 50
    });
    expect(response.data.summary!.revenue).toBe(300);
  });

  test("缺失字段保持空值且周期数据不伪造新增购买率", async () => {
    const row = periodRow({ date: "2026-08-25", retentionD1: null, cardBuy: 3, registNew: 100 });
    expect(row.retentionD1).toBeNull();
    expect(row.adClickUsers).toBeNull();
    expect(row.payRate).toBeNull();
  });
});
