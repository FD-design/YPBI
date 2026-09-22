import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareM016Datasets,
  parseM016ValidationDataset,
  precheckM016Reference
} from "./validate-m016.mjs";

const validationToolPath = fileURLToPath(new URL("./validate-m016.mjs", import.meta.url));

const context = Object.freeze({
  expectedPids: ["PH", "TT"],
  dateRange: ["2026-09-01", "2026-09-07"],
  authorityVersion: "v0.23-draft",
  mappingVersion: "m016-pday-sum-v1",
  platformCatalogRevision: 7,
  platformCatalogContentSha256: "b".repeat(64)
});

function dataset(kind, rows, overrides = {}) {
  return {
    schemaVersion: "m016-validation-dataset/v1",
    kind,
    metricId: "M016",
    authorityVersion: context.authorityVersion,
    mappingVersion: context.mappingVersion,
    platformCatalogRevision: context.platformCatalogRevision,
    platformCatalogContentSha256: context.platformCatalogContentSha256,
    generatedAt: kind === "controlled_technical_query"
      ? "2026-09-08T15:10:00+08:00"
      : "2026-09-08T15:20:00+08:00",
    artifactId: kind === "controlled_technical_query" ? "candidate-run-001" : "reference-run-001",
    dateRange: context.dateRange,
    rows,
    ...overrides
  };
}

function completeRows() {
  return context.expectedPids.flatMap((pid, pidIndex) => (
    Array.from({ length: 7 }, (_, dayIndex) => ({
      pid,
      businessDate: `2026-09-0${dayIndex + 1}`,
      value: pidIndex === 0 && dayIndex === 0 ? 0 : (pidIndex + 1) * 10 + dayIndex
    }))
  ));
}

function compare(candidateRows = completeRows(), referenceRows = completeRows(), overrides = {}) {
  return compareM016Datasets({
    candidate: dataset("controlled_technical_query", candidateRows, overrides.candidate),
    reference: dataset("independent_sql", referenceRows, overrides.reference),
    ...context,
    ...overrides.context
  });
}

function checkById(result, id) {
  return result.checks.find((item) => item.id === id);
}

test("完全一致的数据只进入 pending_review，且摘要不泄露逐行业务数值", () => {
  const result = compare();

  assert.equal(result.result, "pending_review");
  for (const id of ["platform_scope", "business_date_completeness", "row_contract", "null_zero_integrity", "reference_value_match"]) {
    assert.equal(checkById(result, id)?.status, "passed");
  }
  for (const id of ["business_definition", "timezone_boundary", "exclusion_rules", "freshness_backfill"]) {
    assert.equal(checkById(result, id)?.status, "pending");
  }
  assert.equal("rows" in result.candidate, false);
  assert.equal("rows" in result.reference, false);
  assert.equal(result.candidate.kind, "controlled_technical_query");
});

test("无 candidate 时可先离线预检独立参考数据，且只输出摘要", () => {
  const result = precheckM016Reference({
    reference: dataset("approved_export", completeRows()),
    ...context
  });

  assert.equal(result.result, "ready_for_candidate");
  assert.equal(checkById(result, "platform_scope")?.status, "passed");
  assert.equal(checkById(result, "reference_value_match")?.status, "pending");
  assert.equal("rows" in result.reference, false);

  const incomplete = precheckM016Reference({
    reference: dataset("approved_export", completeRows().filter((row) => row.pid !== "TT")),
    ...context
  });
  assert.equal(incomplete.result, "failed");
  assert.equal(checkById(incomplete, "platform_scope")?.status, "failed");
});

test("缺 PID 和缺日期均阻断自动比对", async (contextTest) => {
  await contextTest.test("缺 PID", () => {
    const result = compare(completeRows().filter((row) => row.pid !== "TT"));
    assert.equal(result.result, "failed");
    assert.equal(checkById(result, "platform_scope")?.status, "failed");
    assert.equal(checkById(result, "business_date_completeness")?.status, "failed");
  });
  await contextTest.test("缺日期", () => {
    const result = compare(completeRows().slice(0, -1));
    assert.equal(result.result, "failed");
    assert.equal(checkById(result, "business_date_completeness")?.status, "failed");
    assert.equal(checkById(result, "reference_value_match")?.status, "failed");
  });
});

test("重复行被 row_contract 明确拒绝", () => {
  const rows = completeRows();
  rows.push({ ...rows[0] });
  const result = compare(rows);

  assert.equal(result.result, "failed");
  assert.equal(checkById(result, "row_contract")?.status, "failed");
});

