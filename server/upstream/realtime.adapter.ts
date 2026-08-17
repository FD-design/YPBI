import type { AnalyticsQuery } from "../../contracts/analytics";
import { getPlatformByPid } from "../platforms/registry";
import type { UpstreamClient } from "./client";
import { realtimeRowSchema } from "./schemas";
import { z } from "zod";
import { toBeijingDate } from "./date";

export const REALTIME_API = "/api/admin/home/pRealDayLine";

export interface RealtimeAnalyticsRow {
  date: string;
  platform: string;
  dau: number;
  newUsers: number;
  viewerCount: number;
  viewRate: number | null;
  avgWatchMinutes: number | null;
  revenue: number;
  payerCount: number;
  payRate: number | null;
}

export class RealtimeAdapter {
  constructor(private readonly client: UpstreamClient) {}

  async query(query: AnalyticsQuery, platformId: string): Promise<RealtimeAnalyticsRow[]> {
    const payload = await this.client.get(REALTIME_API, { startDate: `${query.dateRange[0]} 00:00:00`, endDate: `${query.dateRange[1]} 23:59:59`, pid: platformId });
    const envelope = z.object({ msg: z.array(z.unknown()) }).loose().parse(payload);
    return envelope.msg.map((item) => realtimeRowSchema.parse(item)).filter((row) => row.graphDate && row.loginUserCount !== null && row.loginUserCount !== undefined).map((row) => {
      const dau = row.loginUserCount ?? 0;
      const viewers = row.watchUserCount ?? 0;
      const payers = row.totalChargeUserCount ?? 0;
      return {
        date: row.sumDate ? `${toBeijingDate(row.sumDate)} ${row.graphDate}` : row.graphDate!,
        platform: getPlatformByPid(platformId)?.name ?? platformId,
        dau,
        newUsers: row.registerUserCount ?? row.newUserCount ?? 0,
        viewerCount: viewers,
        viewRate: dau ? viewers / dau : null,
        avgWatchMinutes: viewers ? (row.totalUserWatchTime ?? 0) / viewers / 60 : null,
        revenue: row.totalChargeAmt ?? 0,
        payerCount: payers,
        payRate: dau ? payers / dau : null
      };
    });
  }
}
