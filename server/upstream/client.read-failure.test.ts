import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../config/env";
import { SourceReadBudget } from "../v2/source-read-budget";
import { getUpstreamReadFailure, UpstreamClient, UpstreamError } from "./client";
import { rememberUpstreamReadFailure } from "./read-failure";

function env(timeoutMs = 1000) {
  return { ...loadEnv({ NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://fixture.invalid", UPSTREAM_USER_NAME: "fixture-name", UPSTREAM_X_TOKEN: "fixture-token", UPSTREAM_CREDENTIALS_FILE: `/private/tmp/bi-failure-absent-${randomUUID()}.json` }), REQUEST_TIMEOUT_MS: timeoutMs };
}
const query = { pid: "PH" };
const readError = (client: UpstreamClient) => client.get("/fixture", query).then(() => { throw new Error("expected failure"); }, error => error);

describe("private upstream failure metadata", () => {
  test("numeric HTTP and business provenance is retained without changing public errors", async () => {
    for (const [http, body, code, status, origin] of [
      [500, { code: 500 }, "UPSTREAM_FAILED", 502, "http"],
      [200, { code: 400, err: "unsupported secret-token" }, "UPSTREAM_INVALID_REQUEST", 422, "business"],
      [422, { code: 422, err: "fixture reject" }, "UPSTREAM_INVALID_REQUEST", 422, "business"],
      [401, {}, "UPSTREAM_AUTH_FAILED", 401, "http"]
    ] as const) {
      const client = new UpstreamClient(env(), async () => new Response(JSON.stringify(body), { status: http }));
      const error = await readError(client);
      expect(error).toMatchObject({ code, statusCode: status });
      expect(getUpstreamReadFailure(error)).toMatchObject({ origin, upstreamHttpStatus: http });
      if (http === 200 || http === 422) expect(getUpstreamReadFailure(error)?.upstreamBusinessCode).toBe(body.code);
      expect(Object.keys(error)).toEqual(["code", "statusCode"]);
      expect(JSON.stringify(error)).not.toContain("upstreamHttpStatus");
      expect(JSON.stringify(getUpstreamReadFailure(error))).not.toContain("secret-token");
    }
  });

  test("source budget and consumer cancellation have separate private origins", async () => {
    const budget = new SourceReadBudget(10);
    const budgetError = await budget.read(() => new Promise(() => {})).catch(error => error);
    expect(getUpstreamReadFailure(budgetError)).toEqual({ origin: "source_budget" });
    budget.dispose();
    const controller = new AbortController();
    const cancelled = new SourceReadBudget(1000, controller.signal);
    const pending = cancelled.read(() => new Promise(() => {})).catch(error => error);
    controller.abort();
    expect(getUpstreamReadFailure(await pending)).toEqual({ origin: "consumer_cancelled" });
    cancelled.dispose();
  });

  test("string authentication business codes preserve their actual type and business origin", async () => {
    const error = await readError(new UpstreamClient(env(), async () => new Response(JSON.stringify({ code: "2002", err: "invalid credential" }))));
    expect(error).toMatchObject({ code: "UPSTREAM_AUTH_FAILED", statusCode: 401 });
    expect(getUpstreamReadFailure(error)).toEqual({ origin: "business", upstreamHttpStatus: 200 });
  });

  test("already cancelled consumers do not enqueue or start a physical request", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const client = new UpstreamClient(env(), async () => { calls++; throw new Error("must not start"); });
    const error = await client.get("/fixture", query, undefined, controller.signal).catch(error => error);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
    expect(getUpstreamReadFailure(error)).toEqual({ origin: "consumer_cancelled" });
    expect(calls).toBe(0);
  });

  test("physical deadline and queued deadline keep distinct metadata", async () => {
    const http = new UpstreamClient(env(15), async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("fixture", "AbortError")), { once: true });
    }));
    expect(getUpstreamReadFailure(await readError(http))).toEqual({ origin: "http_deadline" });
    let release!: (value: Response) => void;
    let calls = 0;
    const queue = new UpstreamClient(env(15), async () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); }, { maxActiveRequests: 1 });
    const first = queue.get("/first", query);
    const second = queue.get("/second", query).catch(error => error);
    expect(getUpstreamReadFailure(await second)).toEqual({ origin: "queue_deadline" });
    expect(calls).toBe(1);
    release(new Response(JSON.stringify({ code: 200, msg: {} })));
    await first;
  });

  test("invalid JSON and network failure remain existing public codes", async () => {
    const invalid = await readError(new UpstreamClient(env(), async () => new Response("<html>fixture</html>", { status: 200 })));
    expect(invalid.code).toBe("UPSTREAM_NETWORK_ERROR");
    expect(getUpstreamReadFailure(invalid)).toEqual({ origin: "validation", upstreamHttpStatus: 200 });
    const network = await readError(new UpstreamClient(env(), async () => { throw new TypeError("private URL secret-token"); }));
    expect(network.code).toBe("UPSTREAM_NETWORK_ERROR");
    expect(getUpstreamReadFailure(network)).toEqual({ origin: "network" });
  });

  test("metadata is whitelist-only, immutable, and unavailable for spoofed errors", () => {
    const error = new UpstreamError("UPSTREAM_FAILED", "fixture");
    rememberUpstreamReadFailure(error, { origin: "business", upstreamHttpStatus: NaN, upstreamBusinessCode: -1, token: "private" } as never);
    expect(getUpstreamReadFailure(error)).toEqual({ origin: "business" });
    expect(Object.isFrozen(getUpstreamReadFailure(error))).toBe(true);
    expect(getUpstreamReadFailure(Object.assign(new Error(), { origin: "source_budget" }))).toBeUndefined();
    expect(getUpstreamReadFailure(null)).toBeUndefined();
  });
});
