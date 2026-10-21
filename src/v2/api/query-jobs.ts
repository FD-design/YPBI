import type { z } from "zod";
import {
  biQueryJobCreatedSchema, biQueryJobProgressSchema, biQueryJobRequestSchema,
  biQueryJobResultSchema, biQueryJobStatusSchema, type BiQueryJobRequest
} from "../../../contracts/query-jobs";
import { parseResponse, V2RequestError } from "./client";
import { dataEnvironmentHeaders } from "./dataEnvironmentPreference";

export type BiQueryJobProgress = z.infer<typeof biQueryJobProgressSchema>;
type ResultEnvelope = z.infer<typeof biQueryJobResultSchema>;
export type BiQueryJobCompleted = ResultEnvelope & {
  data: ResultEnvelope["data"] & { status: "SUCCEEDED"; results: NonNullable<ResultEnvelope["data"]["results"]> };
};
export interface BiQueryJobRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Readonly<BiQueryJobProgress>) => void;
}
export interface BiQueryJobRuntime {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const POLL_INTERVAL_MS = 2_000;
const LOCAL_WAIT_MS = 5 * 60_000 + 120_000 + 30_000;
const MAX_READ_RETRIES = 2;
const MAX_POLLS = Math.ceil(LOCAL_WAIT_MS / POLL_INTERVAL_MS);

export class BiQueryJobWaitError extends Error {
  readonly code = "QUERY_JOB_LOCAL_WAIT_TIMEOUT";
  constructor(readonly handle?: string) {
    super("本地等待已结束，后台任务状态未被改变");
    this.name = "BiQueryJobWaitError";
  }
}

export class BiQueryJobTerminalError extends Error {
  readonly code: "QUERY_JOB_FAILED" | "QUERY_JOB_EXPIRED";
  constructor(readonly progress: Readonly<BiQueryJobProgress>) {
    super(progress.status === "EXPIRED" ? "查询结果已过期，请重新查询" : "查询任务执行失败");
    this.name = "BiQueryJobTerminalError";
    this.code = progress.status === "EXPIRED" ? "QUERY_JOB_EXPIRED" : "QUERY_JOB_FAILED";
  }
}

export function invalidQueryJobScope(): never {
  throw new V2RequestError("查询任务响应与本次查询范围不一致", { kind: "error", code: "INVALID_V2_QUERY_RESPONSE", status: 200 });
}

function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

interface QueryJobProtocol<Request, Progress extends BiQueryJobProgress, Created extends { success: true; data: { handle: string } }, Result extends { success: true; data: Progress }, Completed> {
  requestSchema: z.ZodType<Request>;
  createdSchema: z.ZodType<Created>;
  statusSchema: z.ZodType<{ success: true; data: Progress }>;
  resultSchema: z.ZodType<Result>;
  validateCreated: (created: Created, request: Request) => boolean;
  validateProgress: (progress: Progress, request: Request) => boolean;
  progressSnapshot: (progress: Progress) => Progress;
  finish: (result: Result, request: Request) => Completed | null;
}

/** Shared bounded lifecycle; each public protocol validates its own request and result scope. */
export function createQueryJobProtocolRunner<Request, Progress extends BiQueryJobProgress, Created extends { success: true; data: { handle: string } }, Result extends { success: true; data: Progress }, Completed>(
  protocol: QueryJobProtocol<Request, Progress, Created, Result, Completed>, runtime: BiQueryJobRuntime = {}
) {
  const fetcher = runtime.fetch ?? ((input, init) => fetch(input, init));
  const now = runtime.now ?? (() => performance.now());
  const pause = runtime.sleep ?? sleep;
  return async function run(request: Request, options: { signal?: AbortSignal; onProgress?: (progress: Readonly<Progress>) => void } = {}): Promise<Completed> {
    options.signal?.throwIfAborted();
    const parsedRequest = protocol.requestSchema.safeParse(request);
    if (!parsedRequest.success) throw new V2RequestError("查询任务参数不合法", { kind: "error", code: "QUERY_JOB_INVALID", status: 400 });
    const requestBody = JSON.stringify(parsedRequest.data);
    const headers = dataEnvironmentHeaders({ accept: "application/json", "content-type": "application/json" });
    const controller = new AbortController(), deadline = now() + LOCAL_WAIT_MS;
    let handle: string | undefined, readRetries = 0;
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new BiQueryJobWaitError(handle)), LOCAL_WAIT_MS);
    const check = () => {
      options.signal?.throwIfAborted();
      controller.signal.throwIfAborted();
      if (now() >= deadline) throw new BiQueryJobWaitError(handle);
    };
    const delay = async () => {
      check();
      await waitFor(pause(Math.min(POLL_INTERVAL_MS, deadline - now()), controller.signal), controller.signal);
      check();
    };
    const exchange = async <T>(path: string, schema: z.ZodType<T>, body?: string): Promise<T> => {
      check();
      const response = await waitFor(fetcher(path, {
        method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body }),
        signal: controller.signal, headers: new Headers(headers), cache: "no-store", credentials: "same-origin"
      }), controller.signal);
      check();
      const payload = await waitFor(parseResponse(response, schema, controller.signal), controller.signal);
      check();
      return payload;
    };
    const read = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
      for (;;) {
        try { const payload = await exchange(path, schema); check(); return payload; }
        catch (error) {
          check();
          const transient = error instanceof TypeError
            || error instanceof V2RequestError && error.status === 504 && error.code === "V2_UPSTREAM_TIMEOUT";
          if (!transient || readRetries >= MAX_READ_RETRIES) throw error;
          readRetries++;
          await delay();
          check();
        }
      }
    };
    const progress = (value: Progress) => {
      check();
      if (value.handle !== handle || !protocol.validateProgress(value, parsedRequest.data)) return invalidQueryJobScope();
      const snapshot = Object.freeze(protocol.progressSnapshot(value));
      options.onProgress?.(snapshot);
      check();
      if (value.status === "FAILED" || value.status === "EXPIRED") throw new BiQueryJobTerminalError(snapshot);
    };
    try {
      const created = await exchange("/api/bi/v2/queries/jobs", protocol.createdSchema, requestBody);
      check();
      if (!protocol.validateCreated(created, parsedRequest.data)) return invalidQueryJobScope();
      handle = created.data.handle;
      const path = `/api/bi/v2/queries/jobs/${encodeURIComponent(handle)}`;
      for (let polls = 0; polls < MAX_POLLS; polls++) {
        await delay();
        check();
        const state = await read(path, protocol.statusSchema);
        check();
        progress(state.data);
        if (state.data.status !== "SUCCEEDED") continue;
        const result = await read(`${path}/result`, protocol.resultSchema);
        check();
        progress(result.data);
        if (result.data.status !== "SUCCEEDED") continue;
        const completed = protocol.finish(result, parsedRequest.data);
        if (completed === null) continue;
        check();
        return completed;
      }
      throw new BiQueryJobWaitError(handle);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** Independent explicit-metric protocol; dashboards opt in through their scoped protocol. */
export function createBiQueryJobRunner(runtime: BiQueryJobRuntime = {}) {
  return createQueryJobProtocolRunner<BiQueryJobRequest, BiQueryJobProgress, z.infer<typeof biQueryJobCreatedSchema>, ResultEnvelope, BiQueryJobCompleted>({
    requestSchema: biQueryJobRequestSchema, createdSchema: biQueryJobCreatedSchema,
    statusSchema: biQueryJobStatusSchema, resultSchema: biQueryJobResultSchema,
    validateCreated: () => true,
    validateProgress: (value, request) => (value.totalUnits === undefined || value.totalUnits === request.queries.length)
      && (value.completedUnits === undefined || value.completedUnits <= request.queries.length
        && (value.status !== "SUCCEEDED" || value.completedUnits === request.queries.length)),
    progressSnapshot: value => biQueryJobProgressSchema.parse(value),
    finish: (result, request) => {
      if (!result.data.results || result.data.results.length !== request.queries.length) return invalidQueryJobScope();
      return { ...result, data: { ...result.data, status: "SUCCEEDED", results: result.data.results } };
    }
  }, runtime);
}

export const runBiQueryJob = createBiQueryJobRunner();
