import { describe, expect, test } from "bun:test";
import type { AnalyticsQuery } from "../../contracts/analytics";
import type { UpstreamClient } from "./client";
import { RetentionAdapter } from "./retention.adapter";

const query: AnalyticsQuery = { modelId: "retention_quality", analysisType: "retention", metricIds: ["newUsers", "retentionD1"], dimensionIds: ["date"], eventIds: [], platformMode: "single", platformIds: ["PH"], dateRange: ["2026-07-12", "2026-07-12"], filters: {}, limit: 50 };

describe("RetentionAdapter", () => {
  const clientFor = (fields: Record<string, unknown> = {}) => ({ get: async () => ({ code: 200, data: [
    { sumDate: "2026-07-11T16:00:00.000Z", pid: "PH", registerCount: 1000, ...fields }
  ] }) }) as unknown as UpstreamClient;

  test("四周期缺观察对象或对象为null时保留缺失，不生成D1假零", async () => {
    for (const fields of [{}, Object.fromEntries([1, 3, 7, 30].map(day => [`afterFirstData${day}`, null]))]) {
      const [row] = await new RetentionAdapter(clientFor(fields)).query(query, "PH");
      for (const key of ["retainedUsers", "retainedUsersD3", "retainedUsersD7", "retainedUsersD30", "retentionD1", "retentionD3", "retentionD7", "retentionD30"] as const) {
        expect(row[key]).toBeNull();
      }
    }
  });

  test("四周期缺失、null、空串和空白计数不被coerce成0", async () => {
    for (const missing of [undefined, null, "", " ", "\t"]) {
      const fields = Object.fromEntries([1, 3, 7, 30].map(day => [`afterFirstData${day}`, { date: "2026-07-13", loginCnt: missing, retentionRate: 0 }]));
      const [row] = await new RetentionAdapter(clientFor(fields)).query(query, "PH");
      for (const key of ["retainedUsers", "retainedUsersD3", "retainedUsersD7", "retainedUsersD30", "retentionD1", "retentionD3", "retentionD7", "retentionD30"] as const) {
        expect(row[key]).toBeNull();
      }
    }
  });

  test("四周期真实零和数字字符串保持可计算值", async () => {
    for (const input of [0, "0", 125, "125", " 125 "]) {
      const fields = Object.fromEntries([1, 3, 7, 30].map(day => [`afterFirstData${day}`, { date: "2026-07-13", loginCnt: input, retentionRate: 0 }]));
      const [row] = await new RetentionAdapter(clientFor(fields)).query(query, "PH");
      for (const key of ["retainedUsers", "retainedUsersD3", "retainedUsersD7", "retainedUsersD30"] as const) expect(row[key]).toBe(Number(input));
      for (const key of ["retentionD1", "retentionD3", "retentionD7", "retentionD30"] as const) expect(row[key]).toBe(Number(input) / 1000);
    }
  });

  test("非法人数拒绝整条来源，不接受布尔、负数、小数或非安全整数", async () => {
    for (const day of [1, 3, 7, 30]) for (const invalid of [false, true, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "abc", "1.5", {}, []]) {
      await expect(new RetentionAdapter(clientFor({ [`afterFirstData${day}`]: { date: "2026-07-13", loginCnt: invalid, retentionRate: 0 } })).query(query, "PH")).rejects.toThrow();
    }
  });

  test("注册基数缺失或非法时拒绝来源，不生成假零分母", async () => {
    for (const registerCount of [undefined, null, "", " ", false, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(new RetentionAdapter(clientFor({ registerCount })).query(query, "PH")).rejects.toThrow();
    }
    const [row] = await new RetentionAdapter(clientFor({ registerCount: 0, afterFirstData1: { date: "2026-07-13", loginCnt: 0, retentionRate: 0 } })).query(query, "PH");
    expect(row.retainedUsers).toBe(0); expect(row.retentionD1).toBeNull();
  });

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
