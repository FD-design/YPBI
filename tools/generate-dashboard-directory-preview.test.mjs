import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deriveDirectory, generate } from "./generate-dashboard-directory-preview.mjs";

const prd = await readFile(new URL("../docs/requirements/BI-产品需求文档.md", import.meta.url), "utf8");
const taxonomy = JSON.parse(await readFile(new URL("../server/v2/generated/metric-definitions.json", import.meta.url), "utf8"));
test("directory derives all approved boards, without business results or empty categories", () => {
  const result = deriveDirectory(prd, taxonomy);
  assert.equal(result.items.length, 11);
  assert.equal(result.items[0].title, "核心经营总览");
  assert.equal(result.items[0].category, null);
  assert.deepEqual(result.categories, taxonomy.categories.map(({ name }) => name));
  assert.ok(result.items.every((item) => Object.keys(item).join() === "section,title,category,scope,admission"));
  assert.ok(result.categories.every((category) => result.items.some((item) => item.category === category)));
});
test("unknown categories fail rather than silently moving a board", () => {
  assert.throws(() => deriveDirectory(prd.replace("| 首批 1 | 用户生命周期 |", "| 首批 1 | 未登记 |"), taxonomy), /Unknown category/);
});
test("category rename and ordering follow authority without changing section references", () => {
  const renamed = JSON.parse(JSON.stringify(taxonomy));
  renamed.categories[0].name = "生命周期";
  renamed.categories[0].order = 99;
  const result = deriveDirectory(prd.replaceAll("用户生命周期", "生命周期"), renamed);
  assert.equal(result.categories.at(-1), "生命周期");
  assert.equal(result.items.find((item) => item.title === "获客与新增").section, "5.7");
});
test("missing sections, duplicate plans and unexpected table shape fail closed", () => {
  assert.throws(() => deriveDirectory(prd.replace("### 5.7 获客与新增", "### 5.7 其他"), taxonomy), /Missing/);
  assert.throws(() => deriveDirectory(prd.replace("| 首批 2 | 用户生命周期 | 活跃与留存 |", "| 首批 2 | 用户生命周期 | 获客与新增 |"), taxonomy), /Duplicate/);
  assert.throws(() => deriveDirectory(prd.replace("| 首批 1 | 用户生命周期 | 获客与新增 |", "| 首批 1 | 用户生命周期 | |"), taxonomy), /Invalid dashboard plan row/);
});
test("generated preview stays synchronized", async () => { await generate(true); });
