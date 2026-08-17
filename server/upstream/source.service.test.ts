import { describe, expect, test } from "bun:test";
import type { UpstreamClient } from "./client";
import { SourceQueryError, SourceService } from "./source.service";

describe("SourceService", () => {
  test("拒绝目录未声明的查询参数", async () => {
    const client = { get: async () => ({}) } as unknown as UpstreamClient;
    const service = new SourceService(client);
    expect(service.query("overview.daySum", { pid: "PH", unsafe: "1" })).rejects.toBeInstanceOf(SourceQueryError);
  });

  test("归一化分页响应", async () => {
    const client = { get: async () => ({ code: 200, msg: { pageData: [{ pid: "PH" }], total: 1 } }) } as unknown as UpstreamClient;
    const result = await new SourceService(client).query("overview.daySum", { pid: "PH", page: 1, count: 20 });
    expect(result.rows).toEqual([{ pid: "PH" }]);
    expect(result.pagination?.total).toBe(1);
  });

  test("渠道类型统计允许原后台实际使用的平台和渠道参数", async () => {
    const client = { get: async (_path: string, params: Record<string, string>) => ({ code: 200, msg: { pageData: [{ pid: params.pid, channel: params.channel }], totalCount: 1 } }) } as unknown as UpstreamClient;
    const result = await new SourceService(client).query("channel.byType", { page: 1, count: 10, pid: "PH", channel: "A001", cooperationType: "CPC", sumDateBegin: "2026-07-20 00:00:00", sumDateEnd: "2026-07-21 00:00:00" });
    expect(result.rows).toEqual([{ pid: "PH", channel: "A001" }]);
  });

  test("拒绝超大分页和异常长参数", async () => {
    const client = { get: async () => ({}) } as unknown as UpstreamClient;
    const service = new SourceService(client);
    await expect(service.query("overview.daySum", { page: 1, count: 10000, pid: "PH" })).rejects.toMatchObject({ code: "INVALID_PARAMETER" });
    await expect(service.query("overview.daySum", { page: 1, count: 20, pid: "X".repeat(200) })).rejects.toMatchObject({ code: "INVALID_PARAMETER" });
  });
});
