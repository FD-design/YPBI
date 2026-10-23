import { describe, expect, test } from "bun:test";
import { loadEnv } from "../config/env";
import { UpstreamClient } from "./client";

function env(baseUrl = "https://response-cleanup.invalid") {
  return loadEnv({
    NODE_ENV: "test", UPSTREAM_API_BASE_URL: baseUrl,
    UPSTREAM_USER_NAME: "fixture-user", UPSTREAM_X_TOKEN: "fixture-token",
    UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-cleanup-unused-${crypto.randomUUID()}.json`
  });
}

async function waitFor(predicate: () => boolean) {
  const end = performance.now() + 500;
  while (!predicate() && performance.now() < end) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

describe("UpstreamClient failed response resource cleanup", () => {
  for (const [status, code] of [
    [401, "UPSTREAM_AUTH_FAILED"], [403, "UPSTREAM_AUTH_FAILED"],
    [429, "UPSTREAM_RATE_LIMITED"], [500, "UPSTREAM_FAILED"],
    [502, "UPSTREAM_FAILED"], [503, "UPSTREAM_FAILED"]
  ] as const) {
    test(`HTTP ${status} closes its unread body and preserves its error`, async () => {
      let cancelled = 0;
      let signal: AbortSignal | null | undefined;
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
      const client = new UpstreamClient(env(), async (_url, init) => {
        signal = init?.signal;
        return new Response(body, { status });
      });
      await expect(client.get("/api/failure", { pid: "PH" })).rejects.toMatchObject({ code });
      expect(signal?.aborted).toBe(true);
      expect(cancelled).toBe(1);
    });
  }

  test("a failed cleanup cannot replace the upstream error or stall the next request", async () => {
    let calls = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { return new Promise<void>(() => {}); } });
    const client = new UpstreamClient(env(), async () => ++calls === 1
      ? new Response(body, { status: 429 })
      : Response.json({ code: 200, msg: { value: 7 } }), { maxActiveRequests: 1 });
    const failed = client.get("/api/failure", { pid: "PH" });
    const next = client.get("/api/healthy", { pid: "PH" });
    await expect(failed).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
    expect(await next).toEqual({ code: 200, msg: { value: 7 } });
  });

  test("cleanup rejection does not become an unhandled rejection", async () => {
    const body = new ReadableStream<Uint8Array>({ cancel() { return Promise.reject(new Error("fixture_cleanup_failed")); } });
    const client = new UpstreamClient(env(), async () => new Response(body, { status: 401 }));
    await expect(client.get("/api/failure", { pid: "PH" })).rejects.toMatchObject({ code: "UPSTREAM_AUTH_FAILED" });
    await Bun.sleep(0);
  });

  test("successful reads leave the completed transport signal untouched and retain cache reuse", async () => {
    let calls = 0;
    let signal: AbortSignal | null | undefined;
    const client = new UpstreamClient(env(), async (_url, init) => {
      calls++; signal = init?.signal;
      return Response.json({ code: 200, msg: { value: 4 } });
    });
    expect(await client.get("/api/healthy", { pid: "PH" })).toEqual({ code: 200, msg: { value: 4 } });
    expect(await client.get("/api/healthy", { pid: "PH" })).toEqual({ code: 200, msg: { value: 4 } });
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(false);
  });

  test("an early HTTP rejection cancels a real streaming loopback response", async () => {
    let cancelled = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("unconsumed fixture body")); },
        cancel() { cancelled++; }
      }), { status: 503 })
    });
    try {
      const client = new UpstreamClient(env(`http://127.0.0.1:${server.port}`));
      await expect(client.get("/api/stream", { pid: "PH" })).rejects.toMatchObject({ code: "UPSTREAM_FAILED" });
      await waitFor(() => cancelled === 1);
    } finally { await server.stop(true); }
  });
});
