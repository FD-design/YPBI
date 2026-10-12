import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../config/env";
import { UpstreamClient } from "./client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function fixture() {
  const requests: ReturnType<typeof deferred<Response>>[] = [];
  const client = new UpstreamClient(loadEnv({
    NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://in-memory.invalid", UPSTREAM_USER_NAME: "in-memory-user",
    UPSTREAM_X_TOKEN: "in-memory-token", UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-cache-test-absent-${randomUUID()}.json`
  }), async () => {
    const request = deferred<Response>();
    requests.push(request);
    return request.promise;
  });
  return { client, requests };
}
const response = (value: number) => new Response(JSON.stringify({ code: 200, msg: { value } }), { status: 200 });

test("同key并发读取合并，完成后复用缓存，失败结果不进入缓存", async () => {
  const { client, requests } = fixture();
  const first = client.get("/api/in-memory", { pid: "PH" });
  const joined = client.get("/api/in-memory", { pid: "PH" });
  expect(requests).toHaveLength(1);
  requests[0].resolve(response(7));
  expect(await first).toEqual(await joined);
  expect(await client.get("/api/in-memory", { pid: "PH" })).toEqual({ code: 200, msg: { value: 7 } });
  expect(requests).toHaveLength(1);

  const failure = client.get("/api/in-memory-failed", { pid: "PH" });
  requests[1].reject(new Error("in-memory failure"));
  await expect(failure).rejects.toMatchObject({ code: "UPSTREAM_NETWORK_ERROR" });
  const recovery = client.get("/api/in-memory-failed", { pid: "PH" });
  requests[2].resolve(response(9));
  expect(await recovery).toEqual({ code: 200, msg: { value: 9 } });
  expect(requests).toHaveLength(3);
});

test("请求合并表清空后，旧失败请求不移除新同key请求，后续读取继续合并", async () => {
  const { client, requests } = fixture();
  const earlier = client.get("/api/in-memory", { pid: "PH" });
  // Exercise the in-memory reset performed by credential changes without any
  // credential reads, verification, file writes, or external requests.
  const inFlight = Reflect.get(client, "inFlight") as Map<string, Promise<unknown>>;
  inFlight.clear();
  const current = client.get("/api/in-memory", { pid: "PH" });
  requests[0].reject(new Error("earlier in-memory failure"));
  await expect(earlier).rejects.toMatchObject({ code: "UPSTREAM_NETWORK_ERROR" });
  const joined = client.get("/api/in-memory", { pid: "PH" });
  const readCount = requests.length;
  for (const request of requests.slice(1)) request.resolve(response(11));
  expect(await current).toEqual(await joined);
  expect(readCount).toBe(2);
  expect(inFlight.size).toBe(0);
});
