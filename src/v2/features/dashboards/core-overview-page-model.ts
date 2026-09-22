import type {
  CoreOverviewCard,
  CoreOverviewMetricId,
  CoreOverviewQueryInput,
  CoreOverviewQuerySuccess
} from "../../../../contracts/core-overview";
import type {
  DashboardMetricAvailableResult,
  DashboardMetricCardModel,
  DashboardMetricComparison,
  DashboardMetricTrendPoint,
  DashboardMetricUnavailableStatus
} from "./dashboard-metric-card-model";

type CoreOverviewScope = CoreOverviewQuerySuccess["data"]["scopeResults"][number]["scope"];

export interface CoreOverviewMetricDefinition {
  id: CoreOverviewMetricId;
  name: string;
  definition: string;
}

export type CoreOverviewMetricDefinitions = Readonly<Record<string, CoreOverviewMetricDefinition>>;

export type CoreOverviewFailureKind = "identity_unavailable" | "unauthenticated" | "forbidden" | "error";

export interface CoreOverviewRequestFailure {
  kind: CoreOverviewFailureKind;
  code: string;
  message: string;
  requestId?: string;
  retryable?: boolean;
}

interface CoreOverviewCardAttemptRetrying {
  status: "retrying";
  attemptId: string;
}

interface CoreOverviewCardAttemptFailed {
  status: "failed";
  attemptId: string;
  failure: CoreOverviewRequestFailure;
}

type CoreOverviewCardAttempt = CoreOverviewCardAttemptRetrying | CoreOverviewCardAttemptFailed;

export type CoreOverviewPageState =
  | { status: "loading"; requestKey: string; requestId: string }
  | { status: "failure"; requestKey: string; requestId: string; failure: CoreOverviewRequestFailure }
  | {
      status: "success";
      requestKey: string;
      activeRequestId: string | null;
      response: CoreOverviewQuerySuccess;
      refresh: "idle" | "refreshing" | "failed";
      refreshFailure: CoreOverviewRequestFailure | null;
      cardAttempts: Readonly<Record<string, CoreOverviewCardAttempt>>;
      cardOverrides: Readonly<Record<string, CoreOverviewCard>>;
    };

export interface CoreOverviewCardLocator {
  scope: CoreOverviewScope;
  metricId: CoreOverviewMetricId;
}

export interface CoreOverviewScopePageModel {
  scope: CoreOverviewScope;
  cards: DashboardMetricCardModel[];
}

export class CoreOverviewPageModelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CoreOverviewPageModelError";
    this.code = code;
  }
}

const NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const RATIO_FORMATTER = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

const AGGREGATION_LABELS: Record<CoreOverviewCard["aggregation"], (days: number) => string> = {
  mature_day_average: (days) => `${days} 个完整业务日日均`,
  period_sum: (days) => `${days} 个完整业务日累计`,
  period_distinct: (days) => `${days} 个完整业务日区间去重`,
  authoritative_period_result: (days) => `${days} 个完整业务日权威周期结果`,
  mature_cohort_result: () => "观察期已结束的注册用户结果"
};

const UNAVAILABLE_STATE_LABELS: Record<string, string> = {
  no_record: "无记录",
  no_value: "有记录但无值",
  not_produced: "尚未产出",
  immature: "尚未成熟"
};

function sameScope(left: CoreOverviewScope, right: CoreOverviewScope) {
  return left.kind === right.kind && (left.kind === "official_overall" || (right.kind === "pid" && left.pid === right.pid));
}

function sameRange(left: readonly [string, string] | null, right: readonly [string, string] | null) {
  if (left === null || right === null) return left === right;
  return left[0] === right[0] && left[1] === right[1];
}

function scopeKey(scope: CoreOverviewScope) {
  return scope.kind === "official_overall" ? "official_overall" : `pid:${encodeURIComponent(scope.pid)}`;
}

export function coreOverviewCardKey(locator: CoreOverviewCardLocator) {
  return `${scopeKey(locator.scope)}|${locator.metricId}`;
}

