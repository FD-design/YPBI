import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("仓库内固定投影无需仓库外权威文档即可通过完整性校验", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "tools/verify-repository-projections.mjs"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /仓库内固定投影已校验/);
});
