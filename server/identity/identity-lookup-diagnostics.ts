export type IdentityLookupPhase = "resolve" | "acquire" | "query" | "map" | "complete";
export type IdentityLookupFailureCode = "deadline_exceeded" | "client_aborted" | "storage_unavailable" | "invalid_resolution" | "unknown";
export type IdentityStorageFailureCode = "query_cancelled" | "lock_unavailable" | "connection_unavailable" | "capacity_exceeded" | "unknown";

export interface IdentityLookupFailureDiagnostics {
  readonly failureCode: IdentityLookupFailureCode;
  readonly phase: IdentityLookupPhase | "unknown";
  readonly elapsedMs?: number;
  readonly phaseElapsedMs?: number;
  readonly deadlineMs?: number;
  readonly deadlineOverrunMs?: number;
  readonly storageFailureCode?: IdentityStorageFailureCode;
}

interface LookupTrace {
  now: () => number;
  startedAt: number;
  phaseStartedAt: number;
  phase: IdentityLookupPhase;
  deadlineMs: number;
  storageFailureCode?: IdentityStorageFailureCode;
  frozen?: IdentityLookupFailureDiagnostics;
}

// Signals and errors are weak keys only. No identity, credentials or SQL are
// copied into the trace, and no authentication result is cached.
const traces = new WeakMap<AbortSignal, LookupTrace>();
const failures = new WeakMap<object, IdentityLookupFailureDiagnostics>();
const phases = new Set<IdentityLookupPhase>(["resolve", "acquire", "query", "map", "complete"]);
const failureCodes = new Set<IdentityLookupFailureCode>(["deadline_exceeded", "client_aborted", "storage_unavailable", "invalid_resolution", "unknown"]);
const unknown = Object.freeze({ failureCode: "unknown", phase: "unknown" } as const);
const duration = (value: number) => Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value))) : 0;
const keyFor = (value: unknown): object | null => value !== null && (typeof value === "object" || typeof value === "function") ? value : null;
function bestEffort<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }

export function beginIdentityLookupDiagnostics(signal: AbortSignal, deadlineMs: number, now: () => number = () => performance.now()) {
  bestEffort(() => {
    const startedAt = now();
    traces.set(signal, { now, startedAt, phaseStartedAt: startedAt, phase: "resolve", deadlineMs: duration(deadlineMs) });
  }, undefined);
}

export function markIdentityLookupPhase(signal: AbortSignal | undefined, phase: IdentityLookupPhase) {
  bestEffort(() => {
    const trace = signal && traces.get(signal);
    if (!trace || trace.frozen || !phases.has(phase) || trace.phase === phase) return;
    const phaseStartedAt = trace.now();
    trace.phase = phase;
    trace.phaseStartedAt = phaseStartedAt;
  }, undefined);
}

function storageFailureCode(error: unknown): IdentityStorageFailureCode {
  let code: unknown;
  try { code = keyFor(error) ? Reflect.get(error as object, "code") : undefined; }
  catch { return "unknown"; }
  switch (code) {
    case "57014": return "query_cancelled";
    case "55P03": return "lock_unavailable";
    case "53300": return "capacity_exceeded";
    case "57P01": case "57P02": case "57P03":
    case "08000": case "08001": case "08003": case "08006": case "08004":
    case "CONNECT_TIMEOUT": case "CONNECTION_CLOSED": case "CONNECTION_DESTROYED": case "CONNECTION_ENDED":
    case "ECONNRESET": case "ECONNREFUSED": case "ETIMEDOUT": case "ENOTFOUND": case "EAI_AGAIN":
      return "connection_unavailable";
    default: return "unknown";
  }
}

export function recordIdentityStorageFailure(signal: AbortSignal | undefined, error: unknown) {
  bestEffort(() => {
    const trace = signal && traces.get(signal);
    if (trace && !trace.frozen) trace.storageFailureCode = storageFailureCode(error);
  }, undefined);
}

export function freezeIdentityLookupFailure(signal: AbortSignal | undefined, code?: IdentityLookupFailureCode): IdentityLookupFailureDiagnostics {
  return bestEffort(() => {
    const trace = signal && traces.get(signal);
    if (!trace) return unknown;
    if (trace.frozen) return trace.frozen;
    const observedAt = trace.now();
    const elapsedMs = duration(observedAt - trace.startedAt);
    const failureCode = code && failureCodes.has(code) ? code : trace.storageFailureCode ? "storage_unavailable" : "unknown";
    trace.frozen = Object.freeze({
      failureCode, phase: trace.phase, elapsedMs,
      phaseElapsedMs: duration(observedAt - trace.phaseStartedAt), deadlineMs: trace.deadlineMs,
      deadlineOverrunMs: duration(observedAt - trace.startedAt - trace.deadlineMs),
      ...(trace.storageFailureCode ? { storageFailureCode: trace.storageFailureCode } : {})
    });
    return trace.frozen;
  }, unknown as IdentityLookupFailureDiagnostics);
}

export function associateIdentityLookupFailure(signal: AbortSignal | undefined, target: unknown) {
  bestEffort(() => {
    const key = keyFor(target);
    if (key) failures.set(key, freezeIdentityLookupFailure(signal));
  }, undefined);
}

export function identityLookupFailureDiagnostics(target: unknown): IdentityLookupFailureDiagnostics {
  return bestEffort(() => {
    const key = keyFor(target);
    return key && failures.get(key) || unknown;
  }, unknown as IdentityLookupFailureDiagnostics);
}
