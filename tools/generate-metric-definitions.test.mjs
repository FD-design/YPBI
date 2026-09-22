import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  M016_REQUIRED_VALIDATION_CHECKS,
  buildMetricDefinitionsSnapshot,
  buildMetricDefinitionsUiProjection,
  canonicalJson,
  generateMetricDefinitions,
  parseMetricMappingRegistry,
  readPlatformValidationScope,
  sha256,
  validateMetricValidationEvidenceFiles,
  verifyContentHash
} from "./generate-metric-definitions.mjs";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(toolDir, "../../全站埋点与指标体系/全站指标体系.md");
const registryPath = path.resolve(toolDir, "../server/v2/config/metric-mapping-registry.v1.json");
const markdown = fs.readFileSync(sourcePath, "utf8");
const registry = parseMetricMappingRegistry(fs.readFileSync(registryPath, "utf8"), registryPath);
// A dated, isolated document fixture exercises v0.23 evidence without approving the live mapping.
const mappingAlignedMarkdown = markdown.replace(/指标体系版本：`[^`]+`/, "指标体系版本：`v0.23-draft`");

function cloneRegistry() {
  return structuredClone(registry);
}

function comparisonChecks(status = "passed") {
  const counts = new Map([
    ["platform_scope", 4],
    ["business_date_completeness", 28],
    ["row_contract", 28],
    ["null_zero_integrity", 28],
    ["reference_value_match", 14]
  ]);
  return M016_REQUIRED_VALIDATION_CHECKS.map((id, index) => {
    if (index >= 5) return { id, status: "pending", checkedCount: 0, failureCount: 0 };
    const failed = status === "failed" && index === 0;
    return { id, status: failed ? "failed" : "passed", checkedCount: counts.get(id), failureCount: failed ? 1 : 0 };
  });
}

function comparisonArtifact(platformCatalogContentSha256, status = "passed", overrides = {}) {
  const base = {
    schemaVersion: "m016-validation-comparison/v1",
    metricId: "M016",
    authorityVersion: "v0.23-draft",
    mappingVersion: "m016-pday-sum-v1",
    platformCatalogRevision: 7,
    platformCatalogContentSha256,
    coverage: { pids: ["PH", "TT"], dateRange: ["2026-09-01", "2026-09-07"] },
    candidate: {
      kind: "controlled_technical_query",
      artifactId: "m016-controlled-query-20260908",
      generatedAt: "2026-09-08T15:10:00+08:00",
      contentSha256: "a".repeat(64),
      rowCount: 14
    },
    reference: {
      kind: "independent_sql",
      artifactId: "m016-independent-query-20260908",
      generatedAt: "2026-09-08T15:20:00+08:00",
      contentSha256: "c".repeat(64),
      rowCount: 14
    },
    result: status === "failed" ? "failed" : "pending_review",
    checks: comparisonChecks(status)
  };
  return {
    ...base,
    ...overrides,
    coverage: { ...base.coverage, ...overrides.coverage },
    candidate: { ...base.candidate, ...overrides.candidate },
    reference: { ...base.reference, ...overrides.reference },
    checks: overrides.checks ?? base.checks
  };
}

function evidenceManifest(evidenceId, comparisonId, comparison, comparisonContentSha256, status = "passed", overrides = {}) {
  const checks = comparison.checks.map((check, index) => {
    if (index < 5) return { ...check };
    if (status === "passed") return { ...check, status: "passed", checkedCount: 1 };
    if (status === "expired") return { ...check, status: index === 8 ? "expired" : "passed", checkedCount: 1 };
    return { ...check };
  });
  const base = {
    schemaVersion: "metric-validation-evidence/v1",
    evidenceId,
    metricId: "M016",
    authorityVersion: "v0.23-draft",
    mappingVersion: "m016-pday-sum-v1",
    platformCatalogRevision: 7,
    platformCatalogContentSha256: comparison.platformCatalogContentSha256,
    validatedAt: "2026-09-08T15:30:00+08:00",
    result: status,
    coverage: { pids: ["PH", "TT"], dateRange: ["2026-09-01", "2026-09-07"] },
    comparison: {
      artifactPath: comparisonId,
      contentSha256: comparisonContentSha256,
      candidate: comparison.candidate,
      reference: comparison.reference
    },
    checks
  };
  return {
    ...base,
    ...overrides,
    coverage: { ...base.coverage, ...overrides.coverage },
    comparison: { ...base.comparison, ...overrides.comparison },
    checks: overrides.checks ?? base.checks
  };
}

function createEvidenceFixture(context, { status = "passed", manifestOverrides = {} } = {}) {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ypbi-validation-evidence-"));
  context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  const platformCatalog = path.join(repositoryRoot, "server/platforms/platform-catalog.v1.json");
  fs.mkdirSync(path.dirname(platformCatalog), { recursive: true });
  fs.writeFileSync(platformCatalog, `${JSON.stringify({
    schemaVersion: "platform-catalog/v1",
    revision: 7,
    updatedAt: "2026-09-08T15:00:00+08:00",
    items: [
      { pid: "PH", enabled: true, siteId: "primary", order: 1 },
      { pid: "TT", enabled: true, siteId: "secondary", order: 2 }
    ]
  }, null, 2)}\n`);
  const platformScope = readPlatformValidationScope(platformCatalog);
  const evidenceId = "server/v2/validation/evidence/M016/m016-20260908.evidence.json";
  const comparisonId = "server/v2/validation/evidence/M016/m016-20260908.comparison.json";
  const comparison = comparisonArtifact(platformScope.contentSha256, status, manifestOverrides.comparisonArtifact ?? {});
  const comparisonSerialized = `${JSON.stringify(comparison, null, 2)}\n`;
  const comparisonPath = path.join(repositoryRoot, comparisonId);
  fs.mkdirSync(path.dirname(comparisonPath), { recursive: true });
  fs.writeFileSync(comparisonPath, comparisonSerialized);
  const evidencePath = path.join(repositoryRoot, evidenceId);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const { comparisonArtifact: _ignored, ...evidenceOverrides } = manifestOverrides;
  const evidenceSerialized = `${JSON.stringify(
    evidenceManifest(evidenceId, comparisonId, comparison, sha256(comparisonSerialized), status, evidenceOverrides),
    null,
    2
  )}\n`;
  fs.writeFileSync(evidencePath, evidenceSerialized);
  return {
    repositoryRoot,
    platformCatalog,
    evidenceId,
    evidenceSha256: sha256(evidenceSerialized),
    evidencePath,
    comparisonId,
    comparisonPath
  };
}

function registryWithEvidence(fixture, status = "passed") {
  const resultRegistry = cloneRegistry();
  const manifest = JSON.parse(fs.readFileSync(fixture.evidencePath, "utf8"));
  resultRegistry.registryVersion = "2026-09-08.2";
  resultRegistry.entries[0].validation = {
    status,
    mappingVersion: "m016-pday-sum-v1",
    authorityVersion: "v0.23-draft",
    validatedAt: manifest.validatedAt,
    evidenceId: fixture.evidenceId,
    evidenceSha256: fixture.evidenceSha256
  };
  return resultRegistry;
}

test("从权威 Markdown 生成完整且稳定的指标目录", () => {
  const first = buildMetricDefinitionsSnapshot(markdown);
  const second = buildMetricDefinitionsSnapshot(markdown);

  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first.snapshot.counts, { standard: 97, periodDerived: 3, total: 100 });
  assert.equal(first.snapshot.authorityVersion, "v0.36-draft");
  assert.equal(first.snapshot.mappingRegistryVersion, "2026-09-08.1");
  assert.equal(first.categories.length, 5);
  assert.equal(first.categories.reduce((count, category) => count + category.children.length, 0), 20);
  assert.equal(verifyContentHash(first), true);
  assert.equal("generatedAt" in first.snapshot, false);
});

test("界面口径投影从权威指标目录派生业务说明与百分率公式", () => {
  const snapshot = buildMetricDefinitionsSnapshot(markdown);
  const projection = buildMetricDefinitionsUiProjection(snapshot);
  const effectiveViewRate = projection.items.find((item) => item.id === "M036");

  assert.equal(projection.schemaVersion, "metric-definitions-ui/v1");
  assert.equal(projection.authorityVersion, snapshot.snapshot.authorityVersion);
  assert.equal(projection.sourceContentSha256, snapshot.snapshot.contentSha256);
  assert.equal(projection.items.length, snapshot.items.length);
  assert.deepEqual(effectiveViewRate, {
    id: "M036",
    name: "有效观影率",
    definition: "成功起播的播放中，长视频实际观看达到15秒、3至15秒视频实际观看达到3秒，或不足3秒视频完整播放的比例\n公式：有效观看次数 ÷ 起播次数 × 100%"
  });
  snapshot.items[0].authority.registeredFormula = "unregistered_event.result_status=true";
  assert.throws(() => buildMetricDefinitionsUiProjection(snapshot), /业务释义尚未覆盖/);
});

test("新权威版本不会自动批准旧 M016 映射，默认未验数且不可分析", () => {
  const snapshot = buildMetricDefinitionsSnapshot(markdown, registry);
  const metric = snapshot.items.find((item) => item.id === "M016");

  assert.ok(metric);
  assert.equal(metric.name, "日活跃用户数");
  assert.equal(metric.classification.primary, "用户生命周期");
  assert.equal(metric.classification.secondary, "活跃规模");
  assert.equal(metric.authority.sourceBuildStatus.code, "tech_claimed_pending_validation");
  assert.equal(metric.authority.unit, null);
  assert.equal(metric.ypbiMapping.status, "stale");
  assert.equal(metric.ypbiMapping.mappingVersion, "m016-pday-sum-v1");
  assert.deepEqual(metric.ypbiMapping.sourceApiIds, ["/api/admin/statistics/pDaySum"]);
  assert.equal(metric.validation.status, "not_started");
  assert.deepEqual(metric.analysis, { status: "unavailable", reasonCodes: ["mapping_stale"] });
});

test("M016 只有映射版本匹配且具有完整证据的 passed 验数才可开放", (context) => {
  const fixture = createEvidenceFixture(context);
  const passedRegistry = cloneRegistry();
  passedRegistry.registryVersion = "2026-09-08.2";
  passedRegistry.entries[0].validation = {
    status: "passed",
    mappingVersion: "m016-pday-sum-v1",
    authorityVersion: "v0.23-draft",
    validatedAt: "2026-09-08T15:30:00+08:00",
    evidenceId: fixture.evidenceId,
    evidenceSha256: fixture.evidenceSha256
  };

  const snapshot = buildMetricDefinitionsSnapshot(mappingAlignedMarkdown, passedRegistry, fixture);
  const metric = snapshot.items.find((item) => item.id === "M016");

  assert.ok(metric);
  assert.deepEqual(metric.validation, {
    status: "passed",
    mappingVersion: "m016-pday-sum-v1",
    authorityVersion: "v0.23-draft",
    validatedAt: "2026-09-08T15:30:00+08:00",
    evidenceId: fixture.evidenceId
  });
  assert.equal("evidenceSha256" in metric.validation, false);
  assert.deepEqual(metric.analysis, { status: "available", reasonCodes: [] });
});

test("注册表拒绝未知字段、错绑映射版本和无证据的 passed 验数", () => {
  const unknownFieldRegistry = cloneRegistry();
  unknownFieldRegistry.entries[0].temporaryFlag = true;
  assert.throws(
    () => buildMetricDefinitionsSnapshot(markdown, unknownFieldRegistry),
    /entries\[0\]字段不符合约定/
  );

  const mismatchedRegistry = cloneRegistry();
  mismatchedRegistry.entries[0].validation = {
    status: "running",
    mappingVersion: "m016-pday-sum-v0",
    authorityVersion: "v0.23-draft",
    validatedAt: null,
    evidenceId: null,
    evidenceSha256: null
  };
  assert.throws(
    () => buildMetricDefinitionsSnapshot(markdown, mismatchedRegistry),
    /validation\.mappingVersion 必须等于当前 mappingVersion m016-pday-sum-v1/
  );

  const evidenceMissingRegistry = cloneRegistry();
  evidenceMissingRegistry.entries[0].validation = {
    status: "passed",
    mappingVersion: "m016-pday-sum-v1",
    authorityVersion: "v0.23-draft",
    validatedAt: null,
    evidenceId: null,
    evidenceSha256: null
  };
  assert.throws(
    () => buildMetricDefinitionsSnapshot(markdown, evidenceMissingRegistry),
    /passed 必须具有带时区的 validatedAt、evidenceId 和 evidenceSha256/
  );
});

test("metrics:check 可检测映射验数注册表变更造成的快照过期", (context) => {
  const fixture = createEvidenceFixture(context);
  const temporaryRegistryPath = path.join(fixture.repositoryRoot, "server/v2/config/metric-mapping-registry.v1.json");
  const temporaryOutputPath = path.join(fixture.repositoryRoot, "server/v2/generated/metric-definitions.json");
  fs.mkdirSync(path.dirname(temporaryRegistryPath), { recursive: true });
  fs.writeFileSync(temporaryRegistryPath, `${JSON.stringify(registry, null, 2)}\n`);

  generateMetricDefinitions({
    source: sourcePath,
    registry: temporaryRegistryPath,
    output: temporaryOutputPath,
    repositoryRoot: fixture.repositoryRoot,
    platformCatalog: fixture.platformCatalog
  });
  generateMetricDefinitions({
    source: sourcePath,
    registry: temporaryRegistryPath,
    output: temporaryOutputPath,
    repositoryRoot: fixture.repositoryRoot,
    platformCatalog: fixture.platformCatalog,
    check: true
  });

  const changedRegistry = cloneRegistry();
  changedRegistry.registryVersion = "2026-09-08.2";
  changedRegistry.entries[0].validation = {
    status: "passed",
    mappingVersion: "m016-pday-sum-v1",
    authorityVersion: "v0.23-draft",
    validatedAt: "2026-09-08T15:30:00+08:00",
    evidenceId: fixture.evidenceId,
    evidenceSha256: fixture.evidenceSha256
  };
  fs.writeFileSync(temporaryRegistryPath, `${JSON.stringify(changedRegistry, null, 2)}\n`);

  assert.throws(
    () => generateMetricDefinitions({
      source: sourcePath,
      registry: temporaryRegistryPath,
      output: temporaryOutputPath,
      repositoryRoot: fixture.repositoryRoot,
      platformCatalog: fixture.platformCatalog,
      check: true
    }),
    /指标目录快照与权威 Markdown 或映射验数注册表不一致/
  );
});

test("结果态验数拒绝缺失、伪造或未绑定当前平台目录的证据", async (context) => {
  const missingFixture = createEvidenceFixture(context);
  const missingRegistry = cloneRegistry();
  missingRegistry.entries[0].validation = {
    status: "passed",
    mappingVersion: "m016-pday-sum-v1",
    authorityVersion: "v0.23-draft",
    validatedAt: "2026-09-08T15:30:00+08:00",
    evidenceId: "server/v2/validation/evidence/M016/missing.evidence.json",
    evidenceSha256: "d".repeat(64)
  };
  assert.throws(
    () => validateMetricValidationEvidenceFiles(missingRegistry, missingFixture),
    /验数证据 .*不存在/
  );

  for (const [name, override, expected] of [
    ["metricId", { metricId: "M017" }, /metricId 与注册表不一致/],
    ["authorityVersion", { authorityVersion: "v0.22-draft" }, /authorityVersion 与注册表不一致/],
    ["mappingVersion", { mappingVersion: "m016-pday-sum-v0" }, /mappingVersion 与注册表不一致/],
    ["platformCatalogRevision", { platformCatalogRevision: 6 }, /未绑定当前平台目录 revision 7/],
    ["result", { result: "failed" }, /标记 failed 时至少一项必选检查必须失败/],
    ["pending_review", {
      result: "pending_review",
      checks: comparisonChecks("passed")
    }, /result 与注册表状态不一致/],
    ["dateRange", { coverage: { dateRange: ["2026-09-01", "2026-09-06"] } }, /至少覆盖连续 7 个业务日/]
  ]) {
    await context.test(name, () => {
      const fixture = createEvidenceFixture(context, { manifestOverrides: override });
      const passedRegistry = cloneRegistry();
      passedRegistry.entries[0].validation = {
        status: "passed",
        mappingVersion: "m016-pday-sum-v1",
        authorityVersion: "v0.23-draft",
        validatedAt: "2026-09-08T15:30:00+08:00",
        evidenceId: fixture.evidenceId,
        evidenceSha256: fixture.evidenceSha256
      };
      assert.throws(() => validateMetricValidationEvidenceFiles(passedRegistry, fixture), expected);
    });
  }
});

test("failed 与 expired 也必须携带结构完整且结果匹配的证据", (context) => {
  for (const status of ["failed", "expired"]) {
    const fixture = createEvidenceFixture(context, { status });
    const resultRegistry = cloneRegistry();
    resultRegistry.entries[0].validation = {
      status,
      mappingVersion: "m016-pday-sum-v1",
      authorityVersion: "v0.23-draft",
      validatedAt: "2026-09-08T15:30:00+08:00",
      evidenceId: fixture.evidenceId,
      evidenceSha256: fixture.evidenceSha256
    };
    assert.doesNotThrow(() => validateMetricValidationEvidenceFiles(resultRegistry, fixture));
  }
});

test("最终验数结果不能绕过 comparison、内容哈希、计数与时间边界", async (context) => {
  await context.test("comparison 文件被改写", () => {
    const fixture = createEvidenceFixture(context);
    fs.appendFileSync(fixture.comparisonPath, "\n");
    assert.throws(
      () => validateMetricValidationEvidenceFiles(registryWithEvidence(fixture), fixture),
      /自动比较产物 .*内容哈希与证据清单不一致/
    );
  });

  await context.test("evidence 自动检查与 comparison 不一致", () => {
    const fixture = createEvidenceFixture(context);
    const manifest = JSON.parse(fs.readFileSync(fixture.evidencePath, "utf8"));
    manifest.checks[0].checkedCount = 2;
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(fixture.evidencePath, serialized);
    fixture.evidenceSha256 = sha256(serialized);
    assert.throws(
      () => validateMetricValidationEvidenceFiles(registryWithEvidence(fixture), fixture),
      /自动检查 platform_scope 与 comparison 产物不一致/
    );
  });

  await context.test("passed 检查 checkedCount 为零", () => {
    const fixture = createEvidenceFixture(context);
    const manifest = JSON.parse(fs.readFileSync(fixture.evidencePath, "utf8"));
    manifest.checks[5].checkedCount = 0;
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(fixture.evidencePath, serialized);
    fixture.evidenceSha256 = sha256(serialized);
    assert.throws(
      () => validateMetricValidationEvidenceFiles(registryWithEvidence(fixture), fixture),
      /checkedCount 必须大于 0/
    );
  });

  await context.test("registry evidenceSha256 未 pin 当前证据", () => {
    const fixture = createEvidenceFixture(context);
    const resultRegistry = registryWithEvidence(fixture);
    resultRegistry.entries[0].validation.evidenceSha256 = "f".repeat(64);
    assert.throws(
      () => validateMetricValidationEvidenceFiles(resultRegistry, fixture),
      /内容哈希与注册表 evidenceSha256 不一致/
    );
  });

  await context.test("平台目录内容变化但 revision 未更新", () => {
    const fixture = createEvidenceFixture(context);
    const catalog = JSON.parse(fs.readFileSync(fixture.platformCatalog, "utf8"));
    catalog.items[0].order = 99;
    fs.writeFileSync(fixture.platformCatalog, `${JSON.stringify(catalog, null, 2)}\n`);
    assert.throws(
      () => validateMetricValidationEvidenceFiles(registryWithEvidence(fixture), fixture),
      /未绑定当前平台目录内容哈希/
    );
  });

  for (const [name, generatedAt] of [
    ["生成时间早于覆盖期完整结束", "2026-09-07T23:59:59+08:00"],
    ["生成时间晚于 validatedAt", "2026-09-08T15:31:00+08:00"]
  ]) {
    await context.test(name, () => {
      const fixture = createEvidenceFixture(context, {
        manifestOverrides: { comparisonArtifact: { candidate: { generatedAt } } }
      });
      assert.throws(
        () => validateMetricValidationEvidenceFiles(registryWithEvidence(fixture), fixture),
        /generatedAt 必须在覆盖期完整结束后且不晚于 validatedAt/
      );
    });
  }
});

test("验数证据根目录本身为符号链接时拒绝", (context) => {
  const fixture = createEvidenceFixture(context);
  const evidenceRoot = path.join(fixture.repositoryRoot, "server/v2/validation/evidence");
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ypbi-external-evidence-"));
  context.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  fs.cpSync(evidenceRoot, externalRoot, { recursive: true });
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
  fs.symlinkSync(externalRoot, evidenceRoot, "dir");
  assert.throws(
    () => validateMetricValidationEvidenceFiles(registryWithEvidence(fixture), fixture),
    /验数证据根目录必须是仓库内真实目录/
  );
});

test("validatedAt 拒绝未来伪造但允许五分钟时钟偏差", (context) => {
  const accepted = createEvidenceFixture(context);
  assert.doesNotThrow(() => validateMetricValidationEvidenceFiles(
    registryWithEvidence(accepted),
    { ...accepted, now: new Date("2026-09-08T15:25:00+08:00") }
  ));

  const future = createEvidenceFixture(context, { manifestOverrides: { validatedAt: "2099-01-01T00:00:00+08:00" } });
  assert.throws(
    () => validateMetricValidationEvidenceFiles(
      registryWithEvidence(future),
      { ...future, now: new Date("2026-09-08T15:25:00+08:00") }
    ),
    /validatedAt 不得晚于当前时间 5 分钟以上/
  );
});

test("验数仓库根目录为符号链接时拒绝", (context) => {
  const fixture = createEvidenceFixture(context);
  const linkedRoot = `${fixture.repositoryRoot}-link`;
  context.after(() => fs.rmSync(linkedRoot, { recursive: true, force: true }));
  fs.symlinkSync(fixture.repositoryRoot, linkedRoot, "dir");
  assert.throws(
    () => validateMetricValidationEvidenceFiles(registryWithEvidence(fixture), {
      repositoryRoot: linkedRoot,
      platformCatalog: path.join(linkedRoot, "server/platforms/platform-catalog.v1.json")
    }),
    /验数仓库根目录不存在或不是目录/
  );
});

test("生成快照与准入证明不得写入符号链接父目录", (context) => {
  const fixture = createEvidenceFixture(context);
  const registryTarget = path.join(fixture.repositoryRoot, "server/v2/config/metric-mapping-registry.v1.json");
  fs.mkdirSync(path.dirname(registryTarget), { recursive: true });
  fs.writeFileSync(registryTarget, `${JSON.stringify(registry, null, 2)}\n`);
  const generatedParent = path.join(fixture.repositoryRoot, "server/v2/generated");
  const externalParent = fs.mkdtempSync(path.join(os.tmpdir(), "ypbi-external-generated-"));
  context.after(() => fs.rmSync(externalParent, { recursive: true, force: true }));
  fs.symlinkSync(externalParent, generatedParent, "dir");
  assert.throws(
    () => generateMetricDefinitions({
      source: sourcePath,
      output: path.join(generatedParent, "metric-definitions.json"),
      registry: registryTarget,
      repositoryRoot: fixture.repositoryRoot,
      platformCatalog: fixture.platformCatalog
    }),
    /父目录不得包含符号链接/
  );
});

test("check 模式在输出目录缺失时只报错而不创建目录", (context) => {
  const fixture = createEvidenceFixture(context);
  const registryTarget = path.join(fixture.repositoryRoot, "server/v2/config/metric-mapping-registry.v1.json");
  fs.mkdirSync(path.dirname(registryTarget), { recursive: true });
  fs.writeFileSync(registryTarget, `${JSON.stringify(registry, null, 2)}\n`);
  const missingParent = path.join(fixture.repositoryRoot, "server/not-created/generated");
  assert.throws(
    () => generateMetricDefinitions({
      source: sourcePath,
      output: path.join(missingParent, "metric-definitions.json"),
      registry: registryTarget,
      repositoryRoot: fixture.repositoryRoot,
      platformCatalog: fixture.platformCatalog,
      check: true
    }),
    /父目录不存在/
  );
  assert.equal(fs.existsSync(missingParent), false);
});

test("需平台加工指标与周期派生指标保留真实不可用原因", () => {
  const snapshot = buildMetricDefinitionsSnapshot(markdown);
  const missingCapability = snapshot.items.find((item) => item.id === "M106");
  const derived = snapshot.items.find((item) => item.id === "DM001");

  assert.ok(missingCapability);
  assert.equal(missingCapability.authority.sourceBuildStatus.code, "platform_processing_required");
  assert.equal(missingCapability.ypbiMapping.status, "not_configured");
  assert.deepEqual(missingCapability.analysis.reasonCodes, ["mapping_not_configured"]);

  assert.ok(derived);
  assert.equal(derived.classification, null);
  assert.equal(derived.authority.unit, "人·天");
  assert.deepEqual(derived.authority.baseMetricIds, ["M016"]);
  assert.equal(derived.authority.sourceBuildStatus.code, "tech_claimed_pending_validation");
  assert.deepEqual(derived.analysis.reasonCodes, ["mapping_not_configured"]);
});

test("拒绝同一指标重复归入分类", () => {
  const invalidMarkdown = markdown.replace(
    "| 用户生命周期 | 获客转化 | M005、M099、M006、M007 |",
    "| 用户生命周期 | 获客转化 | M001、M005、M099、M006、M007 |"
  );
  assert.throws(() => buildMetricDefinitionsSnapshot(invalidMarkdown), /指标重复归入二级分类：M001/);
});

test("权威版本变化不会自动批准旧 M016 映射", () => {
  const nextVersionMarkdown = mappingAlignedMarkdown.replace("指标体系版本：`v0.23-draft`", "指标体系版本：`v0.24-draft`");
  const snapshot = buildMetricDefinitionsSnapshot(nextVersionMarkdown);
  const metric = snapshot.items.find((item) => item.id === "M016");

  assert.ok(metric);
  assert.equal(metric.ypbiMapping.status, "stale");
  assert.equal(metric.ypbiMapping.authorityVersion, "v0.23-draft");
  assert.deepEqual(metric.analysis, { status: "unavailable", reasonCodes: ["mapping_stale"] });
});

test("更新映射权威版本时不能复用旧权威版本的验数证据", () => {
  const staleEvidenceRegistry = cloneRegistry();
  staleEvidenceRegistry.registryVersion = "2026-09-08.2";
  staleEvidenceRegistry.entries[0].authorityVersion = "v0.24-draft";
  staleEvidenceRegistry.entries[0].validation = {
    status: "passed",
    mappingVersion: "m016-pday-sum-v1",
    authorityVersion: "v0.23-draft",
    validatedAt: "2026-09-08T15:30:00+08:00",
    evidenceId: "server/v2/validation/evidence/M016/stale.evidence.json",
    evidenceSha256: "e".repeat(64)
  };

  assert.throws(
    () => buildMetricDefinitionsSnapshot(markdown, staleEvidenceRegistry),
    /validation\.authorityVersion 必须等于当前 authorityVersion v0\.24-draft/
  );
});

test("已配置映射必须与当前代码查询 Adapter 的来源和能力完全一致", () => {
  const mismatchedSourceRegistry = cloneRegistry();
  mismatchedSourceRegistry.entries[0].mapping.sourceApiIds = ["/api/admin/statistics/not-the-m016-adapter"];
  assert.throws(
    () => buildMetricDefinitionsSnapshot(markdown, mismatchedSourceRegistry),
    /查询 Adapter 契约完全一致/
  );

  const mismatchedCapabilityRegistry = cloneRegistry();
  mismatchedCapabilityRegistry.entries[0].mapping.capabilities.grains = ["month"];
  assert.throws(
    () => buildMetricDefinitionsSnapshot(markdown, mismatchedCapabilityRegistry),
    /查询 Adapter 契约完全一致/
  );
});
