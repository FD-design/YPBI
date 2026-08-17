import { describe, expect, test } from "bun:test";
import type { AnalyticsQuery } from "../../contracts/analytics";
import type { UpstreamClient } from "./client";
import { EventAdapter } from "./event.adapter";

const query: AnalyticsQuery = { modelId: "payment_conversion", analysisType: "funnel", metricIds: [], dimensionIds: ["platform"], eventIds: ["vip_click", "pre_pay", "success_pay"], platformMode: "single", platformIds: ["PH"], dateRange: ["2026-07-14", "2026-07-15"], filters: {}, limit: 50 };

describe("EventAdapter", () => {
  test("将汇总事件转换为带步骤转化率的漏斗", async () => {
    const client = { get: async () => ({ code: 200, msg: { pageData: [{ pid: "PH", vipClick: 100, prePay: 40, successPay: 10 }] } }) } as unknown as UpstreamClient;
    const rows = await new EventAdapter(client).queryFunnel(query, "PH");
    expect(rows.map((row) => row.value)).toEqual([100, 40, 10]);
    expect(rows[2].conversion).toBe(0.1);
    expect(rows[2].stepConversion).toBe(0.25);
  });
});
