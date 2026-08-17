import type { UpstreamClient } from "./client";
import { circleRowSchema, pagedUpstreamResponseSchema, userDailyRowSchema } from "./schemas";
import { getPlatformByPid } from "../platforms/registry";

export const USER_DAILY_API = "/api/admin/statistics/todayUsers/getMany";
export const CIRCLE_LIST_API = "/api/admin/statistics/todayCircles/getMany";

export interface DetailQuery { platformId: string; dateRange: [string, string]; page: number; pageSize: number }

export class DetailAdapter {
  constructor(private readonly client: UpstreamClient) {}

  async users(query: DetailQuery) {
    const payload = await this.client.get(USER_DAILY_API, { page: String(query.page), count: String(query.pageSize), pid: query.platformId, sumDateBegin: `${query.dateRange[0]} 00:00:00`, sumDateEnd: `${query.dateRange[1]} 23:59:59` });
    const envelope = pagedUpstreamResponseSchema.parse(payload);
    return envelope.msg.pageData.map((item) => userDailyRowSchema.parse(item)).map((row) => ({
      platform: getPlatformByPid(row.pid)?.name ?? row.pid, userId: String(row.uid), date: row.sumDate.slice(0, 10),
      chargeAmount: row.totalChargeMoney ?? 0, vipChargeAmount: row.totalVipChargeMoney ?? 0,
      diamondChargeAmount: row.totalDiamondChargeMoney ?? 0, watchedTimeRaw: row.watchedTime ?? 0,
      watchedVideoCount: row.watchedVideoCount ?? 0, watchCount: row.watchCount ?? 0,
      adsCount: row.adsCount ?? 0, navCount: row.navCount ?? 0
    }));
  }

  async circles(query: DetailQuery) {
    const payload = await this.client.get(CIRCLE_LIST_API, { page: String(query.page), count: String(query.pageSize), sumDateBegin: `${query.dateRange[0]} 00:00:00`, sumDateEnd: `${query.dateRange[1]} 23:59:59` });
    const envelope = pagedUpstreamResponseSchema.parse(payload);
    return envelope.msg.pageData.map((item) => circleRowSchema.parse(item)).filter((row) => row.pid === query.platformId).map((row) => ({
      platform: getPlatformByPid(row.pid)?.name ?? row.pid, circleId: String(row.circleId), circleName: row.circleName ?? String(row.circleId),
      watchCount: row.watchedCount ?? 0, viewerCount: row.watchedUserCount ?? 0,
      likeCount: row.likedCount ?? 0, collectCount: row.collectedCount ?? 0, revenue: row.totalChargeMoney ?? 0
    }));
  }
}
