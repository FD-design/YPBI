import { describe, expect, test } from "bun:test";
import { ChannelAdapter } from "./channel.adapter";

describe("ChannelAdapter", () => {
  test("归一化渠道核心指标并计算观看率", async () => {
    const calls: Array<{ path: string; params: Record<string, string> }> = [];
    const client = { get: async (path: string, params: Record<string, string>) => {
      calls.push({ path, params });
      return { code: 200, msg: { totalCount: 1, pageData: [{ channel: "hqw001", parentChannel: "hqw001", pid: "PH", cooperationType: "CPA", sumDate: "2026-07-14T00:00:00.000Z", loginUserCount: 100, registerUserCount: 30, watchUserCount: 80, totalClickedCount: 120, totalClickedPerson: 60, totalChargeUserCount: 4, totalChargeAmt: "88.5", androidLoginUserCount: 70, iosLoginUserCount: 30 }] } };
    } } as any;
    const result = await new ChannelAdapter(client).details({ platformId: "PH", dateRange: ["2026-07-14", "2026-07-15"], page: 3, pageSize: 20 });
    expect(calls).toEqual([{ path: "/api/admin/statistics/channel/channelDetail", params: {
      page: "3", count: "20", isDiscount: "false", pid: "PH",
      sumDateBegin: "2026-07-14 00:00:00", sumDateEnd: "2026-07-16 00:00:00"
    } }]);
    expect(result.rows[0]).toMatchObject({ channel: "hqw001", cooperationType: "CPA", loginUsers: 100, registeredUsers: 30, viewers: 80, viewRate: 0.8, revenue: 88.5 });
    expect(result.total).toBe(1);
  });

  test("A/B 接口空数据保持真实空态", async () => {
    const calls: Array<{ path: string; params: Record<string, string> }> = [];
    const client = { get: async (path: string, params: Record<string, string>) => {
      calls.push({ path, params });
      return { code: 200, msg: { totalCount: 0, pageData: [] } };
    } } as any;
    const result = await new ChannelAdapter(client).abLanding({ platformId: "PH", dateRange: ["2026-07-14", "2026-07-15"], page: 1, pageSize: 20 });
    expect(calls).toEqual([{ path: "/api/admin/statistics/channel/abLandPage", params: {
      pid: "PH", templateA: "default", templateB: "default", regNumMin: "0", regNumMax: "1000000",
      page: "1", count: "20", sumDateStart: "2026-07-14 00:00:00", sumDateEnd: "2026-07-16 00:00:00"
    } }]);
    expect(result).toEqual({ rows: [], total: 0 });
  });

  test("渠道明细闰日单日请求使用次日零点", async () => {
    const calls: Array<{ path: string; params: Record<string, string> }> = [];
    const client = { get: async (path: string, params: Record<string, string>) => {
      calls.push({ path, params });
      return { msg: { totalCount: 0, pageData: [] } };
    } } as any;
    await new ChannelAdapter(client).details({ platformId: "FBI", dateRange: ["2024-02-29", "2024-02-29"], page: 2, pageSize: 50 });
    expect(calls).toEqual([{ path: "/api/admin/statistics/channel/channelDetail", params: {
      page: "2", count: "50", isDiscount: "false", pid: "FBI",
      sumDateBegin: "2024-02-29 00:00:00", sumDateEnd: "2024-03-01 00:00:00"
    } }]);
  });

  test("A/B年末单日请求保留模板与分页筛选", async () => {
    const calls: Array<{ path: string; params: Record<string, string> }> = [];
    const client = { get: async (path: string, params: Record<string, string>) => {
      calls.push({ path, params });
      return { msg: { totalCount: 0, pageData: [] } };
    } } as any;
    await new ChannelAdapter(client).abLanding({ platformId: "FBI", dateRange: ["2026-12-31", "2026-12-31"], page: 4, pageSize: 50, templateA: "landing-a", templateB: "landing-b" });
    expect(calls).toEqual([{ path: "/api/admin/statistics/channel/abLandPage", params: {
      pid: "FBI", templateA: "landing-a", templateB: "landing-b", regNumMin: "0", regNumMax: "1000000",
      page: "4", count: "50", sumDateStart: "2026-12-31 00:00:00", sumDateEnd: "2027-01-01 00:00:00"
    } }]);
  });
});
