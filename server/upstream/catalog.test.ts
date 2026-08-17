import { describe, expect, test } from "bun:test";
import { apiCatalog, getApiDefinition } from "./catalog";

describe("apiCatalog", () => {
  test("完整登记 30 个去重接口", () => {
    expect(apiCatalog).toHaveLength(30);
    expect(new Set(apiCatalog.map((item) => item.path)).size).toBe(30);
    expect(new Set(apiCatalog.map((item) => item.id)).size).toBe(30);
  });
  test("每个来源使用固定路径和参数白名单", () => {
    expect(getApiDefinition("overview.daySum")?.params).toContain("pid");
    expect(getApiDefinition("event.stats")?.path).toBe("/api/admin/statistics/trackEventsReport/getEventStats");
  });
});
