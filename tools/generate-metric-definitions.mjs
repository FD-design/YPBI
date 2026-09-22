import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUSINESS_EXPLANATION_PENDING, metricBusinessExplanation } from "../src/v2/features/metrics/metric-presentation.ts";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolDir, "..");
const defaultSource = path.resolve(repoRoot, "../全站埋点与指标体系/全站指标体系.md");
const defaultOutput = path.resolve(repoRoot, "server/v2/generated/metric-definitions.json");
const defaultUiProjection = path.resolve(repoRoot, "src/v2/generated/metric-definitions-ui.json");
const defaultRegistry = path.resolve(repoRoot, "server/v2/config/metric-mapping-registry.v1.json");
const defaultPlatformCatalog = path.resolve(repoRoot, "server/platforms/platform-catalog.v1.json");
const defaultAttestation = path.resolve(repoRoot, "server/v2/generated/metric-release-attestation.json");
const metricValidationEvidencePrefix = "server/v2/validation/evidence/";
const validationArtifactMaximumBytes = 1_048_576;

const standardHeaders = [
  "指标ID", "业务域", "指标类型", "指标层级", "指标中文名", "指标英文名", "状态",
  "开发现有定义", "开发现有公式", "当前登记公式", "去重口径", "窗口与粒度", "数据来源", "排除条件", "已知问题", "建议定义"
];

const derivedHeaders = [
  "派生指标ID", "派生指标中文名", "指标英文名", "查询别名", "基础指标", "定义", "公式",
  "单位", "去重口径", "窗口与粒度", "口径边界", "状态"
];

const sourceStatusCodes = new Map([
  ["技术称已实现（待验数）", "tech_claimed_pending_validation"],
  ["现有接口口径待验数", "definition_pending_confirmation"],
  ["埋点草稿支持", "tracking_draft"],
  ["需平台加工", "platform_processing_required"],
  ["待补能力", "capability_missing"]
]);

const registrySchemaVersion = "metric-mapping-registry/v1";
const registryMappingStatuses = new Set(["configured", "disabled"]);
const registryValidationStatuses = new Set(["not_started", "running", "passed", "failed", "expired"]);
const registryPlatformModes = new Set(["single_pid", "multi_pid", "official_overall"]);
const resultValidationStatuses = new Set(["passed", "failed", "expired"]);
const offsetDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const evidenceResults = new Set(["pending_review", "passed", "failed", "expired"]);
const evidenceCheckStatuses = new Set(["pending", "passed", "failed", "expired"]);
export const M016_REQUIRED_VALIDATION_CHECKS = Object.freeze([
  "platform_scope",
  "business_date_completeness",
  "row_contract",
  "null_zero_integrity",
  "reference_value_match",
  "business_definition",
  "timezone_boundary",
  "exclusion_rules",
  "freshness_backfill"
]);
export const M016_AUTOMATED_VALIDATION_CHECKS = Object.freeze(
  M016_REQUIRED_VALIDATION_CHECKS.slice(0, 5)
);
const implementedMetricMappingContracts = new Map([
  ["M016", {
    mappingVersion: "m016-pday-sum-v1",
    sourceApiIds: ["/api/admin/statistics/pDaySum"],
    capabilities: {
      grains: ["day"],
      platformModes: ["single_pid"],
      dimensions: [],
      filters: [],
      comparisons: []
    }
  }]
]);

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (actualKeys.join("|") !== sortedExpectedKeys.join("|")) {
    throw new Error(`${label}字段不符合约定：${actualKeys.join(" / ")}`);
  }
}

function assertBoundedString(value, label, maximumLength) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximumLength) {
    throw new Error(`${label}必须是 1～${maximumLength} 个字符的非空字符串，且首尾不得有空格`);
  }
  return value;
}

