import { z } from "zod";
import type { UpstreamClient } from "./client";
import { getApiDefinition } from "./catalog";

const envelopeSchema = z.object({ code: z.union([z.string(), z.number()]).optional(), msg: z.unknown().optional() }).loose();

export class SourceQueryError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: string[] = []) { super(message); }
}

export class SourceService {
  constructor(private readonly client: UpstreamClient) {}

  async query(id: string, rawParams: Record<string, unknown>) {
    const definition = getApiDefinition(id);
    if (!definition) throw new SourceQueryError("UNKNOWN_SOURCE", "数据源不存在");
    const unknown = Object.keys(rawParams).filter((key) => !definition.params.includes(key));
    if (unknown.length) throw new SourceQueryError("UNKNOWN_PARAMETER", "请求包含未开放参数", unknown);
    const invalid = Object.entries(rawParams).flatMap(([key, value]) => {
      const text = String(value ?? "");
      if (text.length > 128) return [`${key} 长度不能超过 128`];
      if (key === "count" && (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 100)) return ["count 必须为 1 到 100 的整数"];
      if (key === "page" && (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 10000)) return ["page 必须为 1 到 10000 的整数"];
      return [];
    });
    if (invalid.length) throw new SourceQueryError("INVALID_PARAMETER", "请求参数超出允许范围", invalid);
    const params = Object.fromEntries(Object.entries(rawParams).filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => [key, String(value)]));
    const raw = await this.client.get(definition.path, params);
    if (definition.responseShape === "json") return { definition, rows: [], raw, pagination: undefined };
    const envelope = envelopeSchema.parse(raw);
    if (definition.responseShape === "paged") {
      const msg = z.object({ pageData: z.array(z.unknown()).default([]) }).loose().parse(envelope.msg);
      return { definition, rows: msg.pageData, pagination: { page: Number(params.page ?? 1), pageSize: Number(params.count ?? msg.pageData.length), total: Number(Reflect.get(msg, "total") ?? msg.pageData.length) } };
    }
    if (definition.responseShape === "array") return { definition, rows: z.array(z.unknown()).parse(envelope.msg), pagination: undefined };
    return { definition, rows: envelope.msg === undefined ? [] : [envelope.msg], pagination: undefined };
  }
}
