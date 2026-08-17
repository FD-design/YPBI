import { describe, expect, test } from "bun:test";
import type { AnalyticsQuery } from "../../contracts/analytics";
import { OverviewAdapter } from "./overview.adapter";
import type { UpstreamClient } from "./client";

const query: AnalyticsQuery = { modelId: "business_overview", analysisType: "trend", metricIds: ["dau"], dimensionIds: ["date"], eventIds: [], platformMode: "single", platformIds: ["PH"], dateRange: ["2026-07-14", "2026-07-15"], filters: {}, limit: 50 };

describe("OverviewAdapter", () => {
  test("带时区的日汇总时间按北京时间自然日归一化", async () => {
    const client = { get: async () => ({ msg: { pageData: [{
      pid: "PH", sumDate: "2026-06-21T16:00:00.000Z", loginUserCount: 0, registerUserCount: 0,
      newUserCount: 0, watchUserCount: 0, totalChargeUserCount: 0, diamondChargeAmt: 0,
      androidLoginUserCount: 0, iosLoginUserCount: 0, androidNewUserCount: 0, iosNewUserCount: 0,
      channelRegisterCount: 0, channelInternalRegisterCount: 0, totalClickedCount: 0,
      totalClickedPerson: 0, newUserTotalClickedCount: 0, newUserTotalClickedPerson: 0,
      newUserDiamondChargeAmt: 0, newUserChargeUserCount: 0,
      channelNewUserChargeAmt: 0, channelInternalNewUserChargeAmt: 0
    }] } }) } as any;
    const rows = await new OverviewAdapter(client).queryDaySum(query, "PH");
    expect(rows[0].date).toBe("2026-06-22");
  });
  test("将 pDaySum 字符串金额和业务字段归一化", async () => {
    const client = { get: async () => ({ code: 200, msg: { pageData: [{
      pid: "PH", sumDate: "2026-07-14 00:00:00", loginUserCount: 120, registerUserCount: 30,
      newUserCount: 31, watchUserCount: 80, totalChargeUserCount: 12, diamondChargeAmt: "99.50",
      androidLoginUserCount: 90, iosLoginUserCount: 30, androidNewUserCount: 20, iosNewUserCount: 10,
      channelRegisterCount: 8, channelInternalRegisterCount: 4, totalClickedCount: 72,
      totalClickedPerson: 48, newUserTotalClickedCount: 15, newUserTotalClickedPerson: 9,
      newUserDiamondChargeAmt: "36.50", newUserChargeUserCount: 5,
      channelNewUserChargeAmt: "12.00", channelInternalNewUserChargeAmt: "6.50"
    }] } }) } as unknown as UpstreamClient;
    const rows = await new OverviewAdapter(client).queryDaySum(query, "PH");
    expect(rows[0]).toEqual({
      date: "2026-07-14", platform: "Pornhub", dau: 120, dauUserDays: 120, newUsers: 30, viewerCount: 80, viewerUserDays: 80,
      payerCount: 12, payerUserDays: 12, revenue: 99.5, androidDau: 90, androidDauUserDays: 90, iosDau: 30, iosDauUserDays: 30,
      androidNewUsers: 20, iosNewUsers: 10, organicNewUsers: 22, internalNewUsers: 4,
      adClickCount: 72, adClickUsers: 48, adClickUserDays: 48, newAdClickCount: 15, newAdClickUsers: 9,
      oldUsers: 90, oldAdClickCount: 57, oldAdClickUsers: 39, oldAdClickUserDays: 39,
      newRevenue: 36.5, newPayerCount: 5, oldRevenue: 63, oldPayerCount: 7, oldPayerUserDays: 7,
      channelNewRevenue: 12, internalNewRevenue: 6.5
    });
  });
});