function assertNullableBoundedString(value, label, maximumLength) {
  if (value === null) return null;
  return assertBoundedString(value, label, maximumLength);
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负安全整数`);
  return value;
}

function assertOffsetDateTime(value, label) {
  const normalized = assertBoundedString(value, label, 64);
  if (
    !offsetDateTimePattern.test(normalized)
    || Number.isNaN(Date.parse(normalized))
    || assertBusinessDate(normalized.slice(0, 10), `${label} 的日期部分`) !== normalized.slice(0, 10)
  ) {
    throw new Error(`${label}必须是带时区的 ISO 时间`);
  }
  return normalized;
}

function assertBusinessDate(value, label) {
  const normalized = assertBoundedString(value, label, 10);
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalized)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new Error(`${label}必须是有效的 YYYY-MM-DD 业务日期`);
  }
  return normalized;
}

function assertUniqueStringArray(value, label, maximumItems, maximumItemLength, allowedValues = null) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label}必须是最多 ${maximumItems} 项的数组`);
  }
  const result = value.map((item, index) => {
    const normalized = assertBoundedString(item, `${label}[${index}]`, maximumItemLength);
    if (allowedValues && !allowedValues.has(normalized)) throw new Error(`${label}包含未知值：${normalized}`);
    return normalized;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label}不得包含重复值`);
  return result;
}

function validateCapabilities(value, label) {
  const capabilities = assertRecord(value, label);
  assertExactKeys(capabilities, ["grains", "platformModes", "dimensions", "filters", "comparisons"], label);
  return {
    grains: assertUniqueStringArray(capabilities.grains, `${label}.grains`, 32, 32),
    platformModes: assertUniqueStringArray(capabilities.platformModes, `${label}.platformModes`, 3, 32, registryPlatformModes),
    dimensions: assertUniqueStringArray(capabilities.dimensions, `${label}.dimensions`, 128, 128),
    filters: assertUniqueStringArray(capabilities.filters, `${label}.filters`, 128, 128),
    comparisons: assertUniqueStringArray(capabilities.comparisons, `${label}.comparisons`, 32, 128)
  };
}

function validateRegistryEntry(value, index) {
  const label = `指标映射注册表 entries[${index}]`;
  const entry = assertRecord(value, label);
  assertExactKeys(entry, ["metricId", "authorityVersion", "mappingVersion", "mapping", "validation"], label);

  const metricId = assertBoundedString(entry.metricId, `${label}.metricId`, 16);
  if (!/^(?:M|DM)\d{3}$/.test(metricId)) throw new Error(`${label}.metricId 格式错误：${metricId}`);
  const authorityVersion = assertBoundedString(entry.authorityVersion, `${label}.authorityVersion`, 64);
  const mappingVersion = assertBoundedString(entry.mappingVersion, `${label}.mappingVersion`, 128);

  const mapping = assertRecord(entry.mapping, `${label}.mapping`);
  assertExactKeys(mapping, ["status", "sourceApiIds", "capabilities"], `${label}.mapping`);
  if (!registryMappingStatuses.has(mapping.status)) throw new Error(`${label}.mapping.status 未知：${String(mapping.status)}`);
  const sourceApiIds = assertUniqueStringArray(mapping.sourceApiIds, `${label}.mapping.sourceApiIds`, 64, 256);
  const capabilities = validateCapabilities(mapping.capabilities, `${label}.mapping.capabilities`);
  if (mapping.status === "configured" && sourceApiIds.length === 0) {
    throw new Error(`${label}.mapping.sourceApiIds：已配置映射必须声明至少一个来源 API`);
  }
  const implementedContract = implementedMetricMappingContracts.get(metricId);
  if (mapping.status === "configured") {
    const matchesImplementedContract = implementedContract
      && implementedContract.mappingVersion === mappingVersion
      && JSON.stringify(implementedContract.sourceApiIds) === JSON.stringify(sourceApiIds)
      && JSON.stringify(implementedContract.capabilities) === JSON.stringify(capabilities);
    if (!matchesImplementedContract) {
      throw new Error(`${label}.mapping：已配置映射必须与当前代码中的查询 Adapter 契约完全一致`);
    }
  }

  const validation = assertRecord(entry.validation, `${label}.validation`);
  assertExactKeys(
    validation,
    ["status", "mappingVersion", "authorityVersion", "validatedAt", "evidenceId", "evidenceSha256"],
    `${label}.validation`
  );
  if (!registryValidationStatuses.has(validation.status)) {
    throw new Error(`${label}.validation.status 未知：${String(validation.status)}`);
  }
  const validationMappingVersion = assertNullableBoundedString(
    validation.mappingVersion,
    `${label}.validation.mappingVersion`,
    128
  );
  const validationAuthorityVersion = assertNullableBoundedString(
    validation.authorityVersion,
    `${label}.validation.authorityVersion`,
    64
  );
  const validatedAt = assertNullableBoundedString(validation.validatedAt, `${label}.validation.validatedAt`, 64);
  const evidenceId = assertNullableBoundedString(validation.evidenceId, `${label}.validation.evidenceId`, 256);
  const evidenceSha256 = assertNullableBoundedString(validation.evidenceSha256, `${label}.validation.evidenceSha256`, 64);
  if (evidenceSha256 !== null && !sha256Pattern.test(evidenceSha256)) {
    throw new Error(`${label}.validation.evidenceSha256 必须是小写 SHA-256`);
  }

  if (validation.status === "not_started") {
    if (
      validationMappingVersion !== null
      || validationAuthorityVersion !== null
      || validatedAt !== null
      || evidenceId !== null
      || evidenceSha256 !== null
    ) {
      throw new Error(`${label}.validation：未开始验数不得携带映射版本、权威版本、时间或证据`);
    }
  } else {
    if (validationMappingVersion !== mappingVersion) {
      throw new Error(`${label}.validation.mappingVersion 必须等于当前 mappingVersion ${mappingVersion}`);
    }
    if (validationAuthorityVersion !== authorityVersion) {
      throw new Error(`${label}.validation.authorityVersion 必须等于当前 authorityVersion ${authorityVersion}`);
    }
    if (resultValidationStatuses.has(validation.status)) {
      if (!validatedAt || !offsetDateTimePattern.test(validatedAt) || Number.isNaN(Date.parse(validatedAt)) || !evidenceId || !evidenceSha256) {
        throw new Error(`${label}.validation：${validation.status} 必须具有带时区的 validatedAt、evidenceId 和 evidenceSha256`);
      }
    } else if (validatedAt !== null || evidenceId !== null || evidenceSha256 !== null) {
      throw new Error(`${label}.validation：进行中的验数不得提前携带结果时间或证据`);
    }
  }

  return {
    metricId,
    authorityVersion,
    mappingVersion,
    mapping: {
      status: mapping.status,
      sourceApiIds,
      capabilities
    },
    validation: {
      status: validation.status,
      mappingVersion: validationMappingVersion,
      authorityVersion: validationAuthorityVersion,
      validatedAt,
      evidenceId,
      evidenceSha256
    }
  };
}

export function validateMetricMappingRegistry(value) {
  const registry = assertRecord(value, "指标映射注册表");
  assertExactKeys(registry, ["schemaVersion", "registryVersion", "entries"], "指标映射注册表");
  if (registry.schemaVersion !== registrySchemaVersion) {
    throw new Error(`指标映射注册表 schemaVersion 不支持：${String(registry.schemaVersion)}`);
  }
  const registryVersion = assertBoundedString(registry.registryVersion, "指标映射注册表 registryVersion", 64);
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(registryVersion)) {
    throw new Error(`指标映射注册表 registryVersion 格式错误：${registryVersion}`);
  }
  if (!Array.isArray(registry.entries) || registry.entries.length > 1_000) {
    throw new Error("指标映射注册表 entries 必须是最多 1000 项的数组");
  }
  const entries = registry.entries.map(validateRegistryEntry);
  const metricIds = entries.map((entry) => entry.metricId);
  const mappingVersions = entries.map((entry) => entry.mappingVersion);
  if (new Set(metricIds).size !== metricIds.length) throw new Error("指标映射注册表不得重复登记 metricId");
  if (new Set(mappingVersions).size !== mappingVersions.length) throw new Error("指标映射注册表不得将同一 mappingVersion 绑定多个指标或权威版本");
  return { schemaVersion: registrySchemaVersion, registryVersion, entries };
}

export function parseMetricMappingRegistry(serialized, label = "指标映射注册表") {
  let value;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return validateMetricMappingRegistry(value);
}

export function readPlatformValidationScope(platformCatalogPath) {
  let catalog;
  try {
    catalog = JSON.parse(readBoundedUtf8File(platformCatalogPath, "验数平台目录"));
  } catch (error) {
    throw new Error(`验数所需的平台目录无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  const record = assertRecord(catalog, "验数平台目录");
  if (record.schemaVersion !== "platform-catalog/v1") throw new Error("验数平台目录 schemaVersion 不支持");
  const revision = assertNonNegativeInteger(record.revision, "验数平台目录 revision");
  if (revision === 0) throw new Error("验数平台目录 revision 必须大于 0");
  if (!Array.isArray(record.items) || record.items.length === 0 || record.items.length > 1_000) {
    throw new Error("验数平台目录 items 必须是 1～1000 项的数组");
  }
  const platformItems = record.items.map((item, index) => {
    const platform = assertRecord(item, `验数平台目录 items[${index}]`);
    if (typeof platform.enabled !== "boolean") throw new Error(`验数平台目录 items[${index}].enabled 必须是布尔值`);
    if (!new Set(["primary", "secondary"]).has(platform.siteId)) {
      throw new Error(`验数平台目录 items[${index}].siteId 必须是 primary 或 secondary`);
    }
    return {
      pid: assertBoundedString(platform.pid, `验数平台目录 items[${index}].pid`, 32),
      enabled: platform.enabled,
      siteId: platform.siteId,
      order: assertNonNegativeInteger(platform.order, `验数平台目录 items[${index}].order`)
    };
  });
  const enabledPids = platformItems.filter((item) => item.enabled).map((item) => item.pid);
  if (enabledPids.length === 0) throw new Error("验数平台目录必须至少包含一个启用 PID");
  if (new Set(enabledPids).size !== enabledPids.length) throw new Error("验数平台目录启用 PID 不得重复");
  return {
    revision,
    enabledPids,
    contentSha256: sha256(canonicalJson({
      schemaVersion: record.schemaVersion,
      revision,
      items: platformItems
    }))
  };
}