test("数据行数按当前 PID × 业务日限制，拒绝先物化异常大范围", () => {
  const oversizedRows = Array.from({ length: 29 }, () => ({ ...completeRows()[0] }));
  assert.throws(() => compare(oversizedRows), /超出当前 PID × 业务日允许的验数上限/);
});

test("真实 0 可通过，null 与 0 不等价", async (contextTest) => {
  await contextTest.test("双方真实 0", () => {
    const result = compare();
    assert.equal(checkById(result, "null_zero_integrity")?.status, "passed");
    assert.equal(checkById(result, "reference_value_match")?.status, "passed");
  });
  await contextTest.test("candidate null、reference 0", () => {
    const candidateRows = completeRows();
    candidateRows[0] = { ...candidateRows[0], value: null };
    const result = compare(candidateRows);
    assert.equal(result.result, "failed");
    assert.equal(checkById(result, "null_zero_integrity")?.status, "failed");
    assert.equal(checkById(result, "reference_value_match")?.status, "failed");
  });
});

test("任一业务日数值不一致即失败", () => {
  const referenceRows = completeRows();
  referenceRows[3] = { ...referenceRows[3], value: 10 };
  const result = compare(completeRows(), referenceRows);

  assert.equal(result.result, "failed");
  assert.equal(checkById(result, "reference_value_match")?.failureCount, 1);
});

test("数据集版本、平台目录 revision 和范围必须绑定当前计划", async (contextTest) => {
  for (const [name, overrides, expected] of [
    ["authority version", { candidate: { authorityVersion: "v0.22-draft" } }, /authorityVersion 与当前验数计划不一致/],
    ["mapping version", { reference: { mappingVersion: "m016-pday-sum-v0" } }, /mappingVersion 与当前验数计划不一致/],
    ["platform revision", { candidate: { platformCatalogRevision: 6 } }, /platformCatalogRevision 与当前验数计划不一致/],
    ["platform content", { candidate: { platformCatalogContentSha256: "c".repeat(64) } }, /platformCatalogContentSha256 与当前验数计划不一致/],
    ["date range", { reference: { dateRange: ["2026-09-02", "2026-09-08"] } }, /dateRange 与当前验数计划不一致/]
  ]) {
    await contextTest.test(name, () => {
      assert.throws(() => compare(completeRows(), completeRows(), overrides), expected);
    });
  }
});

test("验数范围统一限制为 7～366 个完整业务日，并拒绝无效日历日期", () => {
  assert.throws(
    () => parseM016ValidationDataset(dataset("controlled_technical_query", [], { dateRange: ["2026-09-01", "2026-09-06"] }), "candidate"),
    /7～366/
  );
  assert.throws(
    () => parseM016ValidationDataset(dataset("controlled_technical_query", [], { dateRange: ["2026-02-31", "2026-03-09"] }), "candidate"),
    /有效的 YYYY-MM-DD/
  );
  assert.throws(
    () => parseM016ValidationDataset(dataset("controlled_technical_query", [], { generatedAt: "2026-02-31T12:00:00+08:00" }), "candidate"),
    /有效的 YYYY-MM-DD|带时区的 ISO 时间/
  );
});

test("candidate 必须显式声明由受控技术查询生成，且拒绝额外 Token 字段", () => {
  assert.throws(
    () => parseM016ValidationDataset(dataset("candidate", completeRows()), "candidate"),
    /kind 与数据集用途不一致/
  );
  assert.throws(
    () => parseM016ValidationDataset({
      ...dataset("controlled_technical_query", completeRows()),
      token: "redacted"
    }, "candidate"),
    /字段不符合约定/
  );
});

test("CLI 只读且无权覆盖文件，也不会在 JSON 错误中回显输入片段", (contextTest) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ypbi-m016-cli-"));
  contextTest.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const outputPath = path.join(temporaryDirectory, "must-not-exist.json");
  const rejectedOutput = spawnSync(process.execPath, [validationToolPath, "--plan", "--output", outputPath], { encoding: "utf8" });
  assert.notEqual(rejectedOutput.status, 0);
  assert.match(rejectedOutput.stderr, /未知或不完整参数/);
  assert.equal(fs.existsSync(outputPath), false);

  const invalidPath = path.join(temporaryDirectory, "invalid.json");
  fs.writeFileSync(invalidPath, "{\"value\":12345678901234567890,");
  const invalidJson = spawnSync(process.execPath, [validationToolPath, "--check-reference", invalidPath], { encoding: "utf8" });
  assert.notEqual(invalidJson.status, 0);
  assert.match(invalidJson.stderr, /reference 数据集不是有效 JSON/);
  assert.doesNotMatch(invalidJson.stderr, /12345678901234567890/);
});
