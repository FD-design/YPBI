import { describe, expect, test } from "bun:test";
import { ChannelAdapter } from "./channel.adapter";

describe("ChannelAdapter", () => {
  test("归一化渠道核心指标并计算观看率", async () => {
    const client = { get: async () => ({ code: 200, msg: { totalCount: 1, pageData: [{ channel: "hqw001", parentChannel: "hqw001", pid: "PH", cooperationType: "CPA", sumDate: "2026-07-14T00:00:00.000Z", loginUserCount: 100, registerUserCount: 30, watchUserCount: 80, totalClickedCount: 120, totalClickedPerson: 60, totalChargeUserCount: 4, totalChargeAmt: "88.5", androidLoginUserCount: 70, iosLoginUserCount: 30 }] } }) } as any;
    const result = await new ChannelAdapter(client).details({ platformId: "PH", dateRange: ["2026-07-14", "2026-07-15"], page: 1, pageSize: 20 });
    expect(result.rows[0]).toMatchObject({ channel: "hqw001", cooperationType: "CPA", loginUsers: 100, registeredUsers: 30, viewers: 80, viewRate: 0.8, revenue: 88.5 });
    expect(result.total).toBe(1);
  });

  test("A/B 接口空数据保持真实空态", async () => {
    const client = { get: async () => ({ code: 200, msg: { totalCount: 0, pageData: [] } }) } as any;
    const result = await new ChannelAdapter(client).abLanding({ platformId: "PH", dateRange: ["2026-07-14", "2026-07-15"], page: 1, pageSize: 20 });
    expect(result).toEqual({ rows: [], total: 0 });
  });
});