function readBoundedUtf8File(filePath, label, maximumBytes = validationArtifactMaximumBytes) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new Error(`${label}必须是大小不超过 ${maximumBytes} 字节的普通非符号链接文件`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function shanghaiBusinessDate(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function firstInstantAfterShanghaiBusinessDate(businessDate) {
  return Date.parse(`${businessDate}T16:00:00Z`);
}

function parseJson(serialized, label) {
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSha256(value, label) {
  const normalized = assertBoundedString(value, label, 64);
  if (!sha256Pattern.test(normalized)) throw new Error(`${label}必须是小写 SHA-256`);
  return normalized;
}

function parseValidationCoverage(value, label, minimumDays = 1) {
  const coverage = assertRecord(value, label);
  assertExactKeys(coverage, ["pids", "dateRange"], label);
  const pids = assertUniqueStringArray(coverage.pids, `${label}.pids`, 1_000, 32);
  if (!Array.isArray(coverage.dateRange) || coverage.dateRange.length !== 2) {
    throw new Error(`${label}.dateRange 必须是起止两个业务日期`);
  }
  const dateRange = [
    assertBusinessDate(coverage.dateRange[0], `${label}.dateRange[0]`),
    assertBusinessDate(coverage.dateRange[1], `${label}.dateRange[1]`)
  ];
  if (dateRange[0] > dateRange[1]) throw new Error(`${label}.dateRange 起始日期不得晚于结束日期`);
  const coveredDays = Math.round(
    (Date.parse(`${dateRange[1]}T00:00:00Z`) - Date.parse(`${dateRange[0]}T00:00:00Z`)) / 86_400_000
  ) + 1;
  if (coveredDays < minimumDays) throw new Error(`${label}.dateRange 必须至少覆盖连续 ${minimumDays} 个业务日`);
  if (coveredDays > 366) throw new Error(`${label}.dateRange 不得超过连续 366 个业务日`);
  return { pids, dateRange };
}

function validationDayCount(dateRange) {
  return Math.round(
    (Date.parse(`${dateRange[1]}T00:00:00Z`) - Date.parse(`${dateRange[0]}T00:00:00Z`)) / 86_400_000
  ) + 1;
}

function parseValidationChecks(value, label) {
  if (!Array.isArray(value) || value.length !== M016_REQUIRED_VALIDATION_CHECKS.length) {
    throw new Error(`${label}必须完整包含 M016 的 ${M016_REQUIRED_VALIDATION_CHECKS.length} 项必选检查`);
  }
  const checks = value.map((item, index) => {
    const check = assertRecord(item, `${label}[${index}]`);
    assertExactKeys(check, ["id", "status", "checkedCount", "failureCount"], `${label}[${index}]`);
    const id = assertBoundedString(check.id, `${label}[${index}].id`, 64);
    if (!M016_REQUIRED_VALIDATION_CHECKS.includes(id)) throw new Error(`${label}包含未知检查：${id}`);
    if (!evidenceCheckStatuses.has(check.status)) throw new Error(`${label}[${index}].status 未知：${String(check.status)}`);
    const checkedCount = assertNonNegativeInteger(check.checkedCount, `${label}[${index}].checkedCount`);
    const failureCount = assertNonNegativeInteger(check.failureCount, `${label}[${index}].failureCount`);
    if (failureCount > checkedCount) throw new Error(`${label}[${index}].failureCount 不得大于 checkedCount`);
    if (check.status === "passed" && (failureCount !== 0 || checkedCount === 0)) {
      throw new Error(`${label}[${index}] 已通过时 checkedCount 必须大于 0 且 failureCount 必须为 0`);
    }
    if (check.status === "failed" && failureCount === 0) throw new Error(`${label}[${index}] 失败时 failureCount 必须大于 0`);
    if ((check.status === "pending" || check.status === "expired") && failureCount !== 0) {
      throw new Error(`${label}[${index}] 待复核或过期时 failureCount 必须为 0`);
    }
    return { id, status: check.status, checkedCount, failureCount };
  });
  if (new Set(checks.map((check) => check.id)).size !== checks.length) throw new Error(`${label}不得重复`);
  if (checks.map((check) => check.id).join("|") !== M016_REQUIRED_VALIDATION_CHECKS.join("|")) {
    throw new Error(`${label}必须按固定顺序完整登记`);
  }
  return checks;
}

function parseArtifactSummary(value, label, allowedKinds) {
  const summary = assertRecord(value, label);
  assertExactKeys(summary, ["kind", "artifactId", "generatedAt", "contentSha256", "rowCount"], label);
  if (!allowedKinds.has(summary.kind)) throw new Error(`${label}.kind 不符合证据来源约定`);
  const artifactId = assertBoundedString(summary.artifactId, `${label}.artifactId`, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(artifactId)) {
    throw new Error(`${label}.artifactId 只能包含标识符安全字符`);
  }
  return {
    kind: summary.kind,
    artifactId,
    generatedAt: assertOffsetDateTime(summary.generatedAt, `${label}.generatedAt`),
    contentSha256: assertSha256(summary.contentSha256, `${label}.contentSha256`),
    rowCount: assertNonNegativeInteger(summary.rowCount, `${label}.rowCount`)
  };
}

export function validateM016ComparisonArtifact(value, label = "M016 comparison") {
  const comparison = assertRecord(value, label);
  assertExactKeys(comparison, [
    "schemaVersion", "metricId", "authorityVersion", "mappingVersion", "platformCatalogRevision",
    "platformCatalogContentSha256", "coverage", "candidate", "reference", "result", "checks"
  ], label);
  if (comparison.schemaVersion !== "m016-validation-comparison/v1") throw new Error(`${label}.schemaVersion 不支持`);
  if (comparison.metricId !== "M016") throw new Error(`${label}.metricId 必须是 M016`);
  if (!new Set(["pending_review", "failed"]).has(comparison.result)) throw new Error(`${label}.result 不支持`);
  const coverage = parseValidationCoverage(comparison.coverage, `${label}.coverage`, 7);
  const candidate = parseArtifactSummary(comparison.candidate, `${label}.candidate`, new Set(["controlled_technical_query"]));
  const reference = parseArtifactSummary(comparison.reference, `${label}.reference`, new Set(["independent_sql", "approved_export"]));
  const checks = parseValidationChecks(comparison.checks, `${label}.checks`);
  const automatedChecks = checks.filter((check) => M016_AUTOMATED_VALIDATION_CHECKS.includes(check.id));
  const reviewChecks = checks.filter((check) => !M016_AUTOMATED_VALIDATION_CHECKS.includes(check.id));
  if (automatedChecks.some((check) => !new Set(["passed", "failed"]).has(check.status))) {
    throw new Error(`${label} 的自动检查不得伪装成待复核或过期`);
  }
  if (reviewChecks.some((check) => check.status !== "pending" || check.checkedCount !== 0 || check.failureCount !== 0)) {
    throw new Error(`${label} 不得代替人工业务检查给出结论`);
  }
  const hasAutomatedFailure = automatedChecks.some((check) => check.status === "failed");
  if ((comparison.result === "failed") !== hasAutomatedFailure) {
    throw new Error(`${label}.result 必须由自动检查结果确定`);
  }
  const expectedRows = coverage.pids.length * validationDayCount(coverage.dateRange);
  if (candidate.rowCount > expectedRows * 2 || reference.rowCount > expectedRows * 2) {
    throw new Error(`${label} 的 rowCount 超出 PID × 业务日允许的验数上限`);
  }
  const expectedCheckedCounts = new Map([
    ["platform_scope", coverage.pids.length * 2],
    ["business_date_completeness", expectedRows * 2],
    ["row_contract", candidate.rowCount + reference.rowCount],
    ["null_zero_integrity", candidate.rowCount + reference.rowCount],
    ["reference_value_match", expectedRows]
  ]);
  for (const check of automatedChecks) {
    if (check.checkedCount !== expectedCheckedCounts.get(check.id)) {
      throw new Error(`${label}.${check.id}.checkedCount 与 coverage/rowCount 不一致`);
    }
  }
  if (comparison.result === "pending_review" && (candidate.rowCount !== expectedRows || reference.rowCount !== expectedRows)) {
    throw new Error(`${label} 自动检查全部通过时双方 rowCount 必须等于 PID × 业务日数量`);
  }
  return {
    schemaVersion: comparison.schemaVersion,
    metricId: comparison.metricId,
    authorityVersion: assertBoundedString(comparison.authorityVersion, `${label}.authorityVersion`, 64),
    mappingVersion: assertBoundedString(comparison.mappingVersion, `${label}.mappingVersion`, 128),
    platformCatalogRevision: assertNonNegativeInteger(comparison.platformCatalogRevision, `${label}.platformCatalogRevision`),
    platformCatalogContentSha256: assertSha256(comparison.platformCatalogContentSha256, `${label}.platformCatalogContentSha256`),
    coverage,
    candidate,
    reference,
    result: comparison.result,
    checks
  };
}

function parseEvidenceManifest(serialized, label) {
  const manifest = assertRecord(parseJson(serialized, label), label);
  assertExactKeys(manifest, [
    "schemaVersion", "evidenceId", "metricId", "authorityVersion", "mappingVersion",
    "platformCatalogRevision", "platformCatalogContentSha256", "validatedAt", "result",
    "coverage", "comparison", "checks"
  ], label);
  if (manifest.schemaVersion !== "metric-validation-evidence/v1") {
    throw new Error(`${label}.schemaVersion 不支持：${String(manifest.schemaVersion)}`);
  }
  if (!evidenceResults.has(manifest.result)) throw new Error(`${label}.result 未知：${String(manifest.result)}`);
  const comparison = assertRecord(manifest.comparison, `${label}.comparison`);
  assertExactKeys(
    comparison,
    ["artifactPath", "contentSha256", "candidate", "reference"],
    `${label}.comparison`
  );
  const checks = parseValidationChecks(manifest.checks, `${label}.checks`);
  if (manifest.result === "passed" && checks.some((check) => check.status !== "passed")) {
    throw new Error(`${label} 标记 passed 时所有必选检查必须通过`);
  }
  if (manifest.result === "failed" && !checks.some((check) => check.status === "failed")) {
    throw new Error(`${label} 标记 failed 时至少一项必选检查必须失败`);
  }
  if (manifest.result === "expired" && (
    !checks.some((check) => check.status === "expired")
    || checks.some((check) => check.status === "failed" || check.status === "pending")
  )) {
    throw new Error(`${label} 标记 expired 时至少一项检查须过期，且不得保留失败或待复核检查`);
  }
  if (manifest.result === "pending_review" && checks.every((check) => check.status === "passed")) {
    throw new Error(`${label} 所有检查均已通过时不得继续标记 pending_review`);
  }
  return {
    schemaVersion: manifest.schemaVersion,
    evidenceId: assertBoundedString(manifest.evidenceId, `${label}.evidenceId`, 256),
    metricId: assertBoundedString(manifest.metricId, `${label}.metricId`, 16),
    authorityVersion: assertBoundedString(manifest.authorityVersion, `${label}.authorityVersion`, 64),
    mappingVersion: assertBoundedString(manifest.mappingVersion, `${label}.mappingVersion`, 128),
    platformCatalogRevision: assertNonNegativeInteger(manifest.platformCatalogRevision, `${label}.platformCatalogRevision`),
    platformCatalogContentSha256: assertSha256(manifest.platformCatalogContentSha256, `${label}.platformCatalogContentSha256`),
    validatedAt: assertOffsetDateTime(manifest.validatedAt, `${label}.validatedAt`),
    result: manifest.result,
    coverage: parseValidationCoverage(manifest.coverage, `${label}.coverage`, 7),
    comparison: {
      artifactPath: assertBoundedString(comparison.artifactPath, `${label}.comparison.artifactPath`, 256),
      contentSha256: assertSha256(comparison.contentSha256, `${label}.comparison.contentSha256`),
      candidate: parseArtifactSummary(comparison.candidate, `${label}.comparison.candidate`, new Set(["controlled_technical_query"])),
      reference: parseArtifactSummary(comparison.reference, `${label}.comparison.reference`, new Set(["independent_sql", "approved_export"]))
    },
    checks
  };
}

function resolveValidationArtifactPath(repositoryRoot, artifactPath, label) {
  if (
    path.isAbsolute(artifactPath)
    || artifactPath.includes("\\")
    || path.posix.normalize(artifactPath) !== artifactPath
    || !artifactPath.startsWith(metricValidationEvidencePrefix)
    || !artifactPath.endsWith(".json")
  ) {
    throw new Error(`${label}必须是 ${metricValidationEvidencePrefix} 下的仓库相对 JSON 路径`);
  }
  const absoluteRepositoryRoot = path.resolve(repositoryRoot);
  const repositoryRootStat = fs.lstatSync(absoluteRepositoryRoot);
  if (!repositoryRootStat.isDirectory() || repositoryRootStat.isSymbolicLink()) {
    throw new Error("验数仓库根目录不存在或不是目录");
  }
  const realRepositoryRoot = fs.realpathSync(absoluteRepositoryRoot);
  const evidenceRoot = path.resolve(absoluteRepositoryRoot, metricValidationEvidencePrefix);
  if (!fs.existsSync(evidenceRoot)) throw new Error(`验数证据目录不存在：${metricValidationEvidencePrefix}`);
  const evidenceRootStat = fs.lstatSync(evidenceRoot);
  if (!evidenceRootStat.isDirectory() || evidenceRootStat.isSymbolicLink()) {
    throw new Error("验数证据根目录必须是仓库内真实目录，不能是符号链接");
  }
  const realEvidenceRoot = fs.realpathSync(evidenceRoot);
  if (!realEvidenceRoot.startsWith(`${realRepositoryRoot}${path.sep}`)) {
    throw new Error("验数证据根目录真实路径越过了仓库根目录");
  }
  const absoluteArtifactPath = path.resolve(absoluteRepositoryRoot, artifactPath);
  if (!absoluteArtifactPath.startsWith(`${evidenceRoot}${path.sep}`)) throw new Error(`${label}路径越过了证据目录`);
  if (!fs.existsSync(absoluteArtifactPath)) throw new Error(`${label}不存在：${artifactPath}`);
  const stat = fs.lstatSync(absoluteArtifactPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}必须是仓库内普通文件：${artifactPath}`);
  const realArtifactPath = fs.realpathSync(absoluteArtifactPath);
  if (!realArtifactPath.startsWith(`${realEvidenceRoot}${path.sep}`)) throw new Error(`${label}真实路径越过了证据目录`);
  return absoluteArtifactPath;
}

function inspectMetricValidationEvidenceFiles(registryInput, {
  repositoryRoot = repoRoot,
  platformCatalog = path.resolve(repositoryRoot, "server/platforms/platform-catalog.v1.json"),
  now = new Date()
} = {}) {
  const registry = validateMetricMappingRegistry(registryInput);
  const resultEntries = registry.entries.filter((entry) => resultValidationStatuses.has(entry.validation.status));
  const artifacts = [];
  if (resultEntries.length === 0) return { registry, artifacts };
  const platformScope = readPlatformValidationScope(platformCatalog);
  const expectedPids = [...platformScope.enabledPids].sort();
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (Number.isNaN(nowMs)) throw new Error("验数校验基准时间无效");

  for (const entry of resultEntries) {
    const evidenceId = entry.validation.evidenceId;
    const evidencePath = resolveValidationArtifactPath(repositoryRoot, evidenceId, `验数证据 ${evidenceId}`);
    if (!evidenceId.endsWith(".evidence.json")) throw new Error(`验数证据 ${evidenceId} 必须使用 .evidence.json 后缀`);
    const evidenceSerialized = readBoundedUtf8File(evidencePath, `验数证据 ${evidenceId}`);
    const evidenceContentSha256 = sha256(evidenceSerialized);
    if (evidenceContentSha256 !== entry.validation.evidenceSha256) {
      throw new Error(`验数证据 ${evidenceId} 的内容哈希与注册表 evidenceSha256 不一致`);
    }
    const manifest = parseEvidenceManifest(evidenceSerialized, `验数证据 ${evidenceId}`);
    const manifestPids = [...manifest.coverage.pids].sort();
    if (manifest.evidenceId !== evidenceId) throw new Error(`验数证据 ${evidenceId} 的 evidenceId 与注册表不一致`);
    if (manifest.metricId !== entry.metricId) throw new Error(`验数证据 ${evidenceId} 的 metricId 与注册表不一致`);
    if (manifest.authorityVersion !== entry.authorityVersion) throw new Error(`验数证据 ${evidenceId} 的 authorityVersion 与注册表不一致`);
    if (manifest.mappingVersion !== entry.mappingVersion) throw new Error(`验数证据 ${evidenceId} 的 mappingVersion 与注册表不一致`);
    if (manifest.validatedAt !== entry.validation.validatedAt) throw new Error(`验数证据 ${evidenceId} 的 validatedAt 与注册表不一致`);
    if (manifest.result !== entry.validation.status) throw new Error(`验数证据 ${evidenceId} 的 result 与注册表状态不一致`);
    if (manifest.platformCatalogRevision !== platformScope.revision) {
      throw new Error(`验数证据 ${evidenceId} 未绑定当前平台目录 revision ${platformScope.revision}`);
    }
    if (manifest.platformCatalogContentSha256 !== platformScope.contentSha256) {
      throw new Error(`验数证据 ${evidenceId} 未绑定当前平台目录内容哈希`);
    }
    if (manifestPids.join("|") !== expectedPids.join("|")) {
      throw new Error(`验数证据 ${evidenceId} 未完整覆盖当前全部启用 PID`);
    }

    const comparisonId = manifest.comparison.artifactPath;
    if (!comparisonId.endsWith(".comparison.json")) {
      throw new Error(`验数证据 ${evidenceId} 必须引用 .comparison.json 自动比较产物`);
    }
    if (comparisonId === evidenceId) throw new Error(`验数证据 ${evidenceId} 不得将自身伪装成自动比较产物`);
    const comparisonPath = resolveValidationArtifactPath(repositoryRoot, comparisonId, `自动比较产物 ${comparisonId}`);
    const comparisonSerialized = readBoundedUtf8File(comparisonPath, `自动比较产物 ${comparisonId}`);
    const comparisonContentSha256 = sha256(comparisonSerialized);
    if (comparisonContentSha256 !== manifest.comparison.contentSha256) {
      throw new Error(`自动比较产物 ${comparisonId} 的内容哈希与证据清单不一致`);
    }
    const comparison = validateM016ComparisonArtifact(
      parseJson(comparisonSerialized, `自动比较产物 ${comparisonId}`),
      `自动比较产物 ${comparisonId}`
    );
    if (
      comparison.metricId !== manifest.metricId
      || comparison.authorityVersion !== manifest.authorityVersion
      || comparison.mappingVersion !== manifest.mappingVersion
      || comparison.platformCatalogRevision !== manifest.platformCatalogRevision
      || comparison.platformCatalogContentSha256 !== manifest.platformCatalogContentSha256
      || canonicalJson(comparison.coverage) !== canonicalJson(manifest.coverage)
    ) {
      throw new Error(`自动比较产物 ${comparisonId} 的验数上下文与证据清单不一致`);
    }
    if (
      canonicalJson(comparison.candidate) !== canonicalJson(manifest.comparison.candidate)
      || canonicalJson(comparison.reference) !== canonicalJson(manifest.comparison.reference)
    ) {
      throw new Error(`自动比较产物 ${comparisonId} 的数据集摘要与证据清单不一致`);
    }
    const comparisonChecks = new Map(comparison.checks.map((check) => [check.id, check]));
    for (const check of manifest.checks.filter((item) => M016_AUTOMATED_VALIDATION_CHECKS.includes(item.id))) {
      if (canonicalJson(check) !== canonicalJson(comparisonChecks.get(check.id))) {
        throw new Error(`验数证据 ${evidenceId} 的自动检查 ${check.id} 与 comparison 产物不一致`);
      }
    }
    if (manifest.result === "passed" && comparison.result !== "pending_review") {
      throw new Error(`验数证据 ${evidenceId} 不能基于自动比较失败的产物判定 passed`);
    }
    if (manifest.result === "failed" && comparison.result !== "failed") {
      const failedManualCheck = manifest.checks.some((check) => (
        !M016_AUTOMATED_VALIDATION_CHECKS.includes(check.id) && check.status === "failed"
      ));
      if (!failedManualCheck) throw new Error(`验数证据 ${evidenceId} 的 failed 结果缺少失败依据`);
    }

    const validatedAtMs = Date.parse(manifest.validatedAt);
    if (validatedAtMs > nowMs + 300_000) {
      throw new Error(`验数证据 ${evidenceId} 的 validatedAt 不得晚于当前时间 5 分钟以上`);
    }
    const validationBusinessDate = shanghaiBusinessDate(manifest.validatedAt);
    const coverageEnd = manifest.coverage.dateRange[1];
    if (coverageEnd >= validationBusinessDate) {
      throw new Error(`验数证据 ${evidenceId} 只能覆盖 validatedAt 之前的完整业务日`);
    }
    const completeCoverageAtMs = firstInstantAfterShanghaiBusinessDate(coverageEnd);
    for (const [label, summary] of [["candidate", comparison.candidate], ["reference", comparison.reference]]) {
      const generatedAtMs = Date.parse(summary.generatedAt);
      if (generatedAtMs < completeCoverageAtMs || generatedAtMs > validatedAtMs) {
        throw new Error(`验数证据 ${evidenceId} 的 ${label}.generatedAt 必须在覆盖期完整结束后且不晚于 validatedAt`);
      }
    }
    artifacts.push({
      metricId: entry.metricId,
      status: entry.validation.status,
      evidencePath: evidenceId,
      evidenceSha256: evidenceContentSha256,
      comparisonPath: comparisonId,
      comparisonSha256: comparisonContentSha256
    });
  }
  return { registry, artifacts };
}

export function validateMetricValidationEvidenceFiles(registryInput, options = {}) {
  return inspectMetricValidationEvidenceFiles(registryInput, options).registry;
}

function readMetricMappingRegistry(registryPath) {
  return parseMetricMappingRegistry(fs.readFileSync(registryPath, "utf8"), registryPath);
}

function ensureSafeRepositoryDirectory(repositoryRoot, directoryPath, label, { create = false } = {}) {
  const absoluteRoot = path.resolve(repositoryRoot);
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("指标生成仓库根目录必须是真实目录");
  const relativeDirectory = path.relative(absoluteRoot, path.resolve(directoryPath));
  if (relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
    throw new Error(`${label}必须位于仓库根目录内`);
  }
  const realRoot = fs.realpathSync(absoluteRoot);
  let current = absoluteRoot;
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      if (!create) throw new Error(`${label}父目录不存在`);
      fs.mkdirSync(current);
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}父目录不得包含符号链接`);
    const realCurrent = fs.realpathSync(current);
    if (!realCurrent.startsWith(`${realRoot}${path.sep}`)) throw new Error(`${label}父目录真实路径越过仓库根目录`);
  }
}

function writeFileAtomic(filePath, serialized) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o644, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath);
    throw error;
  }
}

