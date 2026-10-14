export type InvalidResponsePhase = "json_parse" | "success_schema" | "error_schema" | "query_match";

interface SchemaIssue {
  path: readonly PropertyKey[];
  code: string;
}

const phases = new Set<InvalidResponsePhase>(["json_parse", "success_schema", "error_schema", "query_match"]);
const issueCodes = new Set([
  "invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys",
  "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom"
]);
const staticFields = new Set([
  "success", "data", "schemaVersion", "query", "boardId", "pid", "dateRange", "queryId", "fetchedAt",
  "timezone", "validationStatus", "completeness", "watermark", "sourceApiIds", "series", "metric", "id",
  "name", "unit", "definition", "authorityVersion", "formula", "referenceMetricId", "sourceNote", "inputs",
  "key", "value", "points", "date", "state", "sourceStatus", "periodStatistics", "aggregationVersion",
  "dayCount", "values", "kind", "reason", "error", "code", "message", "requestId", "enabled", "items",
  "categories", "metricIds", "pendingMetricNames", "mode", "testAvailable", "expiresAt", "userName",
  "acquisitionGroups", "channel", "downloadPlatform", "playbackGroups", "videoType", "dimension", "day",
  "summary", "groups", "scopeStatuses", "metricId", "businessDate", "generatedAt", "ruleVersion", "label"
]);

/** Emit bounded contract locations and failure stages for browser diagnosis. */
export function reportInvalidResponse(status: number, phase: InvalidResponsePhase, issues: readonly SchemaIssue[] = []) {
  try {
    if (!phases.has(phase)) return;
    const locations = issues.slice(0, 5).map(issue => ({
      path: issue.path.slice(0, 12).map(part => typeof part === "string" && staticFields.has(part) ? part
        : typeof part === "number" && Number.isSafeInteger(part) && part >= 0 && part <= 100_000 ? part : "*"),
      code: issueCodes.has(issue.code) ? issue.code : "unknown_issue"
    }));
    const diagnostic = {
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0,
      phase,
      ...(locations.length ? { issues: locations } : {})
    };
    console.warn("[BI_RESPONSE_INVALID]", JSON.stringify(diagnostic));
  } catch { /* Diagnostics preserve the original request failure. */ }
}
