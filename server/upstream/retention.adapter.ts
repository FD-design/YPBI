import { z } from "zod";
import type { AnalyticsQuery } from "../../contracts/analytics";
import { getPlatformByPid } from "../platforms/registry";
import type { UpstreamClient } from "./client";

export const RETENTION_PLUS_API = "/api/admin/statistics/reletionsStatPlus/getDays";

const retentionRowSchema = z.object({
  sumDate: z.string(), pid: z.string(), registerCount: z.coerce.number(),
  afterFirstData1: z.object({ date: z.string(), loginCnt: z.coerce.number(), retentionRate: z.coerce.number() }).optional(),
  afterFirstData3: z.object({ date: z.string(), loginCnt: z.coerce.number(), retentionRate: z.coerce.number() }).optional(),
  afterFirstData7: z.object({ date: z.string(), loginCnt: z.coerce.number(), retentionRate: z.coerce.number() }).optional(),
  afterFirstData30: z.object({ date: z.string(), loginCnt: z.coerce.number(), retentionRate: z.coerce.number() }).optional()
}).loose();

export interface RetentionRow { date: string; platform: string; newUsers: number; retainedUsers: number; retainedUsersD3: number | null; retainedUsersD7: number | null; retainedUsersD30: number | null; retentionD1: number | null; retentionD3: number | null; retentionD7: number | null; retentionD30: number | null }

function toShanghaiDate(value: string) {
  return new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export class RetentionAdapter {
  constructor(private readonly client: UpstreamClient) {}
  async query(query: AnalyticsQuery, platformId: string): Promise<RetentionRow[]> {
    const payload = await this.client.get(RETENTION_PLUS_API, { pid: platformId, registerDate: `${query.dateRange[0]} 00:00:00`, registerEdDate: `${query.dateRange[1]} 23:59:59` });
    const envelope = z.object({ data: z.array(z.unknown()).optional(), err: z.string().optional() }).loose().parse(payload);
    return (envelope.data ?? []).map((item) => retentionRowSchema.parse(item)).filter((row) => row.pid === platformId).map((row) => {
      const retainedUsers = row.afterFirstData1?.loginCnt ?? 0;
      const retainedUsersD3 = row.afterFirstData3?.loginCnt ?? null;
      const retainedUsersD7 = row.afterFirstData7?.loginCnt ?? null;
      const retainedUsersD30 = row.afterFirstData30?.loginCnt ?? null;
      const ratio = (value: number | null) => value === null || !row.registerCount ? null : value / row.registerCount;
      return { date: toShanghaiDate(row.sumDate), platform: getPlatformByPid(row.pid)?.name ?? row.pid, newUsers: row.registerCount, retainedUsers, retainedUsersD3, retainedUsersD7, retainedUsersD30, retentionD1: ratio(retainedUsers), retentionD3: ratio(retainedUsersD3), retentionD7: ratio(retainedUsersD7), retentionD30: ratio(retainedUsersD30) };
    });
  }
}
