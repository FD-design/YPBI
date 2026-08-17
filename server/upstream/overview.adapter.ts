import type { AnalyticsQuery } from "../../contracts/analytics";
import type { UpstreamClient } from "./client";
import { pDaySumRowSchema, pagedUpstreamResponseSchema } from "./schemas";
import { getPlatformByPid } from "../platforms/registry";
import { toBeijingDate } from "./date";

export const P_DAY_SUM_API = "/api/admin/statistics/pDaySum";

export interface OverviewRow {
  date: string;
  platform: string;
  dau: number | null;
  dauUserDays: number | null;
  newUsers: number | null;
  viewerCount: number | null;
  viewerUserDays: number | null;
  payerCount: number | null;
  payerUserDays: number | null;
  revenue: number | null;
  androidDau: number | null;
  androidDauUserDays: number | null;
  iosDau: number | null;
  iosDauUserDays: number | null;
  androidNewUsers: number | null;
  iosNewUsers: number | null;
  organicNewUsers: number | null;
  internalNewUsers: number | null;
  adClickCount: number | null;
  adClickUsers: number | null;
  adClickUserDays: number | null;
  newAdClickCount: number | null;
  newAdClickUsers: number | null;
  oldUsers: number | null;
  oldAdClickCount: number | null;
  oldAdClickUsers: number | null;
  oldAdClickUserDays: number | null;
  newRevenue: number | null;
  newPayerCount: number | null;
  oldRevenue: number | null;
  oldPayerCount: number | null;
  oldPayerUserDays: number | null;
  channelNewRevenue: number | null;
  internalNewRevenue: number | null;
}

export class OverviewAdapter {
  constructor(private readonly client: UpstreamClient) {}

  async queryDaySum(query: AnalyticsQuery, platformId: string): Promise<OverviewRow[]> {
    const payload = await this.client.get(P_DAY_SUM_API, {
      page: "1",
      count: "500",
      pid: platformId,
      sumDateStart: `${query.dateRange[0]} 00:00:00`,
      sumDateEnd: `${query.dateRange[1]} 23:59:59`
    });
    const envelope = pagedUpstreamResponseSchema.parse(payload);
    return envelope.msg.pageData.map((item) => {
      const row = pDaySumRowSchema.parse(item);
      const newUsers = row.registerUserCount ?? row.newUserCount;
      const oldUsers = row.loginUserCount === null || newUsers === null ? null : Math.max(0, row.loginUserCount - newUsers);
      const oldAdClickCount = row.totalClickedCount === null || row.newUserTotalClickedCount === null ? null : Math.max(0, row.totalClickedCount - row.newUserTotalClickedCount);
      const oldAdClickUsers = row.totalClickedPerson === null || row.newUserTotalClickedPerson === null ? null : Math.max(0, row.totalClickedPerson - row.newUserTotalClickedPerson);
      const oldRevenue = row.diamondChargeAmt === null || row.newUserDiamondChargeAmt === null ? null : Math.max(0, row.diamondChargeAmt - row.newUserDiamondChargeAmt);
      const oldPayerCount = row.totalChargeUserCount === null || row.newUserChargeUserCount === null ? null : Math.max(0, row.totalChargeUserCount - row.newUserChargeUserCount);
      return {
        date: toBeijingDate(row.sumDate),
        platform: getPlatformByPid(row.pid)?.name ?? row.pid,
        dau: row.loginUserCount,
        dauUserDays: row.loginUserCount,
        newUsers,
        viewerCount: row.watchUserCount,
        viewerUserDays: row.watchUserCount,
        payerCount: row.totalChargeUserCount,
        payerUserDays: row.totalChargeUserCount,
        revenue: row.diamondChargeAmt,
        androidDau: row.androidLoginUserCount,
        androidDauUserDays: row.androidLoginUserCount,
        iosDau: row.iosLoginUserCount,
        iosDauUserDays: row.iosLoginUserCount,
        androidNewUsers: row.androidNewUserCount,
        iosNewUsers: row.iosNewUserCount,
        organicNewUsers: row.registerUserCount === null || row.channelRegisterCount === null ? null : Math.max(0, row.registerUserCount - row.channelRegisterCount),
        internalNewUsers: row.channelInternalRegisterCount,
        adClickCount: row.totalClickedCount,
        adClickUsers: row.totalClickedPerson,
        adClickUserDays: row.totalClickedPerson,
        newAdClickCount: row.newUserTotalClickedCount,
        newAdClickUsers: row.newUserTotalClickedPerson,
        oldUsers,
        oldAdClickCount,
        oldAdClickUsers,
        oldAdClickUserDays: oldAdClickUsers,
        newRevenue: row.newUserDiamondChargeAmt,
        newPayerCount: row.newUserChargeUserCount,
        oldRevenue,
        oldPayerCount,
        oldPayerUserDays: oldPayerCount,
        channelNewRevenue: row.channelNewUserChargeAmt,
        internalNewRevenue: row.channelInternalNewUserChargeAmt
      };
    });
  }
}
