import {
  coreOverviewQuerySchema,
  type CoreOverviewQuery,
  type CoreOverviewQueryInput,
  type CoreOverviewQuerySuccess
} from "../../../../contracts/core-overview.ts";
import {
  beginCoreOverviewCardRetry,
  beginCoreOverviewQuery,
  canRetryCoreOverviewCard,
  CoreOverviewPageModelError,
  CoreOverviewRequestCoordinator,
  coreOverviewCardRetryRequest,
  rejectCoreOverviewCardRetry,
  rejectCoreOverviewQuery,
  resolveCoreOverviewCardRetry,
  resolveCoreOverviewQuery,
  type CoreOverviewCardLocator,
  type CoreOverviewPageState,
  type CoreOverviewRequestFailure
} from "./core-overview-page-model.ts";

export type CoreOverviewQueryGateway = (
  request: CoreOverviewQueryInput,
  signal: AbortSignal
) => Promise<CoreOverviewQuerySuccess>;

interface V2RequestErrorLike {
  name: "V2RequestError";
  kind: "identity_unavailable" | "unauthenticated" | "forbidden" | "error";
  code: string;
  message: string;
  status: number;
  requestId?: string;
}

export class CoreOverviewQueryControllerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CoreOverviewQueryControllerError";
    this.code = code;
  }
}

function isAbortFailure(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function isV2RequestErrorLike(error: unknown): error is V2RequestErrorLike {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<V2RequestErrorLike>;
  return candidate.name === "V2RequestError"
    && ["identity_unavailable", "unauthenticated", "forbidden", "error"].includes(candidate.kind ?? "")
    && typeof candidate.code === "string"
    && typeof candidate.message === "string"
    && typeof candidate.status === "number";
}

function retryableHttpFailure(error: V2RequestErrorLike) {
  if (error.kind !== "error" && error.kind !== "identity_unavailable") return false;
  return error.status === 0 || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

export function coreOverviewRequestFailure(error: unknown): CoreOverviewRequestFailure {
  if (isV2RequestErrorLike(error)) {
    return {
      kind: error.kind,
      code: error.code,
      message: error.message,
      requestId: error.requestId,
      retryable: retryableHttpFailure(error)
    };
  }
  if (error instanceof CoreOverviewPageModelError) {
    return {
      kind: "error",
      code: error.code,
      message: error.message,
      retryable: false
    };
  }
  if (isAbortFailure(error)) {
    return {
      kind: "error",
      code: "REQUEST_ABORTED_UNEXPECTEDLY",
      message: "查询被意外中断，请重试",
      retryable: true
    };
  }
  if (error instanceof TypeError || (error && typeof error === "object" && "name" in error && error.name === "TimeoutError")) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return {
      kind: "error",
      code: offline ? "NETWORK_OFFLINE" : "NETWORK_ERROR",
      message: offline ? "当前网络不可用，请恢复连接后重试" : "暂时无法连接数据服务，请稍后重试",
      retryable: true
    };
  }
  return {
    kind: "error",
    code: "CORE_OVERVIEW_UNEXPECTED_FAILURE",
    message: "核心经营总览暂时无法加载",
    retryable: false
  };
}

export function coreOverviewQueryKey(input: CoreOverviewQueryInput) {
  const parsed = coreOverviewQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new CoreOverviewQueryControllerError("INVALID_CORE_OVERVIEW_QUERY", "核心经营总览查询条件不合法");
  }
  return JSON.stringify(parsed.data);
}

export class CoreOverviewQueryController {
  #state: CoreOverviewPageState | null = null;
  #lastRequest: CoreOverviewQuery | null = null;
  #listeners = new Set<() => void>();
  #sequence = 0;
  readonly #gateway: CoreOverviewQueryGateway;
  readonly #coordinator = new CoreOverviewRequestCoordinator();

  constructor(gateway: CoreOverviewQueryGateway) {
    this.#gateway = gateway;
  }

  readonly getState = () => this.#state;

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #replace(next: CoreOverviewPageState | null) {
    if (next === this.#state) return;
    this.#state = next;
    [...this.#listeners].forEach((listener) => listener());
  }

  #update(update: (current: CoreOverviewPageState | null) => CoreOverviewPageState | null) {
    this.#replace(update(this.#state));
  }

  #nextAttemptId(kind: "full" | "card") {
    this.#sequence += 1;
    return `${kind}-${this.#sequence}`;
  }

  async load(input: CoreOverviewQueryInput) {
    const parsed = coreOverviewQuerySchema.safeParse(input);
    if (!parsed.success) {
      throw new CoreOverviewQueryControllerError("INVALID_CORE_OVERVIEW_QUERY", "核心经营总览查询条件不合法");
    }
    const request = parsed.data;
    const requestKey = JSON.stringify(request);
    const requestId = this.#nextAttemptId("full");
    const signal = this.#coordinator.beginFullRequest();
    this.#lastRequest = request;
    this.#update((current) => beginCoreOverviewQuery(current, requestKey, requestId));

    try {
      const response = await this.#gateway(request, signal);
      if (signal.aborted) return;
      this.#update((current) => current
        ? resolveCoreOverviewQuery(current, requestKey, requestId, response)
        : current);
    } catch (error: unknown) {
      if (signal.aborted) return;
      const failure = coreOverviewRequestFailure(error);
      this.#update((current) => current
        ? rejectCoreOverviewQuery(current, requestKey, requestId, failure)
        : current);
    } finally {
      this.#coordinator.completeFullRequest(signal);
    }
  }

  readonly refresh = async () => {
    if (!this.#lastRequest) {
      throw new CoreOverviewQueryControllerError("CORE_OVERVIEW_NOT_REQUESTED", "核心经营总览尚未发起查询");
    }
    await this.load(this.#lastRequest);
  };

  readonly retryCard = async (locator: CoreOverviewCardLocator) => {
    if (!this.#state || !canRetryCoreOverviewCard(this.#state, locator)) {
      throw new CoreOverviewQueryControllerError("CORE_OVERVIEW_CARD_NOT_RETRYABLE", "当前卡片没有可重试的临时失败");
    }
    const attemptId = this.#nextAttemptId("card");
    const next = this.#state ? beginCoreOverviewCardRetry(this.#state, locator, attemptId) : null;
    if (!next) {
      throw new CoreOverviewQueryControllerError("CORE_OVERVIEW_NOT_LOADED", "看板尚无成功结果，不能重试卡片");
    }
    const request = coreOverviewCardRetryRequest(next, locator, attemptId);
    const signal = this.#coordinator.beginCardRequest(locator);
    this.#replace(next);

    try {
      const response = await this.#gateway(request, signal);
      if (signal.aborted) return;
      this.#update((current) => current
        ? resolveCoreOverviewCardRetry(current, locator, attemptId, response)
        : current);
    } catch (error: unknown) {
      if (signal.aborted) return;
      const failure = coreOverviewRequestFailure(error);
      this.#update((current) => current
        ? rejectCoreOverviewCardRetry(current, locator, attemptId, failure)
        : current);
    } finally {
      this.#coordinator.completeCardRequest(locator, signal);
    }
  };

  cancelPending() {
    this.#coordinator.cancelAll();
  }
}
