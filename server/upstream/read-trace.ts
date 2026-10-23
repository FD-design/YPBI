import { AsyncLocalStorage } from "node:async_hooks";
import { UPSTREAM_READ_ERROR_CODES, UPSTREAM_READ_FAILURE_ORIGINS, type UpstreamReadErrorCode, type UpstreamReadFailure, type UpstreamReadFailureOrigin } from "./read-failure";
export type { UpstreamReadErrorCode } from "./read-failure";

export const SOURCE_IDS = ["daily", "cohort", "payment", "channel", "checkin", "watch", "playback", "metrics", "monthly", "acquisition"] as const;
export const GROUP_IDS = ["overall", "new", "old", "android", "ios", "android_old", "ios_old", "natural", "internal", "ali", "wx", "usdt"] as const;
export type UpstreamReadSourceId = typeof SOURCE_IDS[number] | "unknown";
export type UpstreamReadGroupId = typeof GROUP_IDS[number] | "unknown";
type ReadMode = "unassigned" | "cache" | "created" | "reused" | "no_physical";
type Clock = () => number;
export interface UpstreamReadOutcome {
  readonly code?: unknown;
  readonly failure?: Readonly<UpstreamReadFailure>;
}
interface SafeOutcome {
  readonly result: "pending" | "success" | "failure";
  readonly code?: UpstreamReadErrorCode;
  readonly origin?: UpstreamReadFailureOrigin;
  readonly upstreamHttpStatus?: number;
  readonly upstreamBusinessCode?: number;
}
export interface PhysicalReadSnapshot extends SafeOutcome {
  readonly id: number;
  readonly pending: boolean;
  readonly completed: boolean;
  readonly started: boolean;
  readonly headersReceived: boolean;
  readonly bodyReceived: boolean;
  readonly durationMs: number;
  readonly queueWaitMs: number;
  readonly httpWaitMs?: number;
  readonly headersWaitMs?: number;
  readonly bodyWaitMs?: number;
}
export interface LogicalReadSnapshot extends SafeOutcome {
  readonly id: number;
  readonly sourceId: UpstreamReadSourceId;
  readonly groupId: UpstreamReadGroupId;
  readonly mode: ReadMode;
  readonly physicalId?: number;
  readonly pending: boolean;
  readonly completed: boolean;
  readonly durationMs: number;
}
export interface UpstreamReadBoundaryFailure extends SafeOutcome {
  readonly id: number;
  readonly sourceId: UpstreamReadSourceId;
  readonly groupId: UpstreamReadGroupId;
}
export interface UpstreamReadSummary {
  logicalReadCount: number;
  successfulLogicalReadCount: number;
  failedLogicalReadCount: number;
  pendingLogicalReadCount: number;
  physicalCreatedCount: number;
  physicalReusedCount: number;
  cacheHitCount: number;
  noPhysicalCount: number;
  physicalReadCount: number;
  completedPhysicalReadCount: number;
  pendingPhysicalReadCount: number;
  queueWaitMs: number;
  httpWaitMs: number;
  headersWaitMs: number;
  bodyWaitMs: number;
  errorCodeCounts: Partial<Record<UpstreamReadErrorCode, number>>;
  failureOriginCounts: Partial<Record<UpstreamReadFailureOrigin, number>>;
  upstreamHttpStatusCounts: Record<string, number>;
  upstreamBusinessCodeCounts: Record<string, number>;
}
export interface UpstreamReadTraceSnapshot {
  readonly completed: boolean;
  readonly logicalReads: readonly LogicalReadSnapshot[];
  readonly physicalReads: readonly PhysicalReadSnapshot[];
  readonly boundaryFailures: readonly UpstreamReadBoundaryFailure[];
  readonly summary: Readonly<UpstreamReadSummary>;
  readonly bySource: Readonly<Partial<Record<UpstreamReadSourceId, Readonly<UpstreamReadSummary>>>>;
  readonly byGroup: Readonly<Partial<Record<UpstreamReadGroupId, Readonly<UpstreamReadSummary>>>>;
  readonly truncated: { readonly logicalReads: number; readonly physicalReads: number; readonly boundaryFailures: number };
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | "unknown" {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : "unknown";
}
function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}
function safeBusinessCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function outcome(input?: UpstreamReadOutcome): SafeOutcome {
  if (input === undefined) return { result: "success" };
  try {
    const failure = input.failure;
    const origin = failure && enumValue(failure.origin, UPSTREAM_READ_FAILURE_ORIGINS);
    const http = safeHttpStatus(failure?.upstreamHttpStatus);
    const business = safeBusinessCode(failure?.upstreamBusinessCode);
    return {
      result: "failure", code: enumValue(input.code, UPSTREAM_READ_ERROR_CODES),
      ...(origin && origin !== "unknown" ? { origin } : {}),
      ...(http === undefined ? {} : { upstreamHttpStatus: http }),
      ...(business === undefined ? {} : { upstreamBusinessCode: business })
    };
  } catch { return { result: "failure", code: "unknown" }; }
}
function monotonicClock(clock: Clock): Clock {
  let previous = 0;
  return () => {
    try {
      const value = clock();
      if (Number.isFinite(value) && value >= previous) previous = value;
    } catch { /* Diagnostics never replace a request result. */ }
    return previous;
  };
}
const defaultClock = () => performance.now();
const elapsed = (start: number, end: number) => Math.max(0, end - start);
const capacity = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 1 ? Math.min(value!, 256) : 256;

