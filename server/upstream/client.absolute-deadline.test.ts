import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../config/env";
import { SourceReadBudget } from "../v2/source-read-budget";
import { getUpstreamReadFailure, UpstreamClient, UpstreamError } from "./client";
import { runWithUpstreamReadTrace, UpstreamReadTrace } from "./read-trace";

const timeoutMs = 20;
const payload = { code: 200, msg: { fixtureValue: 7 } };
const block = (durationMs = 60) => {
  const stop = performance.now() + durationMs;
  while (performance.now() < stop) {}
};
function fixture(fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, timeout = timeoutMs, maxActiveRequests?: number) {
  let calls = 0;
  const client = new UpstreamClient({
    ...loadEnv({ NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://in-memory.invalid",
      UPSTREAM_USER_NAME: "fixture-user", UPSTREAM_X_TOKEN: "fixture-token",
      UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-deadline-absent-${randomUUID()}.json` }),
    REQUEST_TIMEOUT_MS: timeout
  }, (input, init) => { calls++; return fetcher(input, init); }, { maxActiveRequests });
  return { client, calls: () => calls };
}
function response(json: () => Promise<unknown> = async () => payload) {
  const value = new Response(JSON.stringify(payload), { status: 200 });
  Object.defineProperty(value, "json", { value: json });
  return value;
}
const read = (client: UpstreamClient, signal?: AbortSignal) => client.get("/fixture/deadline", { pid: "PH" }, undefined, signal);
const observed = (client: UpstreamClient, signal?: AbortSignal) => {
  const trace = new UpstreamReadTrace();
  return { trace, result: runWithUpstreamReadTrace(trace, () => read(client, signal)).catch(error => error) };
};
function assertFailure(error: unknown, trace: UpstreamReadTrace, origin = "http_deadline") {
  expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
  expect(getUpstreamReadFailure(error)).toMatchObject({ origin });
  expect(trace.snapshot().physicalReads[0]).toMatchObject({ result: "failure", code: "UPSTREAM_TIMEOUT", origin, pending: false, completed: true });
  expect(trace.snapshot().logicalReads[0]).toMatchObject({ result: "failure", code: "UPSTREAM_TIMEOUT", origin, pending: false, completed: true });
}

describe("UpstreamClient physical absolute deadline", () => {
  for (const outcome of ["success", "rejection", "synchronous throw"] as const) {
    test(`overdue JSON ${outcome} settles as the existing timeout and never enters cache`, async () => {
      let first = true;
      let transportSignal: AbortSignal | null | undefined;
      const source = fixture(async (_input, init) => {
        transportSignal = init?.signal;
        return response(() => {
          if (first) {
            first = false;
            block();
            if (outcome === "synchronous throw") throw new SyntaxError("synthetic overdue parser");
            if (outcome === "rejection") return Promise.reject(new SyntaxError("synthetic overdue parser"));
          }
          return Promise.resolve(payload);
        });
      });
      const current = observed(source.client);
      assertFailure(await current.result, current.trace);
      expect(transportSignal?.aborted).toBe(true);
      expect(await read(source.client)).toEqual(payload);
      expect(source.calls()).toBe(2);
    });
  }

  for (const outcome of ["response", "throw"] as const) {
    test(`overdue synchronous fetch ${outcome} cannot become a response or network failure`, async () => {
      let parseCalls = 0;
      const source = fixture(() => {
        block();
        if (outcome === "throw") throw new Error("synthetic overdue fetch");
        return Promise.resolve(response(async () => { parseCalls++; return payload; }));
      });
      const current = observed(source.client);
      assertFailure(await current.result, current.trace);
      expect(parseCalls).toBe(0);
    });
  }

  test("late cache admission rejects even after fetch and parsing completed within budget", async () => {
    const source = fixture(async () => response());
    const queue = Reflect.get(source.client, "requestWorkQueue") as {
      run: (work: (remainingMs: number) => Promise<unknown>, timeout: number, signal?: AbortSignal) => Promise<unknown>
    };
    const run = queue.run.bind(queue);
    let first = true;
    queue.run = (...args) => run(...args).then(value => {
      if (first) { first = false; block(); }
      return value;
    });
    const current = observed(source.client);
    assertFailure(await current.result, current.trace);
    expect(await read(source.client)).toEqual(payload);
    expect(source.calls()).toBe(2);
  });

  test("source budget expiry cannot leave an overdue physical success in cache", async () => {
    let first = true;
    const source = fixture(async () => response(async () => {
      if (first) { first = false; block(); }
      return payload;
    }));
    const trace = new UpstreamReadTrace();
    const budget = new SourceReadBudget(timeoutMs);
    try {
      await expect(runWithUpstreamReadTrace(trace, () => budget.read(() => read(source.client, budget.signal))))
        .rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
      expect(trace.snapshot().physicalReads[0]).toMatchObject({ result: "failure", code: "UPSTREAM_TIMEOUT", origin: "http_deadline" });
    } finally { budget.dispose(); }
    expect(await read(source.client)).toEqual(payload);
    expect(source.calls()).toBe(2);
  });

  test("consumer cancellation precedes deadline expiry during synchronous parsing", async () => {
    const consumer = new AbortController();
    const source = fixture(async () => response(async () => { consumer.abort(); block(); return payload; }));
    const current = observed(source.client, consumer.signal);
    assertFailure(await current.result, current.trace, "consumer_cancelled");
  });

  test("a cancelled shared consumer preserves a healthy consumer and successful cache", async () => {
    const cancelled = new AbortController(), healthy = new AbortController();
    let finish!: (value: Response) => void;
    let transportSignal: AbortSignal | null | undefined;
    const source = fixture((_input, init) => {
      transportSignal = init?.signal;
      return new Promise(resolve => { finish = resolve; });
    }, 1000);
    const a = read(source.client, cancelled.signal), b = read(source.client, healthy.signal);
    cancelled.abort();
    expect(transportSignal?.aborted).toBe(false);
    finish(response());
    expect(await a).toEqual(payload);
    expect(await b).toEqual(payload);
    expect(await read(source.client)).toEqual(payload);
    expect(source.calls()).toBe(1);
  });

  test("timely slow responses retain their success, trace and cache", async () => {
    let transportSignal: AbortSignal | null | undefined;
    const source = fixture(async (_input, init) => {
      transportSignal = init?.signal;
      await new Promise(resolve => setTimeout(resolve, 20));
      return response();
    }, 200);
    const current = observed(source.client);
    expect(await current.result).toEqual(payload);
    expect(transportSignal?.aborted).toBe(false);
    expect(current.trace.snapshot().physicalReads[0]).toMatchObject({ result: "success", pending: false, completed: true });
    expect(await read(source.client)).toEqual(payload);
    expect(source.calls()).toBe(1);
  });

  test("timely upstream errors and parser failures preserve the original classifications", async () => {
    const upstream = new UpstreamError("UPSTREAM_AUTH_FAILED", "synthetic timely rejection", 401);
    const rejected = fixture(async () => { throw upstream; }, 1000);
    await expect(read(rejected.client)).rejects.toBe(upstream);
    expect(getUpstreamReadFailure(upstream)).toEqual({ origin: "http" });
    const invalid = fixture(async () => response(async () => { throw new SyntaxError("synthetic timely parser"); }), 1000);
    const error = await read(invalid.client).catch(error => error);
    expect(error).toMatchObject({ code: "UPSTREAM_NETWORK_ERROR", statusCode: 502 });
    expect(getUpstreamReadFailure(error)).toEqual({ origin: "validation", upstreamHttpStatus: 200 });
  });

  test("a timer that already cancelled transport keeps the existing HTTP deadline classification", async () => {
    const source = fixture((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("synthetic timer abort", "AbortError")), { once: true });
    }));
    const current = observed(source.client);
    assertFailure(await current.result, current.trace);
  });

  test("physical work retains only the original budget remaining after FIFO waiting", async () => {
    let release!: (value: Response) => void;
    const source = fixture(input => new URL(input.toString()).pathname.endsWith("hold")
      ? new Promise(resolve => { release = resolve; })
      : Promise.resolve(response(async () => {
        await new Promise(resolve => setImmediate(resolve));
        block(90);
        return payload;
      })), 120, 1);
    const first = source.client.get("/fixture/hold", { pid: "PH" });
    const current = observed(source.client);
    await new Promise(resolve => setTimeout(resolve, 50));
    release(response());
    expect(await first).toEqual(payload);
    assertFailure(await current.result, current.trace);
    expect(source.calls()).toBe(2);
  });

  test("query-job physical reads use the same absolute deadline and error contract", async () => {
    const source = fixture(async () => response(async () => { block(); return payload; }));
    const context = source.client.queryJobContext("PH");
    const error = await source.client.requestQueryJob(context, { kind: "status", taskId: "fixture-task" }).catch(error => error);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
    expect(getUpstreamReadFailure(error)).toMatchObject({ origin: "http_deadline", upstreamHttpStatus: 200 });
    expect(source.calls()).toBe(1);
  });
});
