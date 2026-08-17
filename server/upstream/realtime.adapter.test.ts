import { describe, expect, test } from "bun:test";
import type { AnalyticsQuery } from "../../contracts/analytics";
import type { UpstreamClient } from "./client";
import { RealtimeAdapter } from "./realtime.adapter";

const query: AnalyticsQuery = { modelId: "usage_depth", analysisType: "trend", metricIds: ["viewRate", "avgWatchMinutes"], dimensionIds: ["date"], eventIds: [], platformMode: "single", platformIds: ["PH"], dateRange: ["2026-07-14", "2026-07-14"], filters: {}, limit: 50 };

describe("RealtimeAdapter", () => {
  test("计算观影率和人均观影分钟", async () => {
    const client = { get: async () => ({ code: 200, msg: [{ sumDate: "2026-07-14T00:00:00.000Z", graphDate: "08:00", loginUserCount: 100, newUserCount: 12, watchUserCount: 40, totalUserWatchTime: 4800, totalChargeAmt: "50", totalChargeUserCount: 2 }] }) } as unknown as UpstreamClient;
    const rows = await new RealtimeAdapter(client).query(query, "PH");
    expect(rows[0].viewRate).toBe(0.4);
    expect(rows[0].avgWatchMinutes).toBe(2);
    expect(rows[0].revenue).toBe(50);
    expect(rows[0].newUsers).toBe(12);
    expect(rows[0].date).toBe("2026-07-14 08:00");
  });
});
