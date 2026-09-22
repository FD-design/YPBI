import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDirectoryNavigation } from "./dashboard-directory-model.ts";

test("default navigation shows all categories and keeps the directory visible", () => {
  assert.deepEqual(normalizeDirectoryNavigation(null, ["用户生命周期"]), { query: "", collapsed: [], hidden: false });
});
test("history preserves query, collapsed categories and directory visibility", () => {
  assert.deepEqual(normalizeDirectoryNavigation({ query: "留存", collapsed: ["用户生命周期"], hidden: true }, ["用户生命周期"]),
    { query: "留存", collapsed: ["用户生命周期"], hidden: true });
});
test("stale categories and duplicate collapse entries are removed without inventing a new selection", () => {
  assert.deepEqual(normalizeDirectoryNavigation({ query: "支付", collapsed: ["旧分类", "商业变现", "商业变现", 2] }, ["商业变现"]),
    { query: "支付", collapsed: ["商业变现"], hidden: false });
});
test("malformed history recovers safely and long search is bounded", () => {
  for (const value of [null, 23, [], "invalid", { query: {}, collapsed: {}, hidden: "yes" }]) {
    assert.deepEqual(normalizeDirectoryNavigation(value, ["商业变现"]), { query: "", collapsed: [], hidden: false });
  }
  assert.equal(normalizeDirectoryNavigation({ query: "a".repeat(140) }, []).query.length, 120);
});
