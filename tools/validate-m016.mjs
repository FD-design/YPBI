import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  M016_AUTOMATED_VALIDATION_CHECKS,
  M016_REQUIRED_VALIDATION_CHECKS,
  canonicalJson,
  parseMetricMappingRegistry,
  readPlatformValidationScope,
  sha256,
  validateM016ComparisonArtifact
} from "./generate-metric-definitions.mjs";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolDir, "..");
const defaultRegistry = path.resolve(repoRoot, "server/v2/config/metric-mapping-registry.v1.json");
const defaultPlatformCatalog = path.resolve(repoRoot, "server/platforms/platform-catalog.v1.json");
const offsetDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const automatedCheckIds = new Set(M016_AUTOMATED_VALIDATION_CHECKS);
const maximumDatasetFileBytes = 67_108_864;

function fail(message) {
  throw new Error(message);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}必须是对象`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("|") !== wanted.join("|")) fail(`${label}字段不符合约定：${actual.join(" / ")}`);
}

function boundedString(value, label, maximumLength) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximumLength) {
    fail(`${label}必须是 1～${maximumLength} 个字符的非空字符串，且首尾不得有空格`);
  }
  return value;
}

function businessDate(value, label) {
  const normalized = boundedString(value, label, 10);
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalized)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== normalized
  ) {
    fail(`${label}必须是有效的 YYYY-MM-DD 业务日期`);
  }
  return normalized;
}

function offsetDateTime(value, label) {
  const normalized = boundedString(value, label, 64);
  if (
    !offsetDateTimePattern.test(normalized)
    || Number.isNaN(Date.parse(normalized))
    || businessDate(normalized.slice(0, 10), `${label} 的日期部分`) !== normalized.slice(0, 10)
  ) {
    fail(`${label}必须是带时区的 ISO 时间`);
  }
  return normalized;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label}必须是非负安全整数`);
  return value;
}

function parseJsonFile(filePath, label) {
  let serialized;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumDatasetFileBytes) {
      fail(`${label}必须是大小不超过 ${maximumDatasetFileBytes} 字节的普通非符号链接文件`);
    }
    serialized = fs.readFileSync(filePath, "utf8");
  } catch {
    fail(`${label}无法读取`);
  }
  try {
    return JSON.parse(serialized);
  } catch {
    fail(`${label}不是有效 JSON`);
  }
}

function parseDateRange(value, label) {
  if (!Array.isArray(value) || value.length !== 2) fail(`${label}必须是起止两个业务日期`);
  const result = [businessDate(value[0], `${label}[0]`), businessDate(value[1], `${label}[1]`)];
  if (result[0] > result[1]) fail(`${label}起始日期不得晚于结束日期`);
  const days = Math.round((Date.parse(`${result[1]}T00:00:00Z`) - Date.parse(`${result[0]}T00:00:00Z`)) / 86_400_000) + 1;
  if (days < 7 || days > 366) fail(`${label}必须覆盖连续 7～366 个业务日`);
  return result;
}