/** One physical request, shared by every observing logical consumer. No request data is accepted. */
export class PhysicalReadTrace {
  private readonly now: Clock;
  private readonly queuedAt: number;
  private startedAt?: number;
  private headersAt?: number;
  private bodyAt?: number;
  private settledAt?: number;
  private httpStatus?: number;
  private settledOutcome?: SafeOutcome;

  constructor(readonly id: number, options: { now?: Clock; queuedAt?: number } = {}) {
    this.now = monotonicClock(options.now ?? defaultClock);
    const at = this.now();
    this.queuedAt = typeof options.queuedAt === "number" && Number.isFinite(options.queuedAt) && options.queuedAt >= 0 ? Math.min(options.queuedAt, at) : at;
  }
  markStarted(): void {
    if (this.startedAt === undefined && this.settledAt === undefined) this.startedAt = this.now();
  }
  markHeaders(status?: number): void {
    if (this.startedAt === undefined || this.headersAt !== undefined || this.settledAt !== undefined) return;
    this.headersAt = this.now();
    this.httpStatus = safeHttpStatus(status);
  }
  markBody(): void {
    if (this.startedAt !== undefined && this.bodyAt === undefined && this.settledAt === undefined) this.bodyAt = this.now();
  }
  markSettled(input?: UpstreamReadOutcome): void {
    if (this.settledAt !== undefined) return;
    this.settledAt = this.now();
    this.settledOutcome = outcome(input);
  }
  /** The collector supplies a local sequence number; caller-provided IDs never leave this object. */
  snapshot(localId: number): PhysicalReadSnapshot {
    const end = this.settledAt ?? this.now();
    return Object.freeze({
      id: localId, pending: this.settledAt === undefined, completed: this.settledAt !== undefined,
      started: this.startedAt !== undefined, headersReceived: this.headersAt !== undefined, bodyReceived: this.bodyAt !== undefined,
      durationMs: elapsed(this.queuedAt, end), queueWaitMs: elapsed(this.queuedAt, this.startedAt ?? end),
      ...(this.startedAt === undefined ? {} : {
        httpWaitMs: elapsed(this.startedAt, end),
        headersWaitMs: elapsed(this.startedAt, this.headersAt ?? end)
      }),
      ...(this.headersAt === undefined ? {} : { bodyWaitMs: elapsed(this.headersAt, this.bodyAt ?? end) }),
      ...(this.settledOutcome ?? { result: "pending" as const }),
      ...(this.httpStatus === undefined ? {} : { upstreamHttpStatus: this.httpStatus })
    });
  }
}

