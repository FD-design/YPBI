import {
  CORE_OVERVIEW_CARD_SPECS,
  CORE_OVERVIEW_METRIC_IDS,
  coreOverviewQuerySuccessSchema,
  type CoreOverviewCard,
  type CoreOverviewMetricId,
  type CoreOverviewQuerySuccess
} from "../../../contracts/core-overview";
import {
  beginCoreOverviewCardRetry,
  beginCoreOverviewQuery,
  coreOverviewScopePageModels,
  rejectCoreOverviewCardRetry,
  resolveCoreOverviewQuery,
  type CoreOverviewMetricDefinitions,
  type CoreOverviewPageState
} from "../features/dashboards/core-overview-page-model";
import metricDefinitionsUi from "../generated/metric-definitions-ui.json";

export type CoreOverviewDesignMode = "normal" | "mixed";

const CURRENT_DATES = ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"];
const COMPARISON_DATES = ["2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01"];
const SCOPE = { kind: "official_overall" as const };
const SOURCE_ID = "service:core-overview-design-fixture";

interface AvailableFixture {
  metricId: CoreOverviewMetricId;
  current?: number;
  baseline?: number;
  unit: string;
  currencyCode: string | null;
  values: number[];
  comparisonValues: number[];
}

const AVAILABLE_FIXTURES: AvailableFixture[] = [
  { metricId: "M016", unit: "人", currencyCode: null, values: [182_000, 188_000, 186_000, 191_000, 197_000, 193_000, 201_000], comparisonValues: [176_000, 181_000, 180_000, 184_000, 188_000, 187_000, 191_000] },
  { metricId: "M008", unit: "人", currencyCode: null, values: [6_400, 6_100, 6_800, 7_200, 6_600, 6_300, 5_900], comparisonValues: [6_700, 6_500, 6_600, 7_000, 6_900, 6_700, 6_500] },
  { metricId: "M026", unit: "人", currencyCode: null, values: [142_000, 146_000, 149_000, 150_000, 154_000, 157_000, 161_000], comparisonValues: [139_000, 142_000, 143_000, 145_000, 149_000, 150_000, 153_000] },
  { metricId: "M102", unit: "小时", currencyCode: null, values: [370_000, 383_000, 395_000, 402_000, 420_000, 426_000, 446_916], comparisonValues: [358_000, 367_000, 378_000, 386_000, 397_000, 405_000, 385_968] },
  { metricId: "M059", current: 18_429, baseline: 18_193, unit: "人", currencyCode: null, values: [2_480, 2_520, 2_490, 2_570, 2_600, 2_590, 2_640], comparisonValues: [2_460, 2_470, 2_490, 2_510, 2_550, 2_580, 2_600] },
  { metricId: "M058", unit: "USD", currencyCode: "USD", values: [52_000, 54_000, 51_000, 56_000, 58_000, 57_000, 58_420], comparisonValues: [54_000, 55_000, 54_000, 56_000, 56_000, 57_000, 57_536] },
  { metricId: "M081", current: 0.7813, baseline: 0.7689, unit: "比例", currencyCode: null, values: [0.764, 0.769, 0.771, 0.778, 0.782, 0.784, 0.791], comparisonValues: [0.759, 0.761, 0.763, 0.767, 0.771, 0.774, 0.78] },
  { metricId: "M036", current: 0.6142, baseline: 0.6178, unit: "比例", currencyCode: null, values: [0.621, 0.618, 0.617, 0.614, 0.611, 0.613, 0.614], comparisonValues: [0.624, 0.621, 0.619, 0.618, 0.616, 0.617, 0.618] },
  { metricId: "M020", current: 0.3478, baseline: 0.3396, unit: "比例", currencyCode: null, values: [0.331, 0.338, 0.342, 0.341, 0.349, 0.351, 0.353], comparisonValues: [0.329, 0.332, 0.334, 0.338, 0.34, 0.341, 0.343] }
];

interface DesignMetricAuthority {
  id: string;
  name: string;
  definition: string;
}

