import { describe, expect, test } from "bun:test";
import type { UpstreamClient } from "./client";
import { SearchAdapter } from "./search.adapter";

describe("SearchAdapter", () => {
  test("转换热搜词并兼容字符串次数", async () => {
    const client = { get: async () => ({ code: 200, msg: { pageData: [{ pid: "PH", words: "测试词", searchCnt: "123" }] } }) } as unknown as UpstreamClient;
    const rows = await new SearchAdapter(client).queryRanking("PH", 20);
    expect(rows).toEqual([{ platform: "Pornhub", keyword: "测试词", searchCount: 123 }]);
  });
});