function repositoryRelativePath(repositoryRoot, filePath, label, { mustExist = true } = {}) {
  const absoluteRoot = path.resolve(repositoryRoot);
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("指标生成仓库根目录必须是真实目录");
  const realRoot = fs.realpathSync(absoluteRoot);
  const absoluteFilePath = path.resolve(filePath);
  const relativePath = path.relative(absoluteRoot, absoluteFilePath);
  if (relativePath === "" || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`${label}必须位于仓库根目录内`);
  }
  if (mustExist) {
    const stat = fs.lstatSync(absoluteFilePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}必须是仓库内普通非符号链接文件`);
    const realFilePath = fs.realpathSync(absoluteFilePath);
    if (!realFilePath.startsWith(`${realRoot}${path.sep}`)) throw new Error(`${label}真实路径越过了仓库根目录`);
  } else {
    const parentStat = fs.lstatSync(path.dirname(absoluteFilePath));
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error(`${label}父目录不得是符号链接`);
    const realParent = fs.realpathSync(path.dirname(absoluteFilePath));
    if (!realParent.startsWith(`${realRoot}${path.sep}`)) throw new Error(`${label}父目录真实路径越过仓库根目录`);
    if (fs.existsSync(absoluteFilePath) && fs.lstatSync(absoluteFilePath).isSymbolicLink()) {
      throw new Error(`${label}不得是符号链接`);
    }
  }
  return relativePath.split(path.sep).join("/");
}

function releaseAttestationJson({
  repositoryRoot,
  snapshotPath,
  snapshotSerialized,
  registryPath,
  registrySerialized,
  platformCatalogPath,
  platformCatalogSerialized,
  validationArtifacts
}) {
  const attestation = {
    schemaVersion: "metric-release-admission/v1",
    snapshot: {
      path: repositoryRelativePath(repositoryRoot, snapshotPath, "指标目录快照", { mustExist: false }),
      contentSha256: sha256(snapshotSerialized)
    },
    registry: {
      path: repositoryRelativePath(repositoryRoot, registryPath, "指标映射注册表"),
      contentSha256: sha256(registrySerialized)
    },
    platformCatalog: {
      path: repositoryRelativePath(repositoryRoot, platformCatalogPath, "平台目录"),
      contentSha256: sha256(platformCatalogSerialized)
    },
    validationArtifacts: validationArtifacts
      .map((artifact) => ({
        metricId: artifact.metricId,
        status: artifact.status,
        evidence: { path: artifact.evidencePath, contentSha256: artifact.evidenceSha256 },
        comparison: { path: artifact.comparisonPath, contentSha256: artifact.comparisonSha256 }
      }))
      .sort((left, right) => left.metricId.localeCompare(right.metricId))
  };
  return `${JSON.stringify(attestation, null, 2)}\n`;
}

function stripInlineCode(value) {
  return value.replace(/`([^`]+)`/g, "$1").trim();
}

function parseTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(stripInlineCode);
}

