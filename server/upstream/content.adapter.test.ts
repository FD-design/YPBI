import { describe, expect, test } from "bun:test";
import { ContentAdapter } from "./content.adapter";

describe("ContentAdapter", () => {
  test("合并分类的五组排行并计算互动效率", async () => {
    const client = { get: async () => ({ code: 200, msg: { watchedCountRank: [{ categoryName: "精品", watchedCount: 300 }], watchedUserCountRank: [{ categoryName: "精品", watchedUserCount: 100 }], clickedCountRank: [{ categoryName: "精品", clickedCount: 150 }], likedCountRank: [{ categoryName: "精品", likedCount: 10 }], collectedCountRank: [{ categoryName: "精品", collectedCount: 20 }], isUvApproximate: true } }) } as any;
    const result = await new ContentAdapter(client).categories({ platformId: "PH", dateRange: ["2026-07-14", "2026-07-15"], page: 1, pageSize: 20 });
    expect(result.approximateUv).toBe(true);
    expect(result.rows[0]).toMatchObject({ category: "精品", watches: 300, viewers: 100, clicks: 150, watchesPerViewer: 3, playPerClick: 2, likeRate: 0.1, collectRate: 0.2 });
  });
});
