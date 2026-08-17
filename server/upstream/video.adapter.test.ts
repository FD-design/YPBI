import { describe, expect, test } from "bun:test";
import type { AnalyticsQuery } from "../../contracts/analytics";
import type { UpstreamClient } from "./client";
import { VideoAdapter } from "./video.adapter";

const query: AnalyticsQuery = { modelId: "content_position", analysisType: "table", metricIds: ["videoWatchCount", "videoLikeCount"], dimensionIds: ["content"], eventIds: [], platformMode: "single", platformIds: ["PH"], dateRange: ["2026-07-12", "2026-07-14"], filters: {}, limit: 20 };

describe("VideoAdapter", () => {
  test("将视频观看排行归一化为内容表现字段", async () => {
    const client = { get: async () => ({ code: 200, msg: { pageData: [{ pid: "PH", _id: "v1", name: "视频一", watchedCount: "73", likedCount: 8, collectedCount: 3, totalChargeMoney: "12.5", tags: ["c1"] }] } }) } as unknown as UpstreamClient;
    const rows = await new VideoAdapter(client).query(query, "PH");
    expect(rows[0].videoWatchCount).toBe(73);
    expect(rows[0].videoLikeCount).toBe(8);
    expect(rows[0].revenue).toBe(12.5);
    expect(rows[0].platform).toBe("Pornhub");
  });
});
