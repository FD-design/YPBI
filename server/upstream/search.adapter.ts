import type { UpstreamClient } from "./client";
import { hotSearchRowSchema, pagedUpstreamResponseSchema } from "./schemas";
import { getPlatformByPid } from "../platforms/registry";

export const HOT_SEARCH_API = "/api/admin/statistics/hotSearchWords/getMany";

export interface SearchRow { platform: string; keyword: string; searchCount: number }

export class SearchAdapter {
  constructor(private readonly client: UpstreamClient) {}

  async queryRanking(platformId: string, limit: number): Promise<SearchRow[]> {
    const payload = await this.client.get(HOT_SEARCH_API, { page: "1", count: String(limit), pid: platformId });
    const envelope = pagedUpstreamResponseSchema.parse(payload);
    return envelope.msg.pageData.map((item) => {
      const row = hotSearchRowSchema.parse(item);
      return { platform: getPlatformByPid(row.pid)?.name ?? row.pid, keyword: row.words, searchCount: row.searchCnt ?? 0 };
    });
  }
}