interface LogicalReadState {
  id: number;
  sourceId: UpstreamReadSourceId;
  groupId: UpstreamReadGroupId;
  startedAt: number;
  mode: ReadMode;
  physicalId?: number;
  settledAt?: number;
  outcome?: SafeOutcome;
}
export interface UpstreamReadObserver {
  cacheHit(): void;
  physicalCreated(physical: PhysicalReadTrace): void;
  physicalReused(physical?: PhysicalReadTrace): void;
  noPhysical(): void;
  settle(input?: UpstreamReadOutcome): void;
}
function emptySummary(): UpstreamReadSummary {
  return {
    logicalReadCount: 0, successfulLogicalReadCount: 0, failedLogicalReadCount: 0, pendingLogicalReadCount: 0,
    physicalCreatedCount: 0, physicalReusedCount: 0, cacheHitCount: 0, noPhysicalCount: 0,
    physicalReadCount: 0, completedPhysicalReadCount: 0, pendingPhysicalReadCount: 0,
    queueWaitMs: 0, httpWaitMs: 0, headersWaitMs: 0, bodyWaitMs: 0,
    errorCodeCounts: {}, failureOriginCounts: {}, upstreamHttpStatusCounts: {}, upstreamBusinessCodeCounts: {}
  };
}
function summarize(logical: readonly LogicalReadSnapshot[], physical: readonly PhysicalReadSnapshot[]): Readonly<UpstreamReadSummary> {
  const result = emptySummary();
  for (const read of logical) {
    result.logicalReadCount++;
    if (read.pending) result.pendingLogicalReadCount++;
    else if (read.result === "success") result.successfulLogicalReadCount++;
    else result.failedLogicalReadCount++;
    if (read.mode === "created") result.physicalCreatedCount++;
    else if (read.mode === "reused") result.physicalReusedCount++;
    else if (read.mode === "cache") result.cacheHitCount++;
    else if (read.mode === "no_physical") result.noPhysicalCount++;
    if (read.code) result.errorCodeCounts[read.code] = (result.errorCodeCounts[read.code] ?? 0) + 1;
    if (read.origin) result.failureOriginCounts[read.origin] = (result.failureOriginCounts[read.origin] ?? 0) + 1;
    if (read.upstreamHttpStatus !== undefined) result.upstreamHttpStatusCounts[read.upstreamHttpStatus] = (result.upstreamHttpStatusCounts[read.upstreamHttpStatus] ?? 0) + 1;
    if (read.upstreamBusinessCode !== undefined) result.upstreamBusinessCodeCounts[read.upstreamBusinessCode] = (result.upstreamBusinessCodeCounts[read.upstreamBusinessCode] ?? 0) + 1;
  }
  const ids = new Set(logical.flatMap(read => read.physicalId === undefined ? [] : [read.physicalId]));
  for (const read of physical) {
    if (!ids.has(read.id)) continue;
    result.physicalReadCount++;
    if (read.pending) result.pendingPhysicalReadCount++;
    else result.completedPhysicalReadCount++;
    result.queueWaitMs += read.queueWaitMs;
    result.httpWaitMs += read.httpWaitMs ?? 0;
    result.headersWaitMs += read.headersWaitMs ?? 0;
    result.bodyWaitMs += read.bodyWaitMs ?? 0;
  }
  Object.freeze(result.errorCodeCounts);
  Object.freeze(result.failureOriginCounts);
  Object.freeze(result.upstreamHttpStatusCounts);
  Object.freeze(result.upstreamBusinessCodeCounts);
  return Object.freeze(result);
}

/** Bounded private diagnostics. Calling snapshot seals this collector, including late logical callbacks. */
export class UpstreamReadTrace {
  private readonly now: Clock;
  private readonly maxLogicalReads: number;
  private readonly maxPhysicalReads: number;
  private readonly logical: LogicalReadState[] = [];
  private readonly physical = new Map<PhysicalReadTrace, number>();
  private readonly boundaries: UpstreamReadBoundaryFailure[] = [];
  private readonly omittedPhysical = new WeakSet<PhysicalReadTrace>();
  private droppedLogical = 0;
  private droppedPhysical = 0;
  private droppedBoundary = 0;
  private sealed?: UpstreamReadTraceSnapshot;

