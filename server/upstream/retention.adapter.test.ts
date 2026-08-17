import { describe, expect, test } from "bun:test";
import type { AnalyticsQuery } from "../../contracts/analytics";
import type { UpstreamClient } from "./client";
import { RetentionAdapter } from "./retention.adapter";

const query: AnalyticsQuery = { modelId: "retention_quality", analysisType: "retention", metricIds: ["newUsers", "retentionD1"], dimensionIds: ["date"], eventIds: [], platformMode: "single", platformIds: ["PH"], dateRange: ["2026-07-12", "2026-07-12"], filters: {}, limit: 50 };

describe("RetentionAdapter", () => {
  test("使用注册人数和次日登录人数计算 D1", async () => {
    const client = { get: async () => ({ code: 200, data: [{ sumDate: "2026-07-11T16:00:00.000Z", pid: "PH", registerCount: 1000, afterFirstData1: { date: "2026-07-12T16:00:00.000Z", loginCnt: 125, retentionRate: "0.125" } }] }) } as unknown as UpstreamClient;
    const rows = await new RetentionAdapter(client).query(query, "PH");
    expect(rows[0].newUsers).toBe(1000);
    expect(rows[0].date).toBe("2026-07-12");
    expect(rows[0].retainedUsers).toBe(125);
    expect(rows[0].retentionD1).toBe(0.125);
  });

  test("解析 D3 D7 D30 并保留未到观察期为空", async () => {
    const client = { get: async () => ({ code: 200, data: [{ sumDate: "2026-06-01T16:00:00.000Z", pid: "PH", registerCount: 1000, afterFirstData1: { date: "2026-06-02T16:00:00.000Z", loginCnt: 200, retentionRate: "0.2" }, afterFirstData3: { date: "2026-06-04T16:00:00.000Z", loginCnt: 150, retentionRate: "0.15" }, afterFirstData7: { date: "2026-06-08T16:00:00.000Z", loginCnt: 100, retentionRate: "0.1" } }] }) } as unknown as UpstreamClient;
    const [row] = await new RetentionAdapter(client).query(query, "PH");
    expect(row.retentionD3).toBe(0.15);
    expect(row.retentionD7).toBe(0.1);
    expect(row.retentionD30).toBeNull();
  });
});
