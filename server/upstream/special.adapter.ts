import { z } from "zod";
import type { UpstreamClient } from "./client";
import { toBeijingDate } from "./date";

export interface SpecialQuery { platformId: string; dateRange: [string, string]; page: number; pageSize: number }
const envelopeSchema = z.object({ msg: z.object({ pageData: z.array(z.record(z.string(), z.unknown())).default([]), totalCount: z.coerce.number().default(0) }).loose() }).loose();
const value = (input: unknown) => Number(input ?? 0) || 0;
const text = (input: unknown, fallback = "--") => input === undefined || input === null || input === "" ? fallback : String(input);
const date = (input: unknown) => toBeijingDate(input);

export class SpecialAdapter {
  constructor(private readonly client: UpstreamClient) {}
  private async paged(path: string, params: Record<string, string>) {
    const payload = envelopeSchema.parse(await this.client.get(path, params));
    return { total: payload.msg.totalCount, sourceRows: payload.msg.pageData };
  }
  async navigation(query: SpecialQuery) {
    const result = await this.paged("/api/admin/statistics/navs", { pid: query.platformId, page: String(query.page), count: String(query.pageSize), sumDateStart: `${query.dateRange[0]} 00:00:00`, sumDateEnd: `${query.dateRange[1]} 23:59:59` });
    return { total: result.total, rows: result.sourceRows.map((row) => { const clickUsers = value(row.navClickIpsCount); const clicks = value(row.navClickTotalCount); return { date: date(row.localeSumDate ?? row.sumDate), platformId: text(row.pid), navigationId: text(row.navMark), name: text(row.name), category: text(row.cateName), position: value(row.pos), clickUsers, clicks, clicksPerUser: clickUsers ? clicks / clickUsers : 0, destination: text(row.url) }; }) };
  }
  async snapshots(query: SpecialQuery) {
    const result = await this.paged("/api/admin/snapshotManager/getMany", { page: String(query.page), count: String(query.pageSize), startDate: `${query.dateRange[0]} 00:00:00`, endDate: `${query.dateRange[1]} 23:59:59` });
    return { total: result.total, rows: result.sourceRows.map((row) => ({ releaseDate: date(row.releaseDate), snapshotId: text(row.snapshotId), name: text(row.name), views: value(row.viewCnt), likes: value(row.likedCnt), collects: value(row.collectedCnt), comments: value(row.commentCnt), hot: value(row.hot), contentCount: value(row.totalCnt), tags: Array.isArray(row.tags) ? row.tags.map(String).join("、") : "", payType: text(row.payType), price: value(row.price), state: text(row.state), auditStatus: text(row.status) })) };
  }
  async cnzz(query: SpecialQuery) {
    const result = await this.paged("/api/admin/statistics/cpGuardStat/cnzzstatQuery", { pid: query.platformId, page: String(query.page), count: String(query.pageSize), startTime: `${query.dateRange[0]} 00:00:00`, endTime: `${query.dateRange[1]} 23:59:59` });
    return { total: result.total, rows: result.sourceRows.map((row) => { const visits = value(row.totalVistCount); const downloads = value(row.totalDownCount); return { date: date(row.sumDate), platformId: text(row.pid), channel: text(row.channel), visits, visitIps: value(row.vistCount), users: value(row.usersCount), downloads, downloadIps: value(row.totalDownCountByIp), downloadRate: visits ? downloads / visits : 0, repeatDownloads: value(row.repeatDownload), noDownloads: value(row.noDownloadCount), androidDownloads: value(row.androidCount), iosDownloads: value(row.iosCount), internal: Boolean(row.internal) }; }) };
  }
  async news(query: SpecialQuery) {
    const result = await this.paged("/api/admin/statistics/newsStat", { pid: query.platformId, page: String(query.page), count: String(query.pageSize), releaseDateStart: `${query.dateRange[0]} 00:00:00`, releaseDateEnd: `${query.dateRange[1]} 23:59:59` });
    return { total: result.total, rows: result.sourceRows };
  }
  async surveys(query: SpecialQuery) {
    const result = await this.paged("/api/admin/statistics/commonSurveyStat", { pid: query.platformId, page: String(query.page), count: String(query.pageSize), startDate: `${query.dateRange[0]} 00:00:00`, endDate: `${query.dateRange[1]} 23:59:59` });
    return { total: result.total, rows: result.sourceRows };
  }
}