if (
  metricDefinitionsUi.schemaVersion !== "metric-definitions-ui/v1"
  || metricDefinitionsUi.authorityDocument !== "全站指标体系.md"
) {
  throw new Error("指标中心界面口径投影版本无效");
}

const metricAuthorityById = new Map(
  metricDefinitionsUi.items.map((item) => [item.id, item satisfies DesignMetricAuthority])
);

export function coreOverviewDesignMetricAuthority(metricId: string): DesignMetricAuthority {
  const metric = metricAuthorityById.get(metricId);
  if (!metric || !metric.name.trim() || !metric.definition.trim()) {
    throw new Error(`${metricId} 缺少指标中心界面口径投影`);
  }
  return metric;
}

export const CORE_OVERVIEW_DESIGN_DEFINITIONS: CoreOverviewMetricDefinitions = Object.fromEntries(
  CORE_OVERVIEW_METRIC_IDS.map((metricId) => [metricId, coreOverviewDesignMetricAuthority(metricId)])
) as CoreOverviewMetricDefinitions;

function spec(metricId: CoreOverviewMetricId) {
  return CORE_OVERVIEW_CARD_SPECS.find((item) => item.metricId === metricId)!;
}

function provenance() {
  return {
    authorityVersion: metricDefinitionsUi.authorityVersion,
    mappingVersion: "design-fixture-only",
    validationStatus: "passed" as const,
    sourceIds: [SOURCE_ID],
    fetchedAt: "2026-09-09T00:05:00+08:00",
    watermark: {
      type: "complete_through_business_date" as const,
      completeThrough: "2026-09-08",
      timeZone: "Asia/Shanghai" as const,
      scope: SCOPE,
      evidence: [{
        sourceId: SOURCE_ID,
        sourceKind: "upstream_explicit" as const,
        observedAt: "2026-09-09T00:01:00+08:00"
      }]
    }
  };
}

function availableCard(fixture: AvailableFixture, options?: { zero?: boolean; partial?: boolean }): CoreOverviewCard {
  const cardSpec = spec(fixture.metricId);
  const ratio = cardSpec.valueKind === "ratio";
  const aggregate = (values: number[], independent: number | undefined) => {
    if (cardSpec.aggregation === "period_sum") return values.reduce((sum, value) => sum + value, 0);
    if (cardSpec.aggregation === "mature_day_average") return values.reduce((sum, value) => sum + value, 0) / values.length;
    if (independent === undefined) throw new Error(`${fixture.metricId} 缺少独立周期演示结果`);
    return independent;
  };
  const currentValues = options?.zero ? fixture.values.map(() => 0) : fixture.values;
  const current = options?.zero ? 0 : aggregate(options?.partial ? currentValues.slice(0, -1) : currentValues, fixture.current);
  const baseline = aggregate(fixture.comparisonValues, fixture.baseline);
  const difference = current - baseline;
  const currentIncludedDates = options?.partial ? CURRENT_DATES.slice(0, -1) : CURRENT_DATES;
  return {
    ...cardSpec,
    result: {
      status: "available",
      completeness: options?.partial ? "partial" : "complete",
      current: {
        actualRange: [currentIncludedDates[0], currentIncludedDates.at(-1)!],
        includedBusinessDates: [...currentIncludedDates],
        value: { raw: current, unit: fixture.unit, currencyCode: fixture.currencyCode }
      },
      comparison: {
        status: "available",
        kind: ratio ? "percentage_point" : "relative_change",
        actualRange: [COMPARISON_DATES[0], COMPARISON_DATES.at(-1)!],
        includedBusinessDates: [...COMPARISON_DATES],
        baselineValue: { raw: baseline, unit: fixture.unit, currencyCode: fixture.currencyCode },
        absoluteDifference: difference,
        changeValue: ratio ? difference * 100 : difference / baseline,
        direction: difference > 0 ? "up" : difference < 0 ? "down" : "flat"
      },
      trend: {
        current: CURRENT_DATES.map((businessDate, offset) => options?.partial && offset === CURRENT_DATES.length - 1
          ? { offset, state: "no_value" as const, businessDate }
          : { offset, state: "available" as const, businessDate, value: currentValues[offset] }),
        comparison: COMPARISON_DATES.map((businessDate, offset) => ({
          offset,
          state: "available" as const,
          businessDate,
          value: fixture.comparisonValues[offset]
        }))
      },
      provenance: provenance()
    }
  };
}

