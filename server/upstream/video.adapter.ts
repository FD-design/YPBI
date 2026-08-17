import type { AnalyticsQuery } from "../../contracts/analytics";
import { getPlatformByPid } from "../platforms/registry";
import type { UpstreamClient } from "./client";
import { pagedUpstreamResponseSchema, videoRankingRowSchema } from "./schemas";

export const VIDEO_RANKING_API = "/api/admin/statistics/videoWatchRanking";

export interface VideoAnalyticsRow {
  platform: string;
  content: string;
  contentId: string;
  category: string;
  videoWatchCount: number;
  videoViewerCount: number;
  videoLikeCount: number;
  videoCollectCount: number;
  revenue: number;
  avgWatchMinutes: number;
}

export class VideoAdapter {
  constructor(private readonly client: UpstreamClient) {}

  async query(query: AnalyticsQuery, platformId: string): Promise<VideoAnalyticsRow[]> {
    return this.queryMany(query, [platformId]);
  }

  async queryMany(query: AnalyticsQuery, platformIds: string[]): Promise<VideoAnalyticsRow[]> {
    const payload = await this.client.get(VIDEO_RANKING_API, {
      page: "1",
      count: String(Math.max(query.limit, 500)),
      sumDateBegin: `${query.dateRange[0]} 00:00:00`,
      sumDateEnd: `${query.dateRange[1]} 23:59:59`
    });
    const envelope = pagedUpstreamResponseSchema.parse(payload);
    const selectedPlatforms = new Set(platformIds);
    return envelope.msg.pageData.map((item) => videoRankingRowSchema.parse(item))
      .filter((row) => selectedPlatforms.has(row.pid))
      .map((row) => {
        const firstTag = row.tags?.[0];
        return {
        platform: getPlatformByPid(row.pid)?.name ?? row.pid,
        content: row.name || String(row._id),
        contentId: String(row._id),
        category: typeof firstTag === "string" ? firstTag : firstTag?.name ?? "未分类",
        videoWatchCount: row.watchedCount ?? 0,
        videoViewerCount: 0,
        videoLikeCount: row.likedCount ?? 0,
        videoCollectCount: row.collectedCount ?? 0,
        revenue: row.totalChargeMoney ?? 0,
        avgWatchMinutes: 0
      };
      });
  }
}
