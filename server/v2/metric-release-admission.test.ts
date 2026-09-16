import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyMetricReleaseAdmission } from "./metric-release-admission.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function copyAdmissionFixture() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ypbi-release-admission-"));
  temporaryRoots.push(temporaryRoot);
  for (const relativePath of [
    "server/v2/generated/metric-release-attestation.json",
    "server/v2/generated/metric-definitions.json",
    "server/v2/config/metric-mapping-registry.v1.json",
    "server/platforms/platform-catalog.v1.json"
  ]) {
    const targetPath = path.resolve(temporaryRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(path.resolve(repositoryRoot, relativePath), targetPath);
  }
  return temporaryRoot;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function addResultEvidence(temporaryRoot: string, validatedAt: string) {
  const evidenceRelativePath = "server/v2/validation/evidence/M016/runtime.evidence.json";
  const comparisonRelativePath = "server/v2/validation/evidence/M016/runtime.comparison.json";
  const comparisonSerialized = "{}\n";
  const evidence = {
    evidenceId: evidenceRelativePath,
    metricId: "M016",
    result: "passed",
    validatedAt,
    comparison: {
      artifactPath: comparisonRelativePath,
      contentSha256: sha256(comparisonSerialized)
    }
  };
  const evidenceSerialized = `${JSON.stringify(evidence, null, 2)}\n`;
  for (const [relativePath, serialized] of [
    [comparisonRelativePath, comparisonSerialized],
    [evidenceRelativePath, evidenceSerialized]
  ]) {
    const filePath = path.resolve(temporaryRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, serialized);
  }
  const registryPath = path.resolve(temporaryRoot, "server/v2/config/metric-mapping-registry.v1.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  registry.entries[0].validation = {
    status: "passed",
    mappingVersion: "m016-pday-sum-v1",
    authorityVersion: "v0.23-draft",
    validatedAt,
    evidenceId: evidenceRelativePath,
    evidenceSha256: sha256(evidenceSerialized)
  };
  const registrySerialized = `${JSON.stringify(registry, null, 2)}\n`;
  fs.writeFileSync(registryPath, registrySerialized);
  const attestationPath = path.resolve(temporaryRoot, "server/v2/generated/metric-release-attestation.json");
  const attestation = JSON.parse(fs.readFileSync(attestationPath, "utf8"));
  attestation.registry.contentSha256 = sha256(registrySerialized);
  attestation.validationArtifacts = [{
    metricId: "M016",
    status: "passed",
    evidence: { path: evidenceRelativePath, contentSha256: sha256(evidenceSerialized) },
    comparison: { path: comparisonRelativePath, contentSha256: sha256(comparisonSerialized) }
  }];
  fs.writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
}

describe("metric release admission", () => {
  test("快照、注册表和平台目录与准入证明完全一致时通过", () => {
    const temporaryRoot = copyAdmissionFixture();
    assert.doesNotThrow(() => verifyMetricReleaseAdmission({ repositoryRoot: temporaryRoot }));
  });

  test("任一受约束输入在生成后变化都失败关闭", () => {
    for (const relativePath of [
      "server/v2/generated/metric-definitions.json",
      "server/v2/config/metric-mapping-registry.v1.json",
      "server/platforms/platform-catalog.v1.json"
    ]) {
      const temporaryRoot = copyAdmissionFixture();
      fs.appendFileSync(path.resolve(temporaryRoot, relativePath), "\n");
      assert.throws(() => verifyMetricReleaseAdmission({ repositoryRoot: temporaryRoot }), /发布准入证明不一致/);
    }
  });

  test("仓库根目录为符号链接时拒绝启动", () => {
    const temporaryRoot = copyAdmissionFixture();
    const linkedRoot = `${temporaryRoot}-link`;
    temporaryRoots.push(linkedRoot);
    fs.symlinkSync(temporaryRoot, linkedRoot, "dir");
    assert.throws(() => verifyMetricReleaseAdmission({ repositoryRoot: linkedRoot }), /仓库根目录必须是真实目录/);
  });

  test("结果证据 validatedAt 仅允许最多五分钟时钟偏差", () => {
    const acceptedRoot = copyAdmissionFixture();
    addResultEvidence(acceptedRoot, "2026-09-08T15:30:00+08:00");
    assert.doesNotThrow(() => verifyMetricReleaseAdmission({
      repositoryRoot: acceptedRoot,
      now: new Date("2026-09-08T15:25:00+08:00")
    }));

    const futureRoot = copyAdmissionFixture();
    addResultEvidence(futureRoot, "2099-01-01T00:00:00+08:00");
    assert.throws(() => verifyMetricReleaseAdmission({
      repositoryRoot: futureRoot,
      now: new Date("2026-09-08T15:25:00+08:00")
    }), /validatedAt 晚于当前时间允许范围/);
  });
});
