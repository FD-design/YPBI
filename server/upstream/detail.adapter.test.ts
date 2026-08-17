import { describe, expect, test } from "bun:test";
import type { UpstreamClient } from "./client";
import { DetailAdapter } from "./detail.adapter";

const query = { platformId: "PH", dateRange: ["2026-07-13", "2026-07-14"] as [string, string], page: 1, pageSize: 20 };

describe("DetailAdapter", () => {
  test("用户观看时长保留原值，不擅自换算单位", async () => {
    const client = { get: async () => ({ code: 200, msg: { pageData: [{ pid: "PH", uid: "u1", sumDate: "2026-07-13T00:00:00.000Z", watchedTime: 123456, watchedVideoCount: 9, watchCount: 20 }] } }) } as unknown as UpstreamClient;
    const rows = await new DetailAdapter(client).users(query);
    expect(rows[0].watchedTimeRaw).toBe(123456);
    expect(rows[0].userId).toBe("u1");
  });
  test("圈子接口按返回 pid 二次过滤", async () => {
    const client = { get: async () => ({ code: 200, msg: { pageData: [{ pid: "PH", circleId: "c1", circleName: "圈子一", watchedCount: 10 }, { pid: "TT", circleId: "c2", watchedCount: 20 }] } }) } as unknown as UpstreamClient;
    const rows = await new DetailAdapter(client).circles(query);
    expect(rows).toHaveLength(1);
    expect(rows[0].circleName).toBe("圈子一");
  });
});
