import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { loadEnv } from "../config/env";
import { SourceReadBudget } from "../v2/source-read-budget";
import { UpstreamClient } from "./client";
import { runWithUpstreamRequestProfile } from "./request-profile";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
const response = (value: number) => new Response(JSON.stringify({ code: 200, msg: { value } }), { status: 200 });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(options: { maxActiveRequests?: number; maxQueuedRequests?: number; timeoutMs?: number } = {}) {
  const requests: Array<{ url: string; headers: RequestInit["headers"]; signal?: AbortSignal | null; resolve: (response: Response) => void; reject: (error: unknown) => void }> = [];
  let active = 0, peak = 0;
  const env = { ...loadEnv({
    NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://production.invalid", UPSTREAM_USER_NAME: "fixture-production-user",
    UPSTREAM_X_TOKEN: "fixture-production-token", UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-queue-absent-${randomUUID()}.json`
  }), REQUEST_TIMEOUT_MS: options.timeoutMs ?? 1000 };
  const client = new UpstreamClient(env, async (url, init) => {
    const held = deferred<Response>();
    let settled = false;
    active++; peak = Math.max(peak, active);
    const finish = (deliver: () => void) => {
      if (settled) return;
      settled = true; active--;
      init?.signal?.removeEventListener("abort", abort);
      deliver();
    };
    const abort = () => finish(() => held.reject(new DOMException("Fixture aborted", "AbortError")));
    init?.signal?.addEventListener("abort", abort, { once: true });
    requests.push({ url: url.toString(), headers: init?.headers, signal: init?.signal,
      resolve: value => finish(() => held.resolve(value)), reject: error => finish(() => held.reject(error)) });
    return held.promise;
  }, { maxActiveRequests: options.maxActiveRequests, maxQueuedRequests: options.maxQueuedRequests });
  return { client, requests, stats: () => ({ active, peak }) };
}

describe("UpstreamClient shared physical request capacity", () => {
  test("sixty unique reads keep the default physical peak at forty and dispatch in FIFO order", async () => {
    const source = fixture(), promises = Array.from({ length: 60 }, (_, index) => source.client.get("/api/fixture", { pid: "PH", index: String(index) }));
    expect(source.requests).toHaveLength(40);
    for (let index = 0; index < 60; index++) {
      expect(new URL(source.requests[index].url).searchParams.get("index")).toBe(String(index));
      source.requests[index].resolve(response(index));
      await flush();
    }
    expect(await Promise.all(promises)).toEqual(Array.from({ length: 60 }, (_, value) => ({ code: 200, msg: { value } })));
    expect(source.stats()).toEqual({ active: 0, peak: 40 });
  });

  test("queued inFlight joins and successful cache hits do not consume additional slots", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1, maxQueuedRequests: 1 });
    const first = client.get("/api/first", { pid: "PH" });
    const queued = client.get("/api/second", { pid: "PH" });
    const joined = client.get("/api/second", { pid: "PH" });
    expect(requests).toHaveLength(1);
    requests[0].resolve(response(1));
    expect(await first).toEqual({ code: 200, msg: { value: 1 } });
    await flush();
    expect(requests).toHaveLength(2);
    expect(await client.get("/api/first", { pid: "PH" })).toEqual({ code: 200, msg: { value: 1 } });
    expect(requests).toHaveLength(2);
    requests[1].resolve(response(2));
    expect(await joined).toEqual(await queued);
    expect(requests).toHaveLength(2);
  });

  test("a physical slot includes response JSON parsing and is released after parse failure", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1 });
    const body = deferred<unknown>(), first = client.get("/api/first", { pid: "PH" });
    const failed = first.catch(error => error), second = client.get("/api/second", { pid: "PH" });
    const heldResponse = response(1);
    Object.defineProperty(heldResponse, "json", { value: () => body.promise });
    requests[0].resolve(heldResponse);
    await flush();
    expect(requests).toHaveLength(1);
    body.reject(new SyntaxError("fixture JSON"));
    expect(await failed).toMatchObject({ code: "UPSTREAM_NETWORK_ERROR" });
    await flush();
    expect(requests).toHaveLength(2);
    requests[1].resolve(response(2));
    expect(await second).toEqual({ code: 200, msg: { value: 2 } });
  });

  test("request expiry includes FIFO waiting and fetch receives only the remaining budget", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1, timeoutMs: 120 });
    const startedAt = performance.now(), first = client.get("/api/first", { pid: "PH" });
    const second = client.get("/api/second", { pid: "PH" }), failed = second.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 70));
    requests[0].resolve(response(1));
    await first;
    expect(await failed).toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
    expect(requests).toHaveLength(2);
    expect(requests[1].signal?.aborted).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(175);
  });

  test("full waiting queues return the existing rate limit and rejected work is not cached", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1, maxQueuedRequests: 1 });
    const first = client.get("/api/first", { pid: "PH" }), second = client.get("/api/second", { pid: "PH" });
    await expect(client.get("/api/third", { pid: "PH" })).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED", statusCode: 429 });
    expect(requests).toHaveLength(1);
    requests[0].resolve(response(1)); await first;
    requests[1].resolve(response(2)); await second;
    const retried = client.get("/api/third", { pid: "PH" });
    expect(requests).toHaveLength(3);
    requests[2].resolve(response(3));
    expect(await retried).toEqual({ code: 200, msg: { value: 3 } });
  });

  test("queued production and independent preview sessions retain their captured environment and partition", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1 });
    const first = client.get("/api/hold", { pid: "PH" });
    const preview = (id: string) => runWithUpstreamRequestProfile({ environment: "test", baseUrl: "https://preview.invalid", userName: id,
      token: `fixture-${id}`, cachePartition: id }, () => client.get("/api/same", { pid: "PH" }));
    const a = preview("preview-a"), b = preview("preview-b"), production = client.get("/api/same", { pid: "PH" });
    requests[0].resolve(response(0)); await first;
    expect(requests[1]).toMatchObject({ url: "https://preview.invalid/api/same?pid=PH", headers: { name: "preview-a", "x-token": "fixture-preview-a" } });
    requests[1].resolve(response(1)); await a;
    expect(requests[2]).toMatchObject({ url: "https://preview.invalid/api/same?pid=PH", headers: { name: "preview-b", "x-token": "fixture-preview-b" } });
    requests[2].resolve(response(2)); await b;
    expect(requests[3]).toMatchObject({ url: "https://production.invalid/api/same?pid=PH", headers: { name: "fixture-production-user", "x-token": "fixture-production-token" } });
    requests[3].resolve(response(3)); await production;
    expect(await preview("preview-a")).toEqual({ code: 200, msg: { value: 1 } });
    expect(await preview("preview-b")).toEqual({ code: 200, msg: { value: 2 } });
    expect(await client.get("/api/same", { pid: "PH" })).toEqual({ code: 200, msg: { value: 3 } });
    expect(requests).toHaveLength(4);
  });

  test("an expired source consumer prevents its queued physical request from starting", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1 }), budget = new SourceReadBudget(20);
    const first = client.get("/api/hold", { pid: "PH" });
    try {
      await expect(budget.read(() => client.get("/api/expired", { pid: "PH" }, undefined, budget.signal))).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
      requests[0].resolve(response(1)); await first; await flush();
      expect(requests).toHaveLength(1);
      const recovery = client.get("/api/expired", { pid: "PH" });
      requests[1].resolve(response(2));
      expect(await recovery).toEqual({ code: 200, msg: { value: 2 } });
    } finally { budget.dispose(); }
  });

  test("one cancelled queued consumer does not cancel another consumer sharing the request", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1 }), short = new AbortController(), long = new AbortController();
    const first = client.get("/api/hold", { pid: "PH" });
    const a = client.get("/api/shared", { pid: "PH" }, undefined, short.signal), b = client.get("/api/shared", { pid: "PH" }, undefined, long.signal);
    short.abort();
    requests[0].resolve(response(0)); await first;
    expect(requests).toHaveLength(2);
    expect(requests[1].signal?.aborted).toBe(false);
    requests[1].resolve(response(1));
    expect(await a).toEqual(await b);
  });

  test("all queued consumers cancelling permits a new live consumer to retry the same key", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1 }), a = new AbortController(), b = new AbortController();
    const first = client.get("/api/hold", { pid: "PH" });
    const earlier = client.get("/api/shared", { pid: "PH" }, undefined, a.signal), joined = client.get("/api/shared", { pid: "PH" }, undefined, b.signal);
    const ended = Promise.allSettled([earlier, joined]);
    a.abort(); b.abort();
    const recovery = client.get("/api/shared", { pid: "PH" });
    expect((await ended).every(result => result.status === "rejected" && result.reason.code === "UPSTREAM_TIMEOUT")).toBe(true);
    requests[0].resolve(response(0)); await first;
    expect(requests).toHaveLength(2);
    requests[1].resolve(response(1));
    expect(await recovery).toEqual({ code: 200, msg: { value: 1 } });
    expect(await client.get("/api/shared", { pid: "PH" })).toEqual({ code: 200, msg: { value: 1 } });
    expect(requests).toHaveLength(2);
  });

  test("an unsignalled consumer keeps shared queued work when another consumer cancels", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1 }), queuedConsumer = new AbortController();
    const first = client.get("/api/hold", { pid: "PH" });
    const cancelled = client.get("/api/shared", { pid: "PH" }, undefined, queuedConsumer.signal), joined = client.get("/api/shared", { pid: "PH" });
    queuedConsumer.abort();
    expect(requests[0].signal?.aborted).toBe(false);
    requests[0].resolve(response(0)); await first;
    expect(requests).toHaveLength(2);
    requests[1].resolve(response(1));
    expect(await cancelled).toEqual(await joined);
  });

  test("all running consumers cancelling aborts the physical request and releases its slot", async () => {
    const { client, requests, stats } = fixture({ maxActiveRequests: 1 }), a = new AbortController(), b = new AbortController();
    const first = client.get("/api/shared", { pid: "PH" }, undefined, a.signal), joined = client.get("/api/shared", { pid: "PH" }, undefined, b.signal);
    const ended = Promise.allSettled([first, joined]), next = client.get("/api/next", { pid: "PH" });
    a.abort();
    expect(requests[0].signal?.aborted).toBe(false);
    b.abort();
    expect(requests[0].signal?.aborted).toBe(true);
    expect((await ended).every(result => result.status === "rejected" && result.reason.code === "UPSTREAM_TIMEOUT")).toBe(true);
    await flush();
    expect(requests).toHaveLength(2);
    expect(stats()).toEqual({ active: 1, peak: 1 });
    requests[1].resolve(response(2));
    expect(await next).toEqual({ code: 200, msg: { value: 2 } });
  });

  test("a healthy consumer joining after dispatch preserves shared running work", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1 }), earlier = new AbortController(), later = new AbortController();
    const first = client.get("/api/shared", { pid: "PH" }, undefined, earlier.signal);
    await flush();
    const joined = client.get("/api/shared", { pid: "PH" }, undefined, later.signal);
    earlier.abort();
    expect(requests).toHaveLength(1);
    expect(requests[0].signal?.aborted).toBe(false);
    requests[0].resolve(response(7));
    expect(await first).toEqual(await joined);
    expect(await client.get("/api/shared", { pid: "PH" })).toEqual({ code: 200, msg: { value: 7 } });
    expect(requests).toHaveLength(1);
  });

  test("an unsignalled consumer joining after dispatch preserves shared running work", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1 }), consumer = new AbortController();
    const first = client.get("/api/shared", { pid: "PH" }, undefined, consumer.signal);
    await flush();
    const joined = client.get("/api/shared", { pid: "PH" });
    consumer.abort();
    expect(requests[0].signal?.aborted).toBe(false);
    requests[0].resolve(response(7));
    expect(await first).toEqual(await joined);
    expect(requests).toHaveLength(1);
  });

  test("running cancellation reaches response JSON parsing and releases the slot after parsing ends", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1 }), consumer = new AbortController();
    const first = client.get("/api/parsing", { pid: "PH" }, undefined, consumer.signal), ended = first.catch(error => error);
    const next = client.get("/api/next", { pid: "PH" });
    const heldResponse = response(1);
    Object.defineProperty(heldResponse, "json", { value: () => new Promise((_resolve, reject) => {
      requests[0].signal?.addEventListener("abort", () => reject(new DOMException("Fixture parsing aborted", "AbortError")), { once: true });
    }) });
    requests[0].resolve(heldResponse);
    await flush();
    expect(requests).toHaveLength(1);
    consumer.abort();
    expect(requests[0].signal?.aborted).toBe(true);
    expect(await ended).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    await flush();
    expect(requests).toHaveLength(2);
    requests[1].resolve(response(2));
    expect(await next).toEqual({ code: 200, msg: { value: 2 } });
  });

  test("a cancelled late JSON success keeps its slot until completion and cannot refill the cache", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1 }), consumer = new AbortController(), body = deferred<unknown>();
    const first = client.get("/api/shared", { pid: "PH" }, undefined, consumer.signal), ended = first.catch(error => error);
    const heldResponse = response(1);
    Object.defineProperty(heldResponse, "json", { value: () => body.promise });
    requests[0].resolve(heldResponse);
    await flush();
    consumer.abort();
    expect(requests[0].signal?.aborted).toBe(true);
    const next = client.get("/api/next", { pid: "PH" });
    expect(requests).toHaveLength(1);
    body.resolve({ code: 200, msg: { value: 1 } });
    await ended;
    await flush();
    expect(requests).toHaveLength(2);
    requests[1].resolve(response(2));
    expect(await next).toEqual({ code: 200, msg: { value: 2 } });
    const recovery = client.get("/api/shared", { pid: "PH" });
    expect(requests).toHaveLength(3);
    requests[2].resolve(response(3));
    expect(await recovery).toEqual({ code: 200, msg: { value: 3 } });
    expect(await client.get("/api/shared", { pid: "PH" })).toEqual({ code: 200, msg: { value: 3 } });
    expect(requests).toHaveLength(3);
  });

  test("source expiry cancels its late running batch without extending physical occupancy", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1, timeoutMs: 100 }), budget = new SourceReadBudget(100);
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      const source = budget.read(() => client.get("/api/late-batch", { pid: "PH" }, undefined, budget.signal));
      await expect(source).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
      expect(budget.expired).toBe(true);
      expect(requests[0].signal?.aborted).toBe(true);
      const next = client.get("/api/next", { pid: "PH" });
      await flush();
      expect(requests).toHaveLength(2);
      requests[1].resolve(response(2));
      expect(await next).toEqual({ code: 200, msg: { value: 2 } });
    } finally { budget.dispose(); }
  });

  test("cancelled consumers and unavailable PIDs fail before HTTP or cache access", async () => {
    const { client, requests } = fixture(), cancelled = new AbortController();
    cancelled.abort();
    await expect(client.get("/api/same", { pid: "PH" }, undefined, cancelled.signal)).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    await expect(client.get("/api/same", { pid: "not-enabled" })).rejects.toMatchObject({ code: "UPSTREAM_PID_NOT_AVAILABLE" });
    expect(requests).toHaveLength(0);
  });

  test("many queued reads share one source abort listener and cancelling removes all registrations", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1 }), consumer = new AbortController();
    const first = client.get("/api/hold", { pid: "PH" });
    const waiting = Array.from({ length: 36 }, (_, index) => client.get("/api/queued", { pid: "PH", index: String(index) }, undefined, consumer.signal));
    const joined = client.get("/api/queued", { pid: "PH", index: "0" }, undefined, consumer.signal);
    const outcomes = Promise.allSettled([...waiting, joined]);
    expect(getEventListeners(consumer.signal, "abort")).toHaveLength(1);
    consumer.abort();
    expect((await outcomes).every(result => result.status === "rejected" && result.reason.code === "UPSTREAM_TIMEOUT")).toBe(true);
    expect(getEventListeners(consumer.signal, "abort")).toHaveLength(0);
    requests[0].resolve(response(0)); await first; await flush();
    expect(requests).toHaveLength(1);
  });

  test("rejection and completion remove the shared source listener when its last physical read ends", async () => {
    const { client, requests } = fixture({ maxActiveRequests: 1, maxQueuedRequests: 2 }), consumer = new AbortController();
    const first = client.get("/api/hold", { pid: "PH" });
    const a = client.get("/api/queued-a", { pid: "PH" }, undefined, consumer.signal), b = client.get("/api/queued-b", { pid: "PH" }, undefined, consumer.signal);
    await expect(client.get("/api/overflow", { pid: "PH" }, undefined, consumer.signal)).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
    expect(getEventListeners(consumer.signal, "abort")).toHaveLength(1);
    requests[0].resolve(response(0)); await first;
    expect(getEventListeners(consumer.signal, "abort")).toHaveLength(1);
    requests[1].resolve(response(1)); await a;
    expect(getEventListeners(consumer.signal, "abort")).toHaveLength(1);
    requests[2].resolve(response(2)); await b;
    expect(getEventListeners(consumer.signal, "abort")).toHaveLength(0);
  });

  test("invalid private physical capacity is rejected", () => {
    for (const value of [0, -1, 0.5, NaN, Infinity]) {
      expect(() => fixture({ maxActiveRequests: value })).toThrow(RangeError);
      expect(() => fixture({ maxQueuedRequests: value })).toThrow(RangeError);
    }
  });
});
