import { createHash } from "node:crypto";
import {
  v2MetricDefinitionsDataSchema,
  type V2MetricDefinitionsData,
  type V2MetricDefinitionsSuccess
} from "../../contracts/bi-v2";
import type { MetricDefinitionItem } from "../../contracts/bi-v2";
import { P_DAY_SUM_API } from "../upstream/overview.adapter";
import "./metric-release-admission";
import generatedMetricDefinitions from "./generated/metric-definitions.json";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])])
    );
  }
  return value;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function verifyMetricDefinitionsContentHash(data: V2MetricDefinitionsData) {
  const { contentSha256, ...metadata } = data.snapshot;
  const hashInput = {
    snapshot: metadata,
    categories: data.categories,
    items: data.items
  };
  return sha256(JSON.stringify(canonicalize(hashInput))) === contentSha256;
}

const parsedMetricDefinitions = v2MetricDefinitionsDataSchema.parse(generatedMetricDefinitions);
if (!verifyMetricDefinitionsContentHash(parsedMetricDefinitions)) {
  throw new Error("随 YPBI 发布的指标目录快照完整性校验失败");
}

export const v2MetricDefinitions: V2MetricDefinitionsData = parsedMetricDefinitions;

function sameOrderedValues(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function hasCurrentExecutableMetricMapping(metricDefinition: MetricDefinitionItem) {
  if (
    metricDefinition.ypbiMapping.status !== "configured"
    || metricDefinition.ypbiMapping.mappingVersion === null
    || metricDefinition.ypbiMapping.authorityVersion !== metricDefinition.authority.version
  ) return false;

  if (metricDefinition.id !== "M016" || metricDefinition.ypbiMapping.mappingVersion !== "m016-pday-sum-v1") {
    return false;
  }
  const capabilities = metricDefinition.ypbiMapping.capabilities;
  return sameOrderedValues(metricDefinition.ypbiMapping.sourceApiIds, [P_DAY_SUM_API])
    && sameOrderedValues(capabilities.grains, ["day"])
    && sameOrderedValues(capabilities.platformModes, ["single_pid"])
    && capabilities.dimensions.length === 0
    && capabilities.filters.length === 0
    && capabilities.comparisons.length === 0;
}

const m016Definition = v2MetricDefinitions.items.find((item) => item.id === "M016");
if (!m016Definition) throw new Error("完整指标目录缺少 M016");
export const M016_MAPPING_VERSION = m016Definition.ypbiMapping.mappingVersion;
export const M016_QUERY_MAPPING_EXECUTABLE = hasCurrentExecutableMetricMapping(m016Definition);
export const M016_QUERY_VALIDATION_STATUS = M016_QUERY_MAPPING_EXECUTABLE
  ? m016Definition.analysis.status === "available"
    ? "passed"
    : "pending_validation"
  : null;

export function getV2MetricDefinition(metricId: string) {
  return v2MetricDefinitions.items.find((item) => item.id === metricId);
}

export const v2MetricDefinitionsResponse: V2MetricDefinitionsSuccess = {
  success: true,
  data: v2MetricDefinitions
};