function cardForLocator(state: Extract<CoreOverviewPageState, { status: "success" }>, locator: CoreOverviewCardLocator) {
  const key = coreOverviewCardKey(locator);
  const override = state.cardOverrides[key];
  if (override) return override;
  return state.response.data.scopeResults.find((result) => sameScope(result.scope, locator.scope))
    ?.cards.find((card) => card.metricId === locator.metricId) ?? null;
}

export function canRetryCoreOverviewCard(state: CoreOverviewPageState, locator: CoreOverviewCardLocator) {
  if (state.status !== "success") return false;
  if (state.activeRequestId !== null || state.refresh === "refreshing") return false;
  const attempt = state.cardAttempts[coreOverviewCardKey(locator)];
  if (attempt?.status === "retrying") return true;
  if (attempt?.status === "failed") return attempt.failure.retryable === true;
  const card = cardForLocator(state, locator);
  return card?.result.status === "failed" && card.result.retryable;
}

function dateCount(range: readonly [string, string]) {
  const start = Date.parse(`${range[0]}T00:00:00Z`);
  const end = Date.parse(`${range[1]}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

function formatCurrency(raw: number, currencyCode: string) {
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: currencyCode,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 2
    }).format(raw);
  } catch {
    return `${currencyCode} ${NUMBER_FORMATTER.format(raw)}`;
  }
}

function formatValue(raw: number, card: CoreOverviewCard, currencyCode: string | null) {
  if (card.valueKind === "ratio") return RATIO_FORMATTER.format(raw * 100);
  if (card.valueKind === "currency" && currencyCode) return formatCurrency(raw, currencyCode);
  return NUMBER_FORMATTER.format(raw);
}

function displayUnit(card: CoreOverviewCard, sourceUnit: string, currencyCode: string | null) {
  if (card.valueKind === "ratio") return "%";
  if (card.valueKind === "currency") return currencyCode ?? sourceUnit;
  return sourceUnit;
}

function signedDifference(raw: number, card: CoreOverviewCard, currencyCode: string | null, sourceUnit: string) {
  if (raw === 0) {
    if (card.valueKind === "ratio") return "0 个百分点";
    if (card.valueKind === "currency") return formatValue(0, card, currencyCode);
    return `0 ${sourceUnit}`;
  }
  const prefix = raw > 0 ? "+" : "−";
  const magnitude = Math.abs(raw);
  if (card.valueKind === "ratio") return `${prefix}${RATIO_FORMATTER.format(magnitude * 100)} 个百分点`;
  if (card.valueKind === "currency") return `${prefix}${formatValue(magnitude, card, currencyCode)}`;
  return `${prefix}${formatValue(magnitude, card, currencyCode)} ${sourceUnit}`;
}

function comparisonModel(
  card: CoreOverviewCard,
  result: Extract<CoreOverviewCard["result"], { status: "available" }>
): DashboardMetricComparison | null {
  const comparison = result.comparison;
  if (!comparison) return null;
  if (comparison.status === "unavailable") {
    return {
      status: "unavailable",
      label: "对比周期暂无结果",
      detail: comparison.message
    };
  }
  const prefix = comparison.direction === "up" ? "↑" : comparison.direction === "down" ? "↓" : "→";
  const display = comparison.kind === "percentage_point"
    ? `${prefix} ${RATIO_FORMATTER.format(Math.abs(comparison.changeValue ?? 0))} 个百分点`
    : comparison.changeValue === null
      ? "基准值为 0，无法计算变化率"
      : `${prefix} ${RATIO_FORMATTER.format(Math.abs(comparison.changeValue) * 100)}%`;
  const currentDisplay = formatValue(result.current.value.raw, card, result.current.value.currencyCode);
  const baselineDisplay = formatValue(comparison.baselineValue.raw, card, comparison.baselineValue.currencyCode);
  return {
    status: "available",
    label: "较对比周期",
    display,
    rows: [
      { label: "当前期", date: result.current.actualRange.join(" 至 "), value: `${currentDisplay} ${displayUnit(card, result.current.value.unit, result.current.value.currencyCode)}` },
      { label: "对比期", date: comparison.actualRange.join(" 至 "), value: `${baselineDisplay} ${displayUnit(card, comparison.baselineValue.unit, comparison.baselineValue.currencyCode)}` }
    ],
    difference: { display: signedDifference(comparison.absoluteDifference, card, result.current.value.currencyCode, result.current.value.unit), direction: comparison.absoluteDifference > 0 ? "up" : comparison.absoluteDifference < 0 ? "down" : "flat" },
    detail: `当前期 ${result.current.actualRange[0]} 至 ${result.current.actualRange[1]}：${currentDisplay}；对比期 ${comparison.actualRange[0]} 至 ${comparison.actualRange[1]}：${baselineDisplay}；相差 ${signedDifference(comparison.absoluteDifference, card, result.current.value.currencyCode, result.current.value.unit)}`,
    direction: comparison.changeValue === null ? null : comparison.direction,
    kind: comparison.kind
  };
}

function trendValue(
  point: Extract<Extract<CoreOverviewCard["result"], { status: "available" }>["trend"]["current"][number], { state: "available" }> | undefined,
  card: CoreOverviewCard,
  unit: string,
  currencyCode: string | null
) {
  if (!point) return null;
  return {
    raw: point.value,
    display: `${formatValue(point.value, card, currencyCode)} ${displayUnit(card, unit, currencyCode)}`,
    actualDate: point.businessDate
  };
}

function trendSeriesModel(
  card: CoreOverviewCard,
  result: Extract<CoreOverviewCard["result"], { status: "available" }>,
  series: "current" | "comparison",
  pairByOffset: boolean
): DashboardMetricTrendPoint[] {
  const points = series === "current" ? result.trend.current : result.trend.comparison ?? [];
  const counterparts = pairByOffset
    ? series === "current" ? result.trend.comparison ?? [] : result.trend.current
    : [];
  return points.map((point, index) => {
    const counterpart = counterparts[index];
    const available = point.state === "available" ? point : undefined;
    const currentAvailable = series === "current" ? available : counterpart?.state === "available" ? counterpart : undefined;
    const comparisonAvailable = series === "comparison" ? available : counterpart?.state === "available" ? counterpart : undefined;
    const difference = currentAvailable && comparisonAvailable
      ? signedDifference(currentAvailable.value - comparisonAvailable.value, card, result.current.value.currencyCode, result.current.value.unit)
      : null;
    return {
      key: `${card.metricId}-${series}-${index}`,
      label: `第 ${index + 1} 日`,
      actualDate: point.businessDate,
      value: trendValue(available, card, result.current.value.unit, result.current.value.currencyCode),
      counterpart: trendValue(counterpart?.state === "available" ? counterpart : undefined, card, result.current.value.unit, result.current.value.currencyCode),
      differenceDisplay: difference,
      state: point.state,
      stateLabel: point.state === "available" ? "可用" : UNAVAILABLE_STATE_LABELS[point.state] ?? point.state
    };
  });
}

function trendModel(
  card: CoreOverviewCard,
  result: Extract<CoreOverviewCard["result"], { status: "available" }>
): DashboardMetricAvailableResult["trend"] {
  const comparison = result.trend.comparison;
  const pairByOffset = Boolean(comparison && comparison.length === result.trend.current.length);
  return {
    current: trendSeriesModel(card, result, "current", pairByOffset),
    comparison: comparison ? trendSeriesModel(card, result, "comparison", pairByOffset) : null
  };
}

function provenanceLabels(provenance: Extract<CoreOverviewCard["result"], { provenance: unknown }>["provenance"]) {
  return {
    validationLabel: "已验数",
    watermarkLabel: `数据完整至 ${provenance.watermark.completeThrough}`,
    watermarkDateTime: provenance.watermark.completeThrough
  };
}

function baseCardModel(
  card: CoreOverviewCard,
  definition: CoreOverviewMetricDefinition,
  periodRange: readonly [string, string]
): DashboardMetricCardModel {
  const days = card.result.status === "available"
    ? card.result.current.includedBusinessDates.length
    : dateCount(periodRange);
  const metric = {
    id: card.metricId,
    name: definition.name,
    aggregationLabel: AGGREGATION_LABELS[card.aggregation](days),
    definitionLabel: definition.definition
  };
  if (card.result.status === "available") {
    const result: DashboardMetricAvailableResult = {
      status: "available",
      completeness: card.result.completeness,
      refresh: { status: "idle" },
      value: {
        raw: card.result.current.value.raw,
        display: formatValue(card.result.current.value.raw, card, card.result.current.value.currencyCode),
        unit: displayUnit(card, card.result.current.value.unit, card.result.current.value.currencyCode)
      },
      comparison: comparisonModel(card, card.result),
      trendKind: card.trendKind,
      trend: trendModel(card, card.result),
      ...provenanceLabels(card.result.provenance)
    };
    return { metric, result };
  }
  if ("provenance" in card.result) {
    return {
      metric,
      result: {
        status: card.result.status,
        contextLabel: `查询范围 ${periodRange[0]} 至 ${periodRange[1]}`,
        retryable: card.result.retryable,
        message: card.result.message,
        ...provenanceLabels(card.result.provenance)
      }
    };
  }
  return {
    metric,
    result: {
      status: card.result.status,
      contextLabel: `查询范围 ${periodRange[0]} 至 ${periodRange[1]}`,
      retryable: card.result.retryable,
      message: card.result.message
    }
  };
}

function applyAttempt(
  model: DashboardMetricCardModel,
  attempt: CoreOverviewCardAttempt | undefined,
  fullRefresh: Extract<CoreOverviewPageState, { status: "success" }>["refresh"],
  fullRefreshFailure: CoreOverviewRequestFailure | null
): DashboardMetricCardModel {
  if (!attempt && fullRefresh === "idle") return model;
  if (model.result.status === "available") {
    const refresh = attempt?.status === "retrying"
      ? { status: "refreshing" as const, source: "card" as const }
      : attempt?.status === "failed"
        ? {
            status: "failed" as const,
            source: "card" as const,
            message: attempt.failure.message,
            retryable: attempt.failure.retryable ?? attempt.failure.kind === "error"
          }
        : fullRefresh === "refreshing"
          ? { status: "refreshing" as const, source: "page" as const }
          : fullRefresh === "failed"
            ? {
                status: "failed" as const,
                source: "page" as const,
                message: fullRefreshFailure?.message ?? "整板刷新失败，保留上次成功结果",
                retryable: fullRefreshFailure?.retryable ?? fullRefreshFailure?.kind === "error"
              }
            : { status: "idle" as const };
    return { ...model, result: { ...model.result, refresh } };
  }
  if (attempt?.status === "retrying") {
    return { ...model, result: { status: "loading", contextLabel: model.result.contextLabel, retryable: false } };
  }
  if (attempt?.status === "failed") {
    return {
      ...model,
      result: {
        status: "failed",
        contextLabel: model.result.contextLabel,
        retryable: attempt.failure.retryable ?? attempt.failure.kind === "error",
        message: attempt.failure.message
      }
    };
  }
  if (fullRefresh === "refreshing") {
    return { ...model, result: { ...model.result, retryable: false } };
  }
  return model;
}

function requireDefinition(definitions: CoreOverviewMetricDefinitions, metricId: CoreOverviewMetricId) {
  const definition = definitions[metricId];
  if (!definition || definition.id !== metricId || !definition.name.trim() || !definition.definition.trim()) {
    throw new CoreOverviewPageModelError(
      "CORE_OVERVIEW_METRIC_DEFINITION_MISSING",
      `${metricId} 缺少指标中心权威定义，不能生成正式卡片`
    );
  }
  return definition;
}

export function coreOverviewScopePageModels(
  state: CoreOverviewPageState,
  definitions: CoreOverviewMetricDefinitions
): CoreOverviewScopePageModel[] {
  if (state.status !== "success") return [];
  return state.response.data.scopeResults.map((scopeResult) => ({
    scope: scopeResult.scope,
    cards: scopeResult.cards.map((baseCard) => {
      const locator = { scope: scopeResult.scope, metricId: baseCard.metricId };
      const key = coreOverviewCardKey(locator);
      const card = state.cardOverrides[key] ?? baseCard;
      const model = baseCardModel(card, requireDefinition(definitions, card.metricId), state.response.data.period.currentRange);
      return applyAttempt(model, state.cardAttempts[key], state.refresh, state.refreshFailure);
    })
  }));
}

export function beginCoreOverviewQuery(
  state: CoreOverviewPageState | null,
  requestKey: string,
  requestId: string
): CoreOverviewPageState {
  if (state?.status === "success" && state.requestKey === requestKey) {
    return { ...state, activeRequestId: requestId, refresh: "refreshing", refreshFailure: null, cardAttempts: {} };
  }
  return { status: "loading", requestKey, requestId };
}

export function resolveCoreOverviewQuery(
  state: CoreOverviewPageState,
  requestKey: string,
  requestId: string,
  response: CoreOverviewQuerySuccess
): CoreOverviewPageState {
  const matchesActiveRequest = state.requestKey === requestKey && (
    (state.status === "loading" && state.requestId === requestId)
    || (state.status === "success" && state.activeRequestId === requestId)
  );
  if (!matchesActiveRequest) return state;
  return {
    status: "success",
    requestKey,
    activeRequestId: null,
    response,
    refresh: "idle",
    refreshFailure: null,
    cardAttempts: {},
    cardOverrides: {}
  };
}

export function rejectCoreOverviewQuery(
  state: CoreOverviewPageState,
  requestKey: string,
  requestId: string,
  failure: CoreOverviewRequestFailure
): CoreOverviewPageState {
  const matchesActiveRequest = state.requestKey === requestKey && (
    (state.status === "loading" && state.requestId === requestId)
    || (state.status === "success" && state.activeRequestId === requestId)
  );
  if (!matchesActiveRequest) return state;
  if (state.status === "success" && failure.kind === "error") {
    return { ...state, activeRequestId: null, refresh: "failed", refreshFailure: failure };
  }
  return { status: "failure", requestKey, requestId, failure };
}

function requireCard(state: Extract<CoreOverviewPageState, { status: "success" }>, locator: CoreOverviewCardLocator) {
  const card = cardForLocator(state, locator);
  if (!card) {
    throw new CoreOverviewPageModelError("CORE_OVERVIEW_CARD_NOT_FOUND", "当前看板结果中不存在待重试卡片");
  }
  return card;
}

export function beginCoreOverviewCardRetry(
  state: CoreOverviewPageState,
  locator: CoreOverviewCardLocator,
  attemptId: string
): CoreOverviewPageState {
  if (state.status !== "success") return state;
  if (state.activeRequestId !== null || state.refresh === "refreshing") {
    throw new CoreOverviewPageModelError(
      "CORE_OVERVIEW_FULL_REFRESH_ACTIVE",
      "整板刷新期间不能同时重试单张卡片"
    );
  }
  requireCard(state, locator);
  const key = coreOverviewCardKey(locator);
  return {
    ...state,
    cardAttempts: { ...state.cardAttempts, [key]: { status: "retrying", attemptId } }
  };
}

export function coreOverviewCardRetryRequest(
  state: CoreOverviewPageState,
  locator: CoreOverviewCardLocator,
  attemptId: string
): CoreOverviewQueryInput {
  if (state.status !== "success") {
    throw new CoreOverviewPageModelError("CORE_OVERVIEW_NOT_LOADED", "看板尚无成功结果，不能发起单卡重试");
  }
  requireCard(state, locator);
  const attempt = state.cardAttempts[coreOverviewCardKey(locator)];
  if (attempt?.status !== "retrying" || attempt.attemptId !== attemptId) {
    throw new CoreOverviewPageModelError("CORE_OVERVIEW_CARD_RETRY_NOT_ACTIVE", "当前卡片重试已失效");
  }
  return {
    scope: locator.scope.kind === "official_overall"
      ? { kind: "official_overall" }
      : { kind: "pids", pids: [locator.scope.pid] },
    period: {
      mode: "explicit",
      currentRange: [state.response.data.period.currentRange[0], state.response.data.period.currentRange[1]],
      comparisonRange: state.response.data.period.comparisonRange
        ? [state.response.data.period.comparisonRange[0], state.response.data.period.comparisonRange[1]]
        : null
    },
    metricIds: [locator.metricId]
  };
}

export function resolveCoreOverviewCardRetry(
  state: CoreOverviewPageState,
  locator: CoreOverviewCardLocator,
  attemptId: string,
  response: CoreOverviewQuerySuccess
): CoreOverviewPageState {
  if (state.status !== "success") return state;
  const key = coreOverviewCardKey(locator);
  const attempt = state.cardAttempts[key];
  if (attempt?.status !== "retrying" || attempt.attemptId !== attemptId) return state;
  const scopeResult = response.data.scopeResults[0];
  const card = scopeResult?.cards[0];
  const periodMatches = sameRange(response.data.period.currentRange, state.response.data.period.currentRange)
    && sameRange(response.data.period.comparisonRange, state.response.data.period.comparisonRange);
  if (
    response.data.scopeResults.length !== 1
    || response.data.requestedMetricIds.length !== 1
    || response.data.requestedMetricIds[0] !== locator.metricId
    || !scopeResult
    || !sameScope(scopeResult.scope, locator.scope)
    || scopeResult.cards.length !== 1
    || card?.metricId !== locator.metricId
    || !periodMatches
  ) {
    throw new CoreOverviewPageModelError(
      "INVALID_CORE_OVERVIEW_CARD_RETRY_RESPONSE",
      "单卡重试响应与原卡片、范围或周期不一致"
    );
  }
  const { [key]: _completedAttempt, ...remainingAttempts } = state.cardAttempts;
  return {
    ...state,
    cardAttempts: remainingAttempts,
    cardOverrides: { ...state.cardOverrides, [key]: card }
  };
}

export function rejectCoreOverviewCardRetry(
  state: CoreOverviewPageState,
  locator: CoreOverviewCardLocator,
  attemptId: string,
  failure: CoreOverviewRequestFailure
): CoreOverviewPageState {
  if (state.status !== "success") return state;
  const key = coreOverviewCardKey(locator);
  const attempt = state.cardAttempts[key];
  if (attempt?.status !== "retrying" || attempt.attemptId !== attemptId) return state;
  requireCard(state, locator);
  return {
    ...state,
    cardAttempts: { ...state.cardAttempts, [key]: { status: "failed", attemptId, failure } }
  };
}

export class CoreOverviewRequestCoordinator {
  #full: AbortController | null = null;
  #cards = new Map<string, AbortController>();

  beginFullRequest() {
    this.cancelAll();
    this.#full = new AbortController();
    return this.#full.signal;
  }

  beginCardRequest(locator: CoreOverviewCardLocator) {
    const key = coreOverviewCardKey(locator);
    this.#cards.get(key)?.abort();
    const controller = new AbortController();
    this.#cards.set(key, controller);
    return controller.signal;
  }

  completeFullRequest(signal: AbortSignal) {
    if (this.#full?.signal === signal) this.#full = null;
  }

  completeCardRequest(locator: CoreOverviewCardLocator, signal: AbortSignal) {
    const key = coreOverviewCardKey(locator);
    const active = this.#cards.get(key);
    if (active?.signal === signal) this.#cards.delete(key);
  }

  cancelAll() {
    this.#full?.abort();
    this.#full = null;
    this.#cards.forEach((controller) => controller.abort());
    this.#cards.clear();
  }
}