function tableRows(section, expectedHeaders, label) {
  const lines = section.split("\n").filter((line) => line.trim().startsWith("|"));
  if (lines.length < 3) throw new Error(`${label}为空`);
  const headers = parseTableRow(lines[0]);
  if (headers.join("|") !== expectedHeaders.join("|")) {
    throw new Error(`${label}字段不符合约定：${headers.join(" / ")}`);
  }
  return lines.slice(2).map((line, rowIndex) => {
    const cells = parseTableRow(line);
    if (cells.length !== expectedHeaders.length) {
      throw new Error(`${label}第 ${rowIndex + 1} 行列数为 ${cells.length}，应为 ${expectedHeaders.length}`);
    }
    return Object.fromEntries(expectedHeaders.map((header, columnIndex) => [header, cells[columnIndex]]));
  });
}

function parseMeta(markdown) {
  const authorityVersion = markdown.match(/指标体系版本：`([^`]+)`/)?.[1];
  const sourceUpdatedOn = markdown.match(/整理日期：`([^`]+)`/)?.[1];
  const authorityStatus = markdown.match(/状态：([^\n]+)/)?.[1]?.trim();
  if (!authorityVersion || !sourceUpdatedOn || !authorityStatus) throw new Error("指标体系元信息不完整");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceUpdatedOn)) throw new Error("指标体系整理日期格式错误");
  return { authorityVersion, sourceUpdatedOn, authorityStatus };
}