function enumerateBusinessDates(dateRange) {
  const dates = [];
  const cursor = new Date(`${dateRange[0]}T00:00:00Z`);
  const end = new Date(`${dateRange[1]}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function uniquePids(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) fail(`${label}必须是 1～1000 项的数组`);
  const pids = value.map((item, index) => boundedString(item, `${label}[${index}]`, 32));
  if (new Set(pids).size !== pids.length) fail(`${label}不得重复`);
  return pids;
}

export function parseM016ValidationDataset(value, expectedKind, label = "M016 验数数据集") {
  const dataset = record(value, label);
  exactKeys(dataset, [
    "schemaVersion", "kind", "metricId", "authorityVersion", "mappingVersion",
    "platformCatalogRevision", "platformCatalogContentSha256", "generatedAt", "artifactId", "dateRange", "rows"
  ], label);
  if (dataset.schemaVersion !== "m016-validation-dataset/v1") fail(`${label}.schemaVersion 不支持`);
  const allowedKinds = expectedKind === "candidate"
    ? new Set(["controlled_technical_query"])
    : new Set(["independent_sql", "approved_export"]);
  if (!allowedKinds.has(dataset.kind)) fail(`${label}.kind 与数据集用途不一致`);
  if (dataset.metricId !== "M016") fail(`${label}.metricId 必须是 M016`);
  const artifactId = boundedString(dataset.artifactId, `${label}.artifactId`, 128);
  if (!safeIdentifierPattern.test(artifactId)) fail(`${label}.artifactId 只能包含标识符安全字符`);
  const dateRange = parseDateRange(dataset.dateRange, `${label}.dateRange`);
  const maximumRows = enumerateBusinessDates(dateRange).length * 1_000 * 2;
  if (!Array.isArray(dataset.rows) || dataset.rows.length > maximumRows) {
    fail(`${label}.rows 超出 PID × 业务日允许的验数上限`);
  }
  const rows = dataset.rows.map((item, index) => {
    const row = record(item, `${label}.rows[${index}]`);
    exactKeys(row, ["pid", "businessDate", "value"], `${label}.rows[${index}]`);
    const value = row.value === null ? null : nonNegativeInteger(row.value, `${label}.rows[${index}].value`);
    return {
      pid: boundedString(row.pid, `${label}.rows[${index}].pid`, 32),
      businessDate: businessDate(row.businessDate, `${label}.rows[${index}].businessDate`),
      value
    };
  });
  return {
    schemaVersion: dataset.schemaVersion,
    kind: dataset.kind,
    metricId: dataset.metricId,
    authorityVersion: boundedString(dataset.authorityVersion, `${label}.authorityVersion`, 64),
    mappingVersion: boundedString(dataset.mappingVersion, `${label}.mappingVersion`, 128),
    platformCatalogRevision: nonNegativeInteger(dataset.platformCatalogRevision, `${label}.platformCatalogRevision`),
    platformCatalogContentSha256: (() => {
      const value = boundedString(dataset.platformCatalogContentSha256, `${label}.platformCatalogContentSha256`, 64);
      if (!sha256Pattern.test(value)) fail(`${label}.platformCatalogContentSha256 必须是小写 SHA-256`);
      return value;
    })(),
    generatedAt: offsetDateTime(dataset.generatedAt, `${label}.generatedAt`),
    artifactId,
    dateRange,
    rows
  };
}

function datasetIndex(dataset) {
  const index = new Map();
  let duplicateCount = 0;
  for (const row of dataset.rows) {
    const key = `${row.pid}\u0000${row.businessDate}`;
    if (index.has(key)) duplicateCount += 1;
    else index.set(key, row.value);
  }
  return { index, duplicateCount };
}

function check(id, checkedCount, failureCount) {
  return { id, status: failureCount === 0 ? "passed" : "failed", checkedCount, failureCount };
}

function assertDatasetContext(dataset, expected, label) {
  if (dataset.authorityVersion !== expected.authorityVersion) fail(`${label}.authorityVersion 与当前验数计划不一致`);
  if (dataset.mappingVersion !== expected.mappingVersion) fail(`${label}.mappingVersion 与当前验数计划不一致`);
  if (dataset.platformCatalogRevision !== expected.platformCatalogRevision) fail(`${label}.platformCatalogRevision 与当前验数计划不一致`);
  if (dataset.platformCatalogContentSha256 !== expected.platformCatalogContentSha256) fail(`${label}.platformCatalogContentSha256 与当前验数计划不一致`);
  if (dataset.dateRange.join("|") !== expected.dateRange.join("|")) fail(`${label}.dateRange 与当前验数计划不一致`);
  if (Date.parse(dataset.generatedAt) < Date.parse(`${expected.dateRange[1]}T16:00:00Z`)) {
    fail(`${label}.generatedAt 必须晚于覆盖期最后一个 Asia/Shanghai 完整业务日`);
  }
}

export function precheckM016Reference({ reference: referenceInput, expectedPids, dateRange, authorityVersion, mappingVersion, platformCatalogRevision, platformCatalogContentSha256 }) {
  const reference = parseM016ValidationDataset(referenceInput, "reference", "M016 reference");
  const scopePids = uniquePids(expectedPids, "M016 expectedPids");
  const expected = {
    authorityVersion: boundedString(authorityVersion, "M016 authorityVersion", 64),
    mappingVersion: boundedString(mappingVersion, "M016 mappingVersion", 128),
    platformCatalogRevision: nonNegativeInteger(platformCatalogRevision, "M016 platformCatalogRevision"),
    platformCatalogContentSha256: boundedString(platformCatalogContentSha256, "M016 platformCatalogContentSha256", 64),
    dateRange: parseDateRange(dateRange, "M016 dateRange")
  };
  assertDatasetContext(reference, expected, "M016 reference");
  const dates = enumerateBusinessDates(expected.dateRange);
  if (reference.rows.length > scopePids.length * dates.length * 2) {
    fail("M016 reference.rows 超出当前 PID × 业务日允许的验数上限");
  }
  const expectedPidSet = new Set(scopePids);
  const expectedDateSet = new Set(dates);
  const expectedKeys = scopePids.flatMap((pid) => dates.map((date) => `${pid}\u0000${date}`));
  const indexed = datasetIndex(reference);
  const presentPids = new Set(reference.rows.map((row) => row.pid));
  const checks = [
    check(
      "platform_scope",
      scopePids.length,
      scopePids.filter((pid) => !presentPids.has(pid)).length + [...presentPids].filter((pid) => !expectedPidSet.has(pid)).length
    ),
    check("business_date_completeness", expectedKeys.length, expectedKeys.filter((key) => !indexed.index.has(key)).length),
    check(
      "row_contract",
      reference.rows.length,
      indexed.duplicateCount
        + reference.rows.filter((row) => !expectedPidSet.has(row.pid)).length
        + reference.rows.filter((row) => !expectedDateSet.has(row.businessDate)).length
    ),
    check("null_zero_integrity", reference.rows.length, reference.rows.filter((row) => row.value === null).length),
    { id: "reference_value_match", status: "pending", checkedCount: 0, failureCount: 0 },
    ...M016_REQUIRED_VALIDATION_CHECKS
      .filter((id) => !automatedCheckIds.has(id))
      .map((id) => ({ id, status: "pending", checkedCount: 0, failureCount: 0 }))
  ];
  return {
    schemaVersion: "m016-validation-reference-precheck/v1",
    metricId: "M016",
    authorityVersion: expected.authorityVersion,
    mappingVersion: expected.mappingVersion,
    platformCatalogRevision: expected.platformCatalogRevision,
    platformCatalogContentSha256: expected.platformCatalogContentSha256,
    coverage: { pids: scopePids, dateRange: expected.dateRange },
    reference: {
      kind: reference.kind,
      artifactId: reference.artifactId,
      generatedAt: reference.generatedAt,
      contentSha256: sha256(canonicalJson(reference)),
      rowCount: reference.rows.length
    },
    result: checks.some((item) => item.status === "failed") ? "failed" : "ready_for_candidate",
    checks
  };
}

export function compareM016Datasets({ candidate: candidateInput, reference: referenceInput, expectedPids, dateRange, authorityVersion, mappingVersion, platformCatalogRevision, platformCatalogContentSha256 }) {
  const candidate = parseM016ValidationDataset(candidateInput, "candidate", "M016 candidate");
  const reference = parseM016ValidationDataset(referenceInput, "reference", "M016 reference");
  const scopePids = uniquePids(expectedPids, "M016 expectedPids");
  const expected = {
    authorityVersion: boundedString(authorityVersion, "M016 authorityVersion", 64),
    mappingVersion: boundedString(mappingVersion, "M016 mappingVersion", 128),
    platformCatalogRevision: nonNegativeInteger(platformCatalogRevision, "M016 platformCatalogRevision"),
    platformCatalogContentSha256: boundedString(platformCatalogContentSha256, "M016 platformCatalogContentSha256", 64),
    dateRange: parseDateRange(dateRange, "M016 dateRange")
  };
  assertDatasetContext(candidate, expected, "M016 candidate");
  assertDatasetContext(reference, expected, "M016 reference");
  if (candidate.artifactId === reference.artifactId) fail("candidate 与 reference 必须来自不同证据产物");

  const dates = enumerateBusinessDates(expected.dateRange);
  const scopedMaximumRows = scopePids.length * dates.length * 2;
  if (candidate.rows.length > scopedMaximumRows || reference.rows.length > scopedMaximumRows) {
    fail("M016 candidate/reference.rows 超出当前 PID × 业务日允许的验数上限");
  }
  const expectedPidSet = new Set(scopePids);
  const expectedDateSet = new Set(dates);
  const expectedKeys = scopePids.flatMap((pid) => dates.map((date) => `${pid}\u0000${date}`));
  const candidateIndexed = datasetIndex(candidate);
  const referenceIndexed = datasetIndex(reference);
  const candidatePids = new Set(candidate.rows.map((row) => row.pid));
  const referencePids = new Set(reference.rows.map((row) => row.pid));
  const platformFailures = scopePids.filter((pid) => !candidatePids.has(pid)).length
    + scopePids.filter((pid) => !referencePids.has(pid)).length
    + [...candidatePids].filter((pid) => !expectedPidSet.has(pid)).length
    + [...referencePids].filter((pid) => !expectedPidSet.has(pid)).length;
  const missingDateRows = expectedKeys.filter((key) => !candidateIndexed.index.has(key)).length
    + expectedKeys.filter((key) => !referenceIndexed.index.has(key)).length;
  const unexpectedDateRows = candidate.rows.filter((row) => !expectedDateSet.has(row.businessDate)).length
    + reference.rows.filter((row) => !expectedDateSet.has(row.businessDate)).length;
  const unexpectedPidRows = candidate.rows.filter((row) => !expectedPidSet.has(row.pid)).length
    + reference.rows.filter((row) => !expectedPidSet.has(row.pid)).length;
  const nullRows = candidate.rows.filter((row) => row.value === null).length
    + reference.rows.filter((row) => row.value === null).length;
  const valueMismatches = expectedKeys.filter((key) => (
    !candidateIndexed.index.has(key)
    || !referenceIndexed.index.has(key)
    || candidateIndexed.index.get(key) !== referenceIndexed.index.get(key)
  )).length;
  const checks = [
    check("platform_scope", scopePids.length * 2, platformFailures),
    check("business_date_completeness", expectedKeys.length * 2, missingDateRows),
    check("row_contract", candidate.rows.length + reference.rows.length, candidateIndexed.duplicateCount + referenceIndexed.duplicateCount + unexpectedDateRows + unexpectedPidRows),
    check("null_zero_integrity", candidate.rows.length + reference.rows.length, nullRows),
    check("reference_value_match", expectedKeys.length, valueMismatches),
    ...M016_REQUIRED_VALIDATION_CHECKS
      .filter((id) => !automatedCheckIds.has(id))
      .map((id) => ({ id, status: "pending", checkedCount: 0, failureCount: 0 }))
  ];
  const hasAutomatedFailure = checks.some((item) => automatedCheckIds.has(item.id) && item.status === "failed");
  const comparison = {
    schemaVersion: "m016-validation-comparison/v1",
    metricId: "M016",
    authorityVersion: expected.authorityVersion,
    mappingVersion: expected.mappingVersion,
    platformCatalogRevision: expected.platformCatalogRevision,
    platformCatalogContentSha256: expected.platformCatalogContentSha256,
    coverage: { pids: scopePids, dateRange: expected.dateRange },
    candidate: {
      kind: candidate.kind,
      artifactId: candidate.artifactId,
      generatedAt: candidate.generatedAt,
      contentSha256: sha256(canonicalJson(candidate)),
      rowCount: candidate.rows.length
    },
    reference: {
      kind: reference.kind,
      artifactId: reference.artifactId,
      generatedAt: reference.generatedAt,
      contentSha256: sha256(canonicalJson(reference)),
      rowCount: reference.rows.length
    },
    result: hasAutomatedFailure ? "failed" : "pending_review",
    checks
  };
  return validateM016ComparisonArtifact(comparison);
}

function assertRepositoryAuthorityFile(repositoryRoot, filePath, expectedRelativePath, label) {
  const root = path.resolve(repositoryRoot);
  const expectedPath = path.resolve(root, expectedRelativePath);
  if (path.resolve(filePath) !== expectedPath) fail(`${label}必须使用仓库内固定权威路径`);
  const rootStat = fs.lstatSync(root);
  const fileStat = fs.lstatSync(expectedPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()) {
    fail(`${label}必须是仓库内普通非符号链接文件`);
  }
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(expectedPath);
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) fail(`${label}真实路径越过仓库根目录`);
}

export function readM016ValidationContext(registryPath = defaultRegistry, platformCatalogPath = defaultPlatformCatalog, repositoryRoot = repoRoot) {
  assertRepositoryAuthorityFile(repositoryRoot, registryPath, "server/v2/config/metric-mapping-registry.v1.json", "指标映射注册表");
  assertRepositoryAuthorityFile(repositoryRoot, platformCatalogPath, "server/platforms/platform-catalog.v1.json", "平台目录");
  const registry = parseMetricMappingRegistry(fs.readFileSync(registryPath, "utf8"), registryPath);
  const entry = registry.entries.find((item) => item.metricId === "M016");
  if (!entry || entry.mapping.status !== "configured") fail("M016 当前没有可执行的已配置映射");
  const platformScope = readPlatformValidationScope(platformCatalogPath);
  return {
    entry,
    revision: platformScope.revision,
    contentSha256: platformScope.contentSha256,
    pids: uniquePids(platformScope.enabledPids, "平台目录启用 PID")
  };
}

export function buildM016ValidationPlan({
  registryPath = defaultRegistry,
  platformCatalogPath = defaultPlatformCatalog,
  repositoryRoot = repoRoot
} = {}) {
  const { entry, revision, contentSha256, pids } = readM016ValidationContext(registryPath, platformCatalogPath, repositoryRoot);
  return {
    schemaVersion: "m016-validation-plan/v1",
    metricId: "M016",
    authorityVersion: entry.authorityVersion,
    mappingVersion: entry.mappingVersion,
    platformCatalogRevision: revision,
    platformCatalogContentSha256: contentSha256,
    expectedPids: pids,
    networkAccess: false,
    registryMutation: false,
    candidateKind: "controlled_technical_query",
    acceptedReferenceKinds: ["independent_sql", "approved_export"],
    checks: M016_REQUIRED_VALIDATION_CHECKS.map((id) => ({
      id,
      mode: automatedCheckIds.has(id) ? "automated" : "review_required"
    }))
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") options.mode = "plan";
    else if (argument === "--check-reference" && argv[index + 1]) {
      options.mode = "reference";
      options.referencePath = path.resolve(argv[++index]);
    }
    else if (argument === "--candidate" && argv[index + 1]) options.candidatePath = path.resolve(argv[++index]);
    else if (argument === "--reference" && argv[index + 1]) options.referencePath = path.resolve(argv[++index]);
    else fail(`未知或不完整参数：${argument}`);
  }
  if (!options.mode && options.candidatePath && options.referencePath) options.mode = "compare";
  if (options.mode === "plan" && (options.candidatePath || options.referencePath)) fail("--plan 不能与数据集参数同时使用");
  if (options.mode === "reference" && options.candidatePath) fail("参考数据预检不能同时提供 candidate");
  if (options.mode === "compare" && (!options.candidatePath || !options.referencePath)) fail("比较模式必须同时提供 --candidate 与 --reference");
  if (!options.mode) fail("请使用 --plan，或同时提供 --candidate 与 --reference");
  return options;
}

function runCli(options) {
  if (options.mode === "plan") return buildM016ValidationPlan();
  const context = readM016ValidationContext();
  const reference = parseJsonFile(options.referencePath, "reference 数据集");
  if (options.mode === "reference") {
    const referenceDateRange = parseM016ValidationDataset(reference, "reference", "M016 reference").dateRange;
    return precheckM016Reference({
      reference,
      expectedPids: context.pids,
      dateRange: referenceDateRange,
      authorityVersion: context.entry.authorityVersion,
      mappingVersion: context.entry.mappingVersion,
      platformCatalogRevision: context.revision,
      platformCatalogContentSha256: context.contentSha256
    });
  }
  const candidate = parseJsonFile(options.candidatePath, "candidate 数据集");
  const candidateDateRange = parseM016ValidationDataset(candidate, "candidate", "M016 candidate").dateRange;
  return compareM016Datasets({
    candidate,
    reference,
    expectedPids: context.pids,
    dateRange: candidateDateRange,
    authorityVersion: context.entry.authorityVersion,
    mappingVersion: context.entry.mappingVersion,
    platformCatalogRevision: context.revision,
    platformCatalogContentSha256: context.contentSha256
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = runCli(options);
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    process.stdout.write(serialized);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
