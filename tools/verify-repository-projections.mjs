import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMetricDefinitionsUiProjection,
  canonicalJson,
  verifyContentHash
} from "./generate-metric-definitions.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function verifyPinnedFile(pin, expectedPath, label) {
  assert.equal(pin.path, expectedPath, `${label}路径不符合固定契约`);
  assert.match(pin.contentSha256, /^[a-f0-9]{64}$/, `${label}哈希无效`);
  const absolutePath = path.resolve(repositoryRoot, pin.path);
  assert.ok(absolutePath.startsWith(`${repositoryRoot}${path.sep}`), `${label}路径越过仓库根目录`);
  assert.equal(fs.lstatSync(absolutePath).isSymbolicLink(), false, `${label}不能是符号链接`);
  assert.equal(sha256(fs.readFileSync(absolutePath)), pin.contentSha256, `${label}与发布准入证明不一致`);
}

function assertUniqueItems(projection, label) {
  assert.ok(Array.isArray(projection.items) && projection.items.length > 0, `${label}缺少条目`);
  const ids = projection.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, `${label}存在重复 ID`);
  for (const item of projection.items) {
    assert.equal(typeof item.id, "string", `${label}条目缺少 ID`);
    assert.equal(typeof item.name, "string", `${label}条目缺少名称`);
  }
}

const metricSnapshot = readJson("server/v2/generated/metric-definitions.json");
assert.equal(verifyContentHash(metricSnapshot), true, "指标目录快照内容哈希无效");
assert.equal(metricSnapshot.snapshot.counts.total, metricSnapshot.items.length, "指标目录计数不一致");
assertUniqueItems(metricSnapshot, "指标目录快照");

const uiProjection = readJson("src/v2/generated/metric-definitions-ui.json");
assert.equal(
  canonicalJson(uiProjection),
  canonicalJson(buildMetricDefinitionsUiProjection(metricSnapshot)),
  "指标界面投影与仓库内指标目录快照不一致"
);

const releaseAdmission = readJson("server/v2/generated/metric-release-attestation.json");
assert.equal(releaseAdmission.schemaVersion, "metric-release-admission/v1", "指标发布准入证明版本无效");
verifyPinnedFile(releaseAdmission.snapshot, "server/v2/generated/metric-definitions.json", "指标目录快照");
verifyPinnedFile(releaseAdmission.registry, "server/v2/config/metric-mapping-registry.v1.json", "指标映射注册表");
verifyPinnedFile(releaseAdmission.platformCatalog, "server/platforms/platform-catalog.v1.json", "平台目录");
assert.ok(Array.isArray(releaseAdmission.validationArtifacts), "指标发布准入证明缺少验数产物清单");
for (const artifact of releaseAdmission.validationArtifacts) {
  verifyPinnedFile(artifact.evidence, artifact.evidence.path, `${artifact.metricId}验数证据`);
  verifyPinnedFile(artifact.comparison, artifact.comparison.path, `${artifact.metricId}自动比较产物`);
}

const eventProjection = readJson("src/v2/design/generated/event-catalog-preview.json");
assert.equal(eventProjection.marker, "EVENT_CATALOG_DEV_AUTHORITY_PROJECTION", "事件目录投影标记无效");
assert.match(eventProjection.sourceSha256, /^[a-f0-9]{64}$/, "事件目录源文件哈希无效");
assert.match(eventProjection.observationSha256, /^[a-f0-9]{64}$/, "事件观察版哈希无效");
assertUniqueItems(eventProjection, "事件目录投影");

const functionProjection = readJson("src/v2/design/generated/function-catalog-preview.json");
assert.equal(functionProjection.marker, "FUNCTION_CATALOG_DEV_AUTHORITY_PROJECTION", "功能目录投影标记无效");
assert.equal(functionProjection.sourceSha256, eventProjection.sourceSha256, "事件与功能目录的权威源版本不一致");
assert.match(functionProjection.templateSourceSha256, /^[a-f0-9]{64}$/, "功能渗透率模板源文件哈希无效");
assertUniqueItems(functionProjection, "功能目录投影");

console.log(`仓库内固定投影已校验：${metricSnapshot.items.length} 个指标、${eventProjection.items.length} 个事件、${functionProjection.items.length} 个功能。`);
