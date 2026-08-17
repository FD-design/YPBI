import { z } from "zod";
import type { UpstreamClient } from "./client";

const envelope = z.object({ msg: z.unknown() }).loose();
const record = z.record(z.string(), z.unknown());
const text = (value: unknown, fallback = "--") => value === undefined || value === null || value === "" ? fallback : String(value);

export class MetadataAdapter {
  constructor(private readonly client: UpstreamClient) {}
  async categories() {
    const payload = envelope.parse(await this.client.get("/api/admin/serverCfg/categories/get", {}));
    const roots = z.array(record).parse(payload.msg);
    return roots.map((root) => ({ platformCode: text(root.id), platformName: text(root.name), groups: Array.isArray(root.children) ? root.children.map((child) => { const item = record.parse(child); return { id: text(item.id), name: text(item.name), type: text(item.type), childCount: Array.isArray(item.children) ? item.children.length : 0 }; }) : [] }));
  }
  async tags(platformId: string) {
    const payload = envelope.parse(await this.client.get("/api/admin/serverCfg/tags/getAllAttr", { pid: platformId }));
    const pageData = z.object({ pageData: z.array(record).default([]) }).loose().parse(payload.msg).pageData;
    const all = pageData.flatMap((group) => Array.isArray(group.data) ? group.data.map((raw) => { const item = record.parse(raw); return { id: text(item.id), name: text(item.name), type: text(item.type), group: text(group.key) }; }) : []);
    const unique = [...new Map(all.map((item) => [item.id, item])).values()];
    return { total: all.length, uniqueTotal: unique.length, truncated: unique.length > 2000, rows: unique.slice(0, 2000) };
  }
  async partners(platformId: string) {
    const payload = envelope.parse(await this.client.get("/api/admin/channelMgr/partner/getMany", { pid: platformId }));
    const parsed = z.object({ pageData: z.array(record).default([]), totalCount: z.coerce.number().default(0) }).loose().parse(payload.msg);
    return { total: parsed.totalCount, rows: parsed.pageData.map((item) => ({ id: text(item._id), name: text(item.name), platformId: text(item.pid), telegram: text(item.tgAccount), createdAt: text(item.createDate, "").slice(0, 10) })) };
  }
  async landingTemplates(platformId: string) {
    const payload = envelope.parse(await this.client.get("/api/admin/channelMgr/channelPage/getDlTmpList", { pid: platformId }));
    const msg = record.parse(payload.msg);
    return { platformId: text(msg.pid), rows: Array.isArray(msg.tmpl) ? msg.tmpl.map((raw) => { const item = record.parse(raw); return { value: text(item.value), label: text(item.label), previewHash: text(item.previewHash) }; }) : [] };
  }
  async withdrawals() {
    const payload = envelope.parse(await this.client.get("/api/admin/channelMgr/withdraw/get", { page: "1", count: "100" }));
    const parsed = z.object({ pageData: z.array(record).default([]), totalCount: z.coerce.number().default(0) }).loose().parse(payload.msg);
    return { total: parsed.totalCount, rows: parsed.pageData };
  }
}