  constructor(options: { now?: Clock; maxLogicalReads?: number; maxPhysicalReads?: number } = {}) {
    this.now = monotonicClock(options.now ?? defaultClock);
    this.maxLogicalReads = capacity(options.maxLogicalReads);
    this.maxPhysicalReads = capacity(options.maxPhysicalReads);
  }
  recordBoundaryFailure(sourceId: unknown, groupId: unknown, input: UpstreamReadOutcome): void {
    if (this.sealed) return;
    if (this.boundaries.length >= 256) { this.droppedBoundary++; return; }
    this.boundaries.push(Object.freeze({
      id: this.boundaries.length + 1, sourceId: enumValue(sourceId, SOURCE_IDS), groupId: enumValue(groupId, GROUP_IDS),
      ...outcome(input)
    }));
  }
  observe(sourceId: unknown, groupId: unknown): UpstreamReadObserver | undefined {
    if (this.sealed) return undefined;
    if (this.logical.length >= this.maxLogicalReads) { this.droppedLogical++; return undefined; }
    const read: LogicalReadState = {
      id: this.logical.length + 1, sourceId: enumValue(sourceId, SOURCE_IDS), groupId: enumValue(groupId, GROUP_IDS),
      startedAt: this.now(), mode: "unassigned"
    };
    this.logical.push(read);
    const assign = (mode: ReadMode, physical?: PhysicalReadTrace) => {
      if (this.sealed || read.settledAt !== undefined || read.mode !== "unassigned") return;
      read.mode = mode;
      if (!(physical instanceof PhysicalReadTrace)) return;
      let id = this.physical.get(physical);
      if (id === undefined && this.physical.size < this.maxPhysicalReads) {
        id = this.physical.size + 1;
        this.physical.set(physical, id);
      } else if (id === undefined && !this.omittedPhysical.has(physical)) {
        this.omittedPhysical.add(physical);
        this.droppedPhysical++;
      }
      if (id !== undefined) read.physicalId = id;
    };
    return {
      cacheHit: () => assign("cache"),
      physicalCreated: physical => assign("created", physical),
      physicalReused: physical => assign("reused", physical),
      noPhysical: () => assign("no_physical"),
      settle: input => {
        if (this.sealed || read.settledAt !== undefined) return;
        read.settledAt = this.now();
        read.outcome = outcome(input);
        if (read.mode === "unassigned") read.mode = "no_physical";
      }
    };
  }
  snapshot(): UpstreamReadTraceSnapshot {
    if (this.sealed) return this.sealed;
    const at = this.now();
    const physical = Object.freeze([...this.physical].map(([read, id]) => read.snapshot(id)));
    const logical = Object.freeze(this.logical.map(read => Object.freeze({
      id: read.id, sourceId: read.sourceId, groupId: read.groupId, mode: read.mode,
      ...(read.physicalId === undefined ? {} : { physicalId: read.physicalId }),
      pending: read.settledAt === undefined, completed: read.settledAt !== undefined,
      durationMs: elapsed(read.startedAt, read.settledAt ?? at),
      ...(read.outcome ?? { result: "pending" as const })
    })));
    const bySource: Partial<Record<UpstreamReadSourceId, Readonly<UpstreamReadSummary>>> = {};
    const byGroup: Partial<Record<UpstreamReadGroupId, Readonly<UpstreamReadSummary>>> = {};
    for (const sourceId of [...SOURCE_IDS, "unknown"] as const) {
      const reads = logical.filter(read => read.sourceId === sourceId);
      if (reads.length) bySource[sourceId] = summarize(reads, physical);
    }
    for (const groupId of [...GROUP_IDS, "unknown"] as const) {
      const reads = logical.filter(read => read.groupId === groupId);
      if (reads.length) byGroup[groupId] = summarize(reads, physical);
    }
    this.sealed = Object.freeze({
      completed: logical.every(read => read.completed) && physical.every(read => read.completed),
      logicalReads: logical, physicalReads: physical, boundaryFailures: Object.freeze([...this.boundaries]), summary: summarize(logical, physical),
      bySource: Object.freeze(bySource), byGroup: Object.freeze(byGroup),
      truncated: Object.freeze({ logicalReads: this.droppedLogical, physicalReads: this.droppedPhysical, boundaryFailures: this.droppedBoundary })
    });
    return this.sealed;
  }
}

interface ReadContext { trace: UpstreamReadTrace; sourceId: UpstreamReadSourceId; groupId: UpstreamReadGroupId }
const contexts = new AsyncLocalStorage<ReadContext>();
export function runWithUpstreamReadTrace<T>(trace: UpstreamReadTrace, fn: () => T): T {
  return contexts.run({ trace, sourceId: "unknown", groupId: "unknown" }, fn);
}
export function runWithUpstreamReadContext<T>(input: { sourceId?: unknown; groupId?: unknown }, fn: () => T): T {
  const current = contexts.getStore();
  if (!current) return fn();
  return contexts.run({
    trace: current.trace,
    sourceId: input.sourceId === undefined ? current.sourceId : enumValue(input.sourceId, SOURCE_IDS),
    groupId: input.groupId === undefined ? current.groupId : enumValue(input.groupId, GROUP_IDS)
  }, fn);
}
/** Disabled tracing performs one context lookup and allocates no observer or logical record. */
export function captureUpstreamReadObserver(): UpstreamReadObserver | undefined {
  const current = contexts.getStore();
  return current?.trace.observe(current.sourceId, current.groupId);
}
/** Adapter/aggregate failures stay separate from the observed transport outcome. */
export function recordUpstreamReadBoundaryFailure(input: UpstreamReadOutcome): void {
  const current = contexts.getStore();
  current?.trace.recordBoundaryFailure(current.sourceId, current.groupId, input);
}
