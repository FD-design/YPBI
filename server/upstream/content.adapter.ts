import { z } from "zod";
import type { UpstreamClient } from "./client";

export interface ContentQuery { platformId: string; dateRange: [string, string]; page: number; pageSize: number }
const envelope = z.object({ msg: z.unknown() }).loose();
const itemSchema = z.object({ categoryName: z.string() }).catchall(z.unknown());
const number = (value: unknown) => Number(value ?? 0) || 0;

export class ContentAdapter {
  constructor(private readonly client: UpstreamClient) {}
  async categories(query: ContentQuery) {
    const payload = envelope.parse(await this.client.get("/api/admin/statistics/todayVideos/getVideoStatsByCategories", { pid: query.platformId, sumDateBegin: `${query.dateRange[0]} 00:00:00`, sumDateEnd: `${query.dateRange[1]} 23:59:59` }));
    const msg = z.object({ watchedCountRank: z.array(itemSchema).default([]), watchedUserCountRank: z.array(itemSchema).default([]), likedCountRank: z.array(itemSchema).default([]), collectedCountRank: z.array(itemSchema).default([]), clickedCountRank: z.array(itemSchema).default([]), isUvApproximate: z.boolean().optional() }).loose().parse(payload.msg);
    const names = new Set([...msg.watchedCountRank, ...msg.watchedUserCountRank, ...msg.likedCountRank, ...msg.collectedCountRank, ...msg.clickedCountRank].map((item) => item.categoryName));
    const metric = (rows: Array<z.infer<typeof itemSchema>>, name: string, key: string) => number(rows.find((row) => row.categoryName === name)?.[key]);
    return { approximateUv: msg.isUvApproximate ?? false, rows: [...names].map((category) => { const watches = metric(msg.watchedCountRank, category, "watchedCount"); const viewers = metric(msg.watchedUserCountRank, category, "watchedUserCount"); const likes = metric(msg.likedCountRank, category, "likedCount"); const collects = metric(msg.collectedCountRank, category, "collectedCount"); const clicks = metric(msg.clickedCountRank, category, "clickedCount"); return { category, watches, viewers, clicks, likes, collects, watchesPerViewer: viewers ? watches / viewers : 0, playPerClick: clicks ? watches / clicks : 0, likeRate: viewers ? likes / viewers : 0, collectRate: viewers ? collects / viewers : 0 }; }).sort((a, b) => b.watches - a.watches) };
  }
  private async paged(path: string, query: ContentQuery) {
    const payload = envelope.parse(await this.client.get(path, { page: String(query.page), count: String(query.pageSize), sumDateBegin: `${query.dateRange[0]} 00:00:00`, sumDateEnd: `${query.dateRange[1]} 23:59:59` }));
    const msg = z.object({ pageData: z.array(z.record(z.string(), z.unknown())).default([]), totalCount: z.coerce.number().default(0) }).loose().parse(payload.msg);
    return { total: msg.totalCount, rows: msg.pageData };
  }
  videoTotals(query: ContentQuery) { return this.paged("/api/admin/statistics/todayVideos/getManyTotalSum", query); }
  videoRanking(query: ContentQuery) { return this.paged("/api/admin/statistics/videoWatchRanking", query); }
  circleTotals(query: ContentQuery) { return this.paged("/api/admin/statistics/todayCircles/getManyTotalSum", query); }
}