function failedCard(metricId: CoreOverviewMetricId, retryable = true): CoreOverviewCard {
  return {
    ...spec(metricId),
    result: { status: "failed", errorCode: "DESIGN_FIXTURE_FAILURE", message: "设计样板：本卡查询失败", retryable }
  };
}

function dataUnavailableCard(metricId: CoreOverviewMetricId, status: "no_records" | "immature"): CoreOverviewCard {
  return {
    ...spec(metricId),
    result: {
      status,
      message: status === "no_records" ? "当前范围无记录，不补为 0" : "等待注册用户观察期结束",
      retryable: status === "no_records",
      provenance: provenance()
    }
  };
}

function strictResponse(mode: CoreOverviewDesignMode): CoreOverviewQuerySuccess {
  const cards = AVAILABLE_FIXTURES.map((fixture) => {
    if (mode === "normal") return availableCard(fixture);
    if (fixture.metricId === "M026") return failedCard(fixture.metricId);
    if (fixture.metricId === "M058") return failedCard(fixture.metricId, false);
    if (fixture.metricId === "M102") return availableCard(fixture, { zero: true });
    if (fixture.metricId === "M059") return availableCard(fixture, { partial: true });
    if (fixture.metricId === "M036") return dataUnavailableCard(fixture.metricId, "no_records");
    if (fixture.metricId === "M020") return dataUnavailableCard(fixture.metricId, "immature");
    return availableCard(fixture);
  });
  return coreOverviewQuerySuccessSchema.parse({
    success: true,
    data: {
      dashboard: { id: "core-overview", contractVersion: "core-overview/v1" },
      requestedScope: SCOPE,
      requestedMetricIds: [...CORE_OVERVIEW_METRIC_IDS],
      period: {
        mode: "explicit",
        grain: "day",
        timeZone: "Asia/Shanghai",
        currentRange: [CURRENT_DATES[0], CURRENT_DATES.at(-1)!],
        comparisonRange: [COMPARISON_DATES[0], COMPARISON_DATES.at(-1)!],
        commonCompleteThrough: "2026-09-08"
      },
      scopeResults: [{ scope: SCOPE, cards }]
    },
    meta: {
      queryId: `core-overview-design-${mode}`,
      fetchedAt: "2026-09-09T00:05:00+08:00",
      partial: mode === "mixed",
      warnings: mode === "mixed" ? ["设计样板组合异常态"] : []
    }
  });
}

export function coreOverviewDesignPageState(mode: CoreOverviewDesignMode): CoreOverviewPageState {
  const requestKey = `design-${mode}`;
  const requestId = `${requestKey}-request`;
  let state = beginCoreOverviewQuery(null, requestKey, requestId);
  state = resolveCoreOverviewQuery(state, requestKey, requestId, strictResponse(mode));
  if (mode === "mixed") {
    const staleLocator = { scope: SCOPE, metricId: "M008" as const };
    const staleAttemptId = "design-m008-retry";
    state = beginCoreOverviewCardRetry(state, staleLocator, staleAttemptId);
    state = rejectCoreOverviewCardRetry(state, staleLocator, staleAttemptId, {
      kind: "error",
      code: "DESIGN_REFRESH_FAILED",
      message: "设计样板：刷新失败，保留旧值"
    });
    state = beginCoreOverviewCardRetry(state, { scope: SCOPE, metricId: "M026" }, "design-m026-retry");
  }
  return state;
}

export function coreOverviewDesignCardModels(mode: CoreOverviewDesignMode) {
  return coreOverviewScopePageModels(coreOverviewDesignPageState(mode), CORE_OVERVIEW_DESIGN_DEFINITIONS)[0].cards;
}
