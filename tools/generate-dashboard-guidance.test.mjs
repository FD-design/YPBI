import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deriveGuidance, generate } from "./generate-dashboard-guidance.mjs";

const table = "| 文案键 | 区块名称 | 分析说明 |\n|---|---|---|\n| core.results | 主结果 | 规模和收入是否变化 |\n";
test("唯一 PRD 文案表生成稳定键与原文", () => {
  assert.deepEqual(deriveGuidance(table), [{ key: "core.results", title: "主结果", description: "规模和收入是否变化" }]);
  assert.throws(() => deriveGuidance(table + table));
  assert.throws(() => deriveGuidance(table + "| core.results | 另一标题 | 描述 |\n"));
  assert.throws(() => deriveGuidance(table.replace("规模和收入是否变化", "")));
});
test("当前 11 板文案派生无漂移", async () => {
  const entries = deriveGuidance(await readFile(new URL("../docs/requirements/BI-产品需求文档.md", import.meta.url), "utf8"));
  assert.ok(entries.length >= 40);
  await generate(true);
});
