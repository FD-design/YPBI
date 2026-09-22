import type {
  CoreOverviewCard,
  CoreOverviewMetricId,
  CoreOverviewQuery
} from "../../../contracts/core-overview.ts";
import type { MetricDefinitionItem } from "../../../contracts/bi-v2.ts";

type AdmissionUnavailableResult = Extract<CoreOverviewCard["result"], { reasonCode: string }>;

export type CoreOverviewMetricAdmission =
  | { status: "admitted"; definition: MetricDefinitionItem }
  | AdmissionUnavailableResult;

export type CoreOverviewMetricDefinitionResolver = (
  metricId: CoreOverviewMetricId
) => MetricDefinitionItem | undefined;

export class CoreOverviewAdmissionConfigurationError extends Error {
  readonly code:
    | "METRIC_DEFINITION_MISSING"
    | "METRIC_DEFINITION_ID_MISMATCH"
    | "METRIC_ANALYSIS_STATE_INVALID";

  constructor(
    code:
      | "METRIC_DEFINITION_MISSING"
      | "METRIC_DEFINITION_ID_MISMATCH"
      | "METRIC_ANALYSIS_STATE_INVALID",
    message: string
  ) {
    super(message);
    this.name = "CoreOverviewAdmissionConfigurationError";
    this.code = code;
  }
}

function notReady(definition: MetricDefinitionItem): AdmissionUnavailableResult {
  const reasonCode = definition.analysis.reasonCodes[0];
  if (definition.analysis.reasonCodes.length !== 1 || !reasonCode) {
    throw new CoreOverviewAdmissionConfigurationError(
      "METRIC_ANALYSIS_STATE_INVALID",
      `${definition.id} 的不可用分析状态没有唯一权威原因`
    );
  }
  return {
    status: "not_ready",
    reasonCode,
    message: `${definition.name}尚未完成当前映射版本的数据准入`,
    retryable: false
  };
}

function unsupported(reasonCode: string, message: string): AdmissionUnavailableResult {
  return { status: "unsupported", reasonCode, message, retryable: false };
}

/**
 * 只判断指标目录中的治理准入和已声明查询能力。
 *
 * `admitted` 不代表已经存在核心总览 provider，也不代表可信水位已经就绪；
 * 这两个运行条件由后续查询编排层继续失败关闭。
 */
export function decideCoreOverviewMetricAdmission(
  metricId: CoreOverviewMetricId,
  requestedScope: CoreOverviewQuery["scope"],
  resolveDefinition: CoreOverviewMetricDefinitionResolver
): CoreOverviewMetricAdmission {
  const definition = resolveDefinition(metricId);
  if (!definition) {
    throw new CoreOverviewAdmissionConfigurationError(
      "METRIC_DEFINITION_MISSING",
      `核心经营总览指标 ${metricId} 不存在于当前指标定义快照`
    );
  }
  if (definition.id !== metricId) {
    throw new CoreOverviewAdmissionConfigurationError(
      "METRIC_DEFINITION_ID_MISMATCH",
      `核心经营总览指标 ${metricId} 解析到了错误的指标定义`
    );
  }

  // analysis 是由当前权威版本、映射和验数状态唯一派生的事实；这里不再
  // 重算一套准入状态，避免目录与核心总览出现两个权威来源。
  if (definition.analysis.status === "unavailable") return notReady(definition);
  if (definition.analysis.reasonCodes.length !== 0) {
    throw new CoreOverviewAdmissionConfigurationError(
      "METRIC_ANALYSIS_STATE_INVALID",
      `${definition.id} 的可用分析状态仍携带不可用原因`
    );
  }

  const capabilities = definition.ypbiMapping.capabilities;
  if (!capabilities.grains.includes("day")) {
    return unsupported(
      "daily_grain_unsupported",
      `${definition.name}当前不支持核心经营总览所需的日粒度查询`
    );
  }
  if (
    requestedScope.kind === "official_overall"
    && !capabilities.platformModes.includes("official_overall")
  ) {
    return unsupported(
      "official_overall_scope_unsupported",
      `${definition.name}当前不支持正式大盘整体结果`
    );
  }
  if (
    requestedScope.kind === "pids"
    && !capabilities.platformModes.some((mode) => mode === "single_pid" || mode === "multi_pid")
  ) {
    return unsupported(
      "pid_scope_unsupported",
      `${definition.name}当前不支持按业务 PID 查询`
    );
  }

  return { status: "admitted", definition };
}

export function planCoreOverviewAdmissions(
  query: Pick<CoreOverviewQuery, "metricIds" | "scope">,
  resolveDefinition: CoreOverviewMetricDefinitionResolver
) {
  return query.metricIds.map((metricId) => ({
    metricId,
    decision: decideCoreOverviewMetricAdmission(metricId, query.scope, resolveDefinition)
  }));
}
