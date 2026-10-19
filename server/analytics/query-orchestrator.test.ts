import { describe, expect, test } from "bun:test";
import type { AnalyticsQuery } from "../../contracts/analytics";
import { RetentionAdapter } from "../upstream/retention.adapter";
import type { UpstreamClient } from "../upstream/client";
import { QueryOrchestrator } from "./query-orchestrator";

const query: AnalyticsQuery = { modelId: "retention_quality", analysisType: "retention", metricIds: ["newUsers", "retentionD1", "retentionD3", "retentionD7", "retentionD30"],
  dimensionIds: ["date"], eventIds: [], platformMode: "single", platformIds: ["PH"], dateRange: ["2026-07-10", "2026-07-12"], filters: {}, limit: 50 };
const cohort = (date: string, count: number, inputs: Record<number, number | null> = {}) => ({ pid: "PH", sumDate: `${date}T00:00:00+08:00`, registerCount: count,
  ...Object.fromEntries(Object.entries(inputs).map(([day, loginCnt]) => [`afterFirstData${day}`, { date: "2026-07-13", loginCnt, retentionRate: 0 }])) });
const execute = async (rows: Record<string, unknown>[]) => {
  const retention = new RetentionAdapter({ get: async () => ({ code: 200, data: rows }) } as unknown as UpstreamClient);
  const dependencies = [null, null, null, null, null, retention, null, 2] as unknown as ConstructorParameters<typeof QueryOrchestrator>;
  return new QueryOrchestrator(...dependencies).execute(query);
};

describe("旧留存查询汇总的缺失输入边界", () => {
  test("D1缺失批次不进入分母，各周期独立按有效批次加权", async () => {
    const result = await execute([cohort("2026-07-10", 100, { 1: 25, 3: 20 }), cohort("2026-07-11", 900, { 3: 90 }),
      cohort("2026-07-12", 200, { 1: null, 7: 40 })]);
    expect(result.data.summary).toEqual({ newUsers: 1200, retentionD1: .25, retentionD3: .11, retentionD7: .2, retentionD30: null });
    expect(result.data.rows[1]).toMatchObject({ retainedUsers: null, retentionD1: null });
    expect(result.data.rows[2]).toMatchObject({ retainedUsers: null, retentionD1: null });
  });

  test("全部缺失返回null而不是0，新增人数保持原事实", async () => {
    const result = await execute([cohort("2026-07-10", 100), cohort("2026-07-11", 900)]);
    expect(result.data.summary).toEqual({ newUsers: 1000, retentionD1: null, retentionD3: null, retentionD7: null, retentionD30: null });
  });

  test("真实零回访保留为0，零注册分母没有比例", async () => {
    const result = await execute([cohort("2026-07-10", 100, { 1: 0, 3: 0, 7: 0, 30: 0 })]);
    expect(result.data.summary).toEqual({ newUsers: 100, retentionD1: 0, retentionD3: 0, retentionD7: 0, retentionD30: 0 });
    const noRegistrations = await execute([cohort("2026-07-10", 0, { 1: 0, 3: 0, 7: 0, 30: 0 })]);
    expect(noRegistrations.data.summary).toEqual({ newUsers: 0, retentionD1: null, retentionD3: null, retentionD7: null, retentionD30: null });
  });
});
