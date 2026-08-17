import { z } from "zod";
import type { UpstreamClient } from "./client";

export const CHANNEL_DETAIL_API = "/api/admin/statistics/channel/channelDetail";
export const CHANNEL_AB_API = "/api/admin/statistics/channel/abLandPage";

export interface ChannelQuery { platformId: string; dateRange: [string, string]; page: number; pageSize: number; templateA?: string; templateB?: string }

const pagedSchema = z.object({ msg: z.object({ pageData: z.array(z.record(z.string(), z.unknown())).default([]), totalCount: z.coerce.number().default(0) }).loose() }).loose();
const numberValue = (value: unknown) => Number(value ?? 0) || 0;

export class ChannelAdapter {
  constructor(private readonly client: UpstreamClient) {}

  async details(query: ChannelQuery) {
    const payload = await this.client.get(CHANNEL_DETAIL_API, { page: String(query.page), count: String(query.pageSize), isDiscount: "false", pid: query.platformId, sumDateBegin: `${query.dateRange[0]} 00:00:00`, sumDateEnd: `${query.dateRange[1]} 23:59:59` });
    const envelope = pagedSchema.parse(payload);
    return { total: envelope.msg.totalCount, rows: envelope.msg.pageData.map((row) => {
      const loginUsers = numberValue(row.loginUserCount);
      const viewers = numberValue(row.watchUserCount);
      return {
        date: String(row.sumDate ?? "").slice(0, 10), platformId: String(row.pid ?? query.platformId), channel: String(row.channel ?? "--"), parentChannel: String(row.parentChannel ?? "--"),
        cooperationType: String(row.cooperationType ?? "--"), owner: String(row.relegation ?? "--"), price: numberValue(row.price), loginUsers,
        newUsers: numberValue(row.newUserCount), registeredUsers: numberValue(row.registerUserCount), viewers, viewRate: loginUsers ? viewers / loginUsers : 0,
        clicks: numberValue(row.totalClickedCount), clickUsers: numberValue(row.totalClickedPerson), paidUsers: numberValue(row.totalChargeUserCount),
        revenue: numberValue(row.totalChargeAmt), androidUsers: numberValue(row.androidLoginUserCount), iosUsers: numberValue(row.iosLoginUserCount), running: Boolean(row.channelRun)
      };
    }) };
  }

  async abLanding(query: ChannelQuery) {
    const payload = await this.client.get(CHANNEL_AB_API, { pid: query.platformId, templateA: query.templateA ?? "default", templateB: query.templateB ?? "default", regNumMin: "0", regNumMax: "1000000", page: String(query.page), count: String(query.pageSize), sumDateStart: `${query.dateRange[0]} 00:00:00`, sumDateEnd: `${query.dateRange[1]} 23:59:59` });
    const envelope = pagedSchema.parse(payload);
    return { total: envelope.msg.totalCount, rows: envelope.msg.pageData };
  }
}
