import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildM016Candidate } from "./build-m016-candidate.mjs";
import { compareM016Datasets, readM016ValidationContext } from "./validate-m016.mjs";

const context = readM016ValidationContext();
const dateRange = ["2026-09-01", "2026-09-07"];
const cli = fileURLToPath(new URL("./build-m016-candidate.mjs", import.meta.url));
function responses() {
  return context.pids.map((pid) => ({
    success: true,
    data: {
      metric: {
        id: "M016", code: "daily_active_user_count", name: "日活跃用户数", definition: "测试定义", unit: "人", valueType: "integer",
        authority: { document: "全站指标体系.md", version: context.entry.authorityVersion, validationStatus: "pending_validation", statusLabel: "技术称已实现（待验数）" },
        capabilities: { grains: ["day"], platformMode: "single_pid", dimensions: [], filters: [], comparisons: [] }
      },
      scope: { pid, platformName: pid }, grain: "day", dateRange: [...dateRange], seriesStatus: "available",
      points: Array.from({ length: 7 }, (_, index) => ({ businessDate: `2026-09-0${index + 1}`, value: index, state: "available" })),
      unavailableDates: []
    },
    meta: { queryId: `query-${pid}`, sourceApiIds: [...context.entry.mapping.sourceApiIds], fetchedAt: "2026-09-08T00:00:00+08:00", mappingVersion: context.entry.mappingVersion, validationStatus: "pending_validation", watermark: null, warnings: [] }
  }));
}

test("候选从查询合同转换且继承当前目录版本，0 / null / 缺行保持不同", () => {
  const input = responses();
  input[0].data.points.splice(1, 2);
  input[0].data.unavailableDates = [{ businessDate: "2026-09-02", state: "no_value" }, { businessDate: "2026-09-03", state: "no_record" }];
  input[0].data.seriesStatus = "partial";
  const output = buildM016Candidate(input.reverse(), "test-candidate");
  assert.equal(output.platformCatalogRevision, context.revision);
  assert.equal(output.platformCatalogContentSha256, context.contentSha256);
  assert.equal(output.rows[0].pid, context.pids[0]);
  assert.equal(output.rows[0].value, 0);
  assert.equal(output.rows[1].value, null);
  assert.equal(output.rows.some((row) => row.pid === context.pids[0] && row.businessDate === "2026-09-03"), false);
  assert.equal(output.kind, "controlled_technical_query");
  assert.equal(JSON.stringify(output).includes("query-"), false);
  assert.equal("watermark" in output, false);
});

test("未知 / 缺失 / 重复 PID 在生成之前失败", () => {
  assert.throws(() => buildM016Candidate(responses().slice(1), "test"), /每个启用 PID/);
  const duplicate = responses(); duplicate[1] = structuredClone(duplicate[0]);
  assert.throws(() => buildM016Candidate(duplicate, "test"), /重复 PID/);
  const unknown = responses(); unknown[0].data.scope.pid = "UNKNOWN";
  assert.throws(() => buildM016Candidate(unknown, "test"), /未知/);
});

test("畸形响应和非整数值沿用公共合同拒绝，错误不泄露原始内容", () => {
  const bad = responses(); bad[0].token = "must-not-leak";
  assert.throws(() => buildM016Candidate(bad, "test"), (error) => /不满足 M016 查询契约/.test(error.message) && !error.message.includes("must-not-leak"));
  const fractional = responses(); fractional[0].data.points[0].value = 0.5;
  assert.throws(() => buildM016Candidate(fractional, "test"), /不满足/);
  const missing = responses(); missing[0].data.points.pop();
  assert.throws(() => buildM016Candidate(missing, "test"), /不满足/);
});

test("跨版本、来源或日期范围的拼接被拒绝", () => {
  for (const mutate of [
    (response) => { response.meta.mappingVersion = "stale"; },
    (response) => { response.data.metric.authority.version = "stale"; },
    (response) => { response.meta.sourceApiIds = ["/api/unregistered"]; },
    (response) => { response.data.dateRange[0] = "2026-09-02"; response.data.points.shift(); }
  ]) {
    const input = responses(); mutate(input[0]);
    assert.throws(() => buildM016Candidate(input, "test"), /版本|来源|日期范围/);
  }
});

test("每份响应都必须在覆盖期结束后采集，拒绝未来采集时间", () => {
  for (const fetchedAt of ["2026-09-07T23:59:59+08:00", "2099-01-01T00:00:00Z"]) {
    const input = responses(); input[0].meta.fetchedAt = fetchedAt;
    assert.throws(() => buildM016Candidate(input, "test"), /采集/);
  }
});

test("产物可以直接交给现有比较工具，一致也只到人工待复核", () => {
  const candidate = buildM016Candidate(responses(), "test-candidate");
  const comparison = compareM016Datasets({
    candidate,
    reference: { ...candidate, kind: "independent_sql", artifactId: "test-independent-reference" },
    expectedPids: context.pids, dateRange,
    authorityVersion: context.entry.authorityVersion, mappingVersion: context.entry.mappingVersion,
    platformCatalogRevision: context.revision, platformCatalogContentSha256: context.contentSha256
  });
  assert.equal(comparison.result, "pending_review");
  assert.equal(comparison.checks.filter((item) => item.status === "pending").length, 4);
});

test("CLI 只写指定新文件，权限 0600，不覆盖已有内容或将业务行输出到日志", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ypbi-m016-candidate-"));
  try {
    const input = path.join(dir, "responses.json");
    const output = path.join(dir, "candidate.json");
    fs.writeFileSync(input, JSON.stringify(responses()));
    const run = () => spawnSync(process.execPath, ["--experimental-strip-types", cli, "--responses", input, "--output", output], { encoding: "utf8" });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).validationStatus, "not_validated");
    assert.equal(first.stdout.includes("businessDate"), false);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const saved = fs.readFileSync(output, "utf8");
    const second = run();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /不覆盖/);
    assert.equal(fs.readFileSync(output, "utf8"), saved);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