function parseCategories(markdown) {
  const match = markdown.match(/### 2\.1 一级分类与二级分类\n([\s\S]*?)(?=\n### 2\.2 推荐呈现方式)/);
  if (!match) throw new Error("未找到一级分类与二级分类映射");
  const rows = tableRows(match[1], ["一级分类", "二级分类", "包含指标"], "指标分类映射");
  const categories = [];
  const categoryByMetricId = new Map();
  const secondaryNames = new Set();
  let metricOrder = 0;

  for (const row of rows) {
    const primary = row["一级分类"];
    const secondary = row["二级分类"];
    const metricIds = row["包含指标"].split(/[、,，\s]+/).filter(Boolean);
    if (!primary || !secondary || metricIds.length === 0) throw new Error(`指标分类映射不完整：${primary || "空分类"} / ${secondary || "空分类"}`);
    if (secondaryNames.has(secondary)) throw new Error(`二级分类重复归属：${secondary}`);
    secondaryNames.add(secondary);

    let primaryCategory = categories.find((category) => category.name === primary);
    if (!primaryCategory) {
      primaryCategory = { name: primary, order: categories.length, children: [] };
      categories.push(primaryCategory);
    }
    const secondaryOrder = primaryCategory.children.length;
    primaryCategory.children.push({ name: secondary, order: secondaryOrder });

    for (const metricId of metricIds) {
      if (!/^M\d{3}$/.test(metricId)) throw new Error(`分类映射包含非法指标ID：${metricId}`);
      if (categoryByMetricId.has(metricId)) throw new Error(`指标重复归入二级分类：${metricId}`);
      categoryByMetricId.set(metricId, {
        primary,
        secondary,
        primaryOrder: primaryCategory.order,
        secondaryOrder,
        metricOrder: metricOrder++
      });
    }
  }
  return { categories, categoryByMetricId };
}

function parseStandardMetrics(markdown) {
  const begin = markdown.indexOf("<!-- METRIC_CATALOG_BEGIN -->");
  const end = markdown.indexOf("<!-- METRIC_CATALOG_END -->");
  if (begin < 0 || end < 0 || end <= begin) throw new Error("指标目录生成标记缺失或顺序错误");
  const rows = tableRows(markdown.slice(begin, end), standardHeaders, "指标目录");
  const ids = new Set();
  const codes = new Set();
  for (const metric of rows) {
    const id = metric["指标ID"];
    const code = metric["指标英文名"];
    if (!/^M\d{3}$/.test(id)) throw new Error(`指标ID格式错误：${id}`);
    if (ids.has(id)) throw new Error(`指标ID重复：${id}`);
    if (codes.has(code)) throw new Error(`指标英文名重复：${code}`);
    if (!sourceStatusCodes.has(metric["状态"])) throw new Error(`未知指标状态：${metric["状态"]}`);
    ids.add(id);
    codes.add(code);
  }
  return rows;
}

function parseDerivedMetrics(markdown) {
  const match = markdown.match(/## 6\. 周期派生指标\n([\s\S]*?)(?=\n## 7\.)/);
  if (!match) throw new Error("未找到周期派生指标");
  const rows = tableRows(match[1], derivedHeaders, "周期派生指标");
  const ids = new Set();
  const codes = new Set();
  for (const metric of rows) {
    const id = metric["派生指标ID"];
    const code = metric["指标英文名"];
    if (!/^DM\d{3}$/.test(id)) throw new Error(`周期派生指标ID格式错误：${id}`);
    if (ids.has(id)) throw new Error(`周期派生指标ID重复：${id}`);
    if (codes.has(code)) throw new Error(`周期派生指标英文名重复：${code}`);
    ids.add(id);
    codes.add(code);
  }
  return rows;
}

function emptyCapabilities() {
  return { grains: [], platformModes: [], dimensions: [], filters: [], comparisons: [] };
}

function mappingAndValidationFor(metricId, authorityVersion, registryByMetricId) {
  const entry = registryByMetricId.get(metricId);
  if (!entry) {
    return {
      ypbiMapping: {
        status: "not_configured",
        mappingVersion: null,
        authorityVersion: null,
        sourceApiIds: [],
        capabilities: emptyCapabilities()
      },
      validation: emptyValidation()
    };
  }
  return {
    ypbiMapping: {
      status: entry.authorityVersion === authorityVersion ? entry.mapping.status : "stale",
      mappingVersion: entry.mappingVersion,
      authorityVersion: entry.authorityVersion,
      sourceApiIds: [...entry.mapping.sourceApiIds],
      capabilities: Object.fromEntries(
        Object.entries(entry.mapping.capabilities).map(([key, values]) => [key, [...values]])
      )
    },
    validation: {
      status: entry.validation.status,
      mappingVersion: entry.validation.mappingVersion,
      authorityVersion: entry.validation.authorityVersion,
      validatedAt: entry.validation.validatedAt,
      evidenceId: entry.validation.evidenceId
    }
  };
}

function emptyValidation() {
  return {
    status: "not_started",
    mappingVersion: null,
    authorityVersion: null,
    validatedAt: null,
    evidenceId: null
  };
}

function deriveAnalysis(authorityVersion, ypbiMapping, validation) {
  let reasonCode = null;
  if (ypbiMapping.status === "not_configured") reasonCode = "mapping_not_configured";
  else if (ypbiMapping.status === "disabled") reasonCode = "mapping_disabled";
  else if (ypbiMapping.status === "stale" || ypbiMapping.authorityVersion !== authorityVersion) reasonCode = "mapping_stale";
  else if (validation.status !== "passed") reasonCode = "validation_not_passed";
  else if (
    validation.mappingVersion !== ypbiMapping.mappingVersion
    || validation.authorityVersion !== authorityVersion
  ) reasonCode = "validation_mapping_mismatch";
  return reasonCode
    ? { status: "unavailable", reasonCodes: [reasonCode] }
    : { status: "available", reasonCodes: [] };
}

function standardMetricItem(metric, classification, authorityVersion, registryByMetricId) {
  const sourceStatusLabel = metric["状态"];
  const { ypbiMapping, validation } = mappingAndValidationFor(
    metric["指标ID"],
    authorityVersion,
    registryByMetricId
  );
  return {
    id: metric["指标ID"],
    kind: "standard",
    code: metric["指标英文名"],
    name: metric["指标中文名"],
    order: classification.metricOrder,
    classification: {
      primary: classification.primary,
      secondary: classification.secondary,
      primaryOrder: classification.primaryOrder,
      secondaryOrder: classification.secondaryOrder
    },
    authority: {
      document: "全站指标体系.md",
      version: authorityVersion,
      sourceBuildStatus: {
        code: sourceStatusCodes.get(sourceStatusLabel),
        label: sourceStatusLabel
      },
      businessDomain: metric["业务域"],
      metricType: metric["指标类型"],
      metricLevel: metric["指标层级"],
      definition: metric["开发现有定义"],
      developmentFormula: metric["开发现有公式"],
      registeredFormula: metric["当前登记公式"],
      deduplication: metric["去重口径"],
      windowAndGrain: metric["窗口与粒度"],
      dataSource: metric["数据来源"],
      exclusions: metric["排除条件"],
      knownIssues: metric["已知问题"],
      recommendedDefinition: metric["建议定义"],
      boundary: null,
      baseMetricIds: [],
      unit: null
    },
    ypbiMapping,
    validation,
    analysis: deriveAnalysis(authorityVersion, ypbiMapping, validation)
  };
}

function derivedMetricItem(metric, order, authorityVersion, standardMetricIds, registryByMetricId) {
  const baseMetricIds = [...metric["基础指标"].matchAll(/\bM\d{3}\b/g)].map((match) => match[0]);
  if (baseMetricIds.length === 0 || baseMetricIds.some((metricId) => !standardMetricIds.has(metricId))) {
    throw new Error(`周期派生指标 ${metric["派生指标ID"]} 未关联有效基础指标`);
  }
  const { ypbiMapping, validation } = mappingAndValidationFor(
    metric["派生指标ID"],
    authorityVersion,
    registryByMetricId
  );
  return {
    id: metric["派生指标ID"],
    kind: "period_derived",
    code: metric["指标英文名"],
    name: metric["派生指标中文名"],
    order,
    classification: null,
    authority: {
      document: "全站指标体系.md",
      version: authorityVersion,
      sourceBuildStatus: {
        code: "tech_claimed_pending_validation",
        label: metric["状态"]
      },
      businessDomain: null,
      metricType: null,
      metricLevel: null,
      definition: metric["定义"],
      developmentFormula: null,
      registeredFormula: metric["公式"],
      deduplication: metric["去重口径"],
      windowAndGrain: metric["窗口与粒度"],
      dataSource: null,
      exclusions: null,
      knownIssues: null,
      recommendedDefinition: null,
      boundary: metric["口径边界"],
      baseMetricIds,
      unit: metric["单位"]
    },
    ypbiMapping,
    validation,
    analysis: deriveAnalysis(authorityVersion, ypbiMapping, validation)
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function contentHashInput(snapshot) {
  const { contentSha256: _ignored, ...metadata } = snapshot.snapshot;
  return { snapshot: metadata, categories: snapshot.categories, items: snapshot.items };
}

export function verifyContentHash(snapshot) {
  return sha256(canonicalJson(contentHashInput(snapshot))) === snapshot.snapshot.contentSha256;
}

export function buildMetricDefinitionsSnapshot(
  markdown,
  registryInput = readMetricMappingRegistry(defaultRegistry),
  validationContext = {}
) {
  const meta = parseMeta(markdown);
  const registry = validateMetricValidationEvidenceFiles(registryInput, validationContext);
  const { categories, categoryByMetricId } = parseCategories(markdown);
  const standardMetrics = parseStandardMetrics(markdown);
  const standardMetricIds = new Set(standardMetrics.map((metric) => metric["指标ID"]));
  const categoryMetricIds = new Set(categoryByMetricId.keys());
  const missingCategoryIds = [...standardMetricIds].filter((metricId) => !categoryMetricIds.has(metricId));
  const unknownCategoryIds = [...categoryMetricIds].filter((metricId) => !standardMetricIds.has(metricId));
  if (missingCategoryIds.length > 0) throw new Error(`标准指标缺少分类归属：${missingCategoryIds.join("、")}`);
  if (unknownCategoryIds.length > 0) throw new Error(`分类映射引用未知标准指标：${unknownCategoryIds.join("、")}`);

  const derivedMetrics = parseDerivedMetrics(markdown);
  const allMetricIds = new Set([
    ...standardMetricIds,
    ...derivedMetrics.map((metric) => metric["派生指标ID"])
  ]);
  const unknownRegistryIds = registry.entries
    .map((entry) => entry.metricId)
    .filter((metricId) => !allMetricIds.has(metricId));
  if (unknownRegistryIds.length > 0) {
    throw new Error(`指标映射注册表引用未知指标：${unknownRegistryIds.join("、")}`);
  }
  const registryByMetricId = new Map(registry.entries.map((entry) => [entry.metricId, entry]));

  const standardItems = standardMetrics
    .map((metric) => standardMetricItem(
      metric,
      categoryByMetricId.get(metric["指标ID"]),
      meta.authorityVersion,
      registryByMetricId
    ))
    .sort((left, right) => left.order - right.order);
  const derivedItems = derivedMetrics.map((metric, index) => (
    derivedMetricItem(
      metric,
      standardItems.length + index,
      meta.authorityVersion,
      standardMetricIds,
      registryByMetricId
    )
  ));
  const items = [...standardItems, ...derivedItems];
  const snapshotWithoutContentHash = {
    schemaVersion: "metric-catalog/v1",
    authorityDocument: "全站指标体系.md",
    authorityVersion: meta.authorityVersion,
    mappingRegistryVersion: registry.registryVersion,
    authorityStatus: meta.authorityStatus,
    sourceUpdatedOn: meta.sourceUpdatedOn,
    sourceSha256: sha256(markdown),
    counts: {
      standard: standardItems.length,
      periodDerived: derivedItems.length,
      total: items.length
    }
  };
  const contentSha256 = sha256(canonicalJson({
    snapshot: snapshotWithoutContentHash,
    categories,
    items
  }));
  return {
    snapshot: { ...snapshotWithoutContentHash, contentSha256 },
    categories,
    items
  };
}

export function snapshotJson(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function buildMetricDefinitionsUiProjection(snapshot) {
  const names = new Map(snapshot.items.map((item) => [item.id, item.name]));
  return {
    schemaVersion: "metric-definitions-ui/v1",
    authorityDocument: snapshot.snapshot.authorityDocument,
    authorityVersion: snapshot.snapshot.authorityVersion,
    sourceContentSha256: snapshot.snapshot.contentSha256,
    items: snapshot.items.map((item) => {
      const definition = metricBusinessExplanation(item, names).text;
      if (definition.includes(BUSINESS_EXPLANATION_PENDING)) throw new Error(`指标 ${item.id} 的业务释义尚未覆盖当前权威公式`);
      return { id: item.id, name: item.name, definition };
    })
  };
}

export function generateMetricDefinitions({
  source = defaultSource,
  output = defaultOutput,
  uiProjection = output === defaultOutput ? defaultUiProjection : null,
  registry = defaultRegistry,
  repositoryRoot = repoRoot,
  platformCatalog = defaultPlatformCatalog,
  attestation = output === defaultOutput
    ? defaultAttestation
    : path.resolve(path.dirname(output), "metric-release-attestation.json"),
  check = false
} = {}) {
  const markdown = fs.readFileSync(source, "utf8");
  repositoryRelativePath(repositoryRoot, registry, "指标映射注册表");
  repositoryRelativePath(repositoryRoot, platformCatalog, "平台目录");
  const registrySerialized = readBoundedUtf8File(registry, "指标映射注册表");
  const platformCatalogSerialized = readBoundedUtf8File(platformCatalog, "平台目录");
  const registryInput = parseMetricMappingRegistry(registrySerialized, registry);
  const validationInspection = inspectMetricValidationEvidenceFiles(registryInput, { repositoryRoot, platformCatalog });
  const snapshot = buildMetricDefinitionsSnapshot(markdown, registryInput, { repositoryRoot, platformCatalog });
  const serialized = snapshotJson(snapshot);
  const uiProjectionSerialized = uiProjection
    ? snapshotJson(buildMetricDefinitionsUiProjection(snapshot))
    : null;
  ensureSafeRepositoryDirectory(repositoryRoot, path.dirname(output), "指标目录快照", { create: !check });
  if (uiProjection) {
    ensureSafeRepositoryDirectory(repositoryRoot, path.dirname(uiProjection), "指标界面投影", { create: !check });
  }
  ensureSafeRepositoryDirectory(repositoryRoot, path.dirname(attestation), "指标发布准入证明", { create: !check });
  const attestationSerialized = releaseAttestationJson({
    repositoryRoot,
    snapshotPath: output,
    snapshotSerialized: serialized,
    registryPath: registry,
    registrySerialized,
    platformCatalogPath: platformCatalog,
    platformCatalogSerialized,
    validationArtifacts: validationInspection.artifacts
  });
  repositoryRelativePath(repositoryRoot, output, "指标目录快照", { mustExist: false });
  if (uiProjection) repositoryRelativePath(repositoryRoot, uiProjection, "指标界面投影", { mustExist: false });
  repositoryRelativePath(repositoryRoot, attestation, "指标发布准入证明", { mustExist: false });
  if (check) {
    if (!fs.existsSync(output)) throw new Error(`指标目录快照不存在：${output}`);
    if (fs.readFileSync(output, "utf8") !== serialized) {
      throw new Error("指标目录快照与权威 Markdown 或映射验数注册表不一致，请运行 npm run metrics:generate");
    }
    if (uiProjection && uiProjectionSerialized) {
      if (!fs.existsSync(uiProjection)) throw new Error(`指标界面投影不存在：${uiProjection}`);
      if (fs.readFileSync(uiProjection, "utf8") !== uiProjectionSerialized) {
        throw new Error("指标界面投影与权威指标目录不一致，请运行 npm run metrics:generate");
      }
    }
    if (!fs.existsSync(attestation)) throw new Error(`指标发布准入证明不存在：${attestation}`);
    if (fs.readFileSync(attestation, "utf8") !== attestationSerialized) {
      throw new Error("指标发布准入证明与快照、注册表、平台目录或验数证据不一致，请运行 npm run metrics:generate");
    }
  } else {
    writeFileAtomic(output, serialized);
    if (uiProjection && uiProjectionSerialized) writeFileAtomic(uiProjection, uiProjectionSerialized);
    writeFileAtomic(attestation, attestationSerialized);
  }
  return snapshot;
}

function parseArguments(argv) {
  const options = { check: false };
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const snapshot = generateMetricDefinitions(parseArguments(process.argv.slice(2)));
    const action = process.argv.includes("--check") ? "已校验" : "已生成";
    console.log(`${action}指标目录快照：${snapshot.snapshot.counts.standard} 个标准指标、${snapshot.snapshot.counts.periodDerived} 个周期派生指标，权威版本 ${snapshot.snapshot.authorityVersion}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
