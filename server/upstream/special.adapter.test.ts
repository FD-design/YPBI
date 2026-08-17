import { describe, expect, test } from "bun:test";
import { SpecialAdapter } from "./special.adapter";

const query = { platformId: "PH", dateRange: ["2026-07-14", "2026-07-15"] as [string, string], page: 1, pageSize: 20 };
const clientWith = (row: Record<string, unknown>, totalCount = 1) => ({ get: async () => ({ code: 200, msg: { totalCount, pageData: [row] } }) }) as any;

describe("SpecialAdapter", () => {
  test("归一化导航点击并计算人均点击", async () => {
    const adapter = new SpecialAdapter(clientWith({ pid: "PH", sumDate: "2026-07-14T00:00:00Z", name: "导航A", cateName: "游戏", navMark: "ph1", pos: 1, navClickIpsCount: 10, navClickTotalCount: 25, url: "https://example.com" }));
    const result = await adapter.navigation(query);
    expect(result.rows[0]).toMatchObject({ name: "导航A", clickUsers: 10, clicks: 25, clicksPerUser: 2.5 });
  });

  test("归一化快照内容表现", async () => {
    const adapter = new SpecialAdapter(clientWith({ snapshotId: "s1", name: "图集", viewCnt: 120, likedCnt: 8, collectedCnt: 3, totalCnt: 32, tags: ["人体"], payType: "free", state: "上架", status: "审核通过", releaseDate: "2026-07-14T10:00:00Z" }));
    const result = await adapter.snapshots(query);
    expect(result.rows[0]).toMatchObject({ snapshotId: "s1", views: 120, likes: 8, contentCount: 32, tags: "人体" });
  });

  test("归一化CNZZ下载转化", async () => {
    const adapter = new SpecialAdapter(clientWith({ channel: "c1", pid: "PH", sumDate: "2026-07-14T00:00:00Z", totalVistCount: 100, usersCount: 40, totalDownCount: 20, repeatDownload: 5, androidCount: 12, iosCount: 8 }));
    const result = await adapter.cnzz(query);
    expect(result.rows[0]).toMatchObject({ channel: "c1", visits: 100, users: 40, downloads: 20, downloadRate: 0.2 });
  });
});
