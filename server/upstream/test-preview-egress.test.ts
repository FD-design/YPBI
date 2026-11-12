import { describe, expect, test } from "bun:test";
import { productionDataPreviewDefaults } from "../config/production-data-preview";
import { readDefaultTestPreviewEgress } from "./test-preview-egress";

const origin = productionDataPreviewDefaults.baseUrl;
const traceUrl = new URL("/cdn-cgi/trace", origin);
const hostLine = "h=" + traceUrl.hostname;
const traceHeaders = { server: "cloudflare", "content-type": "text/plain; charset=UTF-8" };
const traceBody = (address: string) => [hostLine, "ip=" + address, "colo=fixture-private-value", ""].join("\n");
const traceResponse = (body: string | ReadableStream<Uint8Array>, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: traceHeaders, ...init });

describe("测试 API 出口诊断", () => {
  test("向固定 URL 发起无凭据的 GET，只投影 Cloudflare 观察到的 IPv4 地址", async () => {
    let calls = 0;
    const result = await readDefaultTestPreviewEgress(async (input, init) => {
      calls++;
      expect(String(input)).toBe(traceUrl.href);
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("omit");
      expect(init?.cache).toBe("no-store");
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeUndefined();
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
        accept: "text/plain",
        "user-agent": "YPBI-Test-Preview/1.0"
      });
      return traceResponse(traceBody("192.0.2.10"));
    }, "YPBI-Test-Preview/1.0");
    expect(calls).toBe(1);
    expect(result).toEqual({ address: "192.0.2.10", family: 4 });
  });

  test("识别 IPv6 与 CRLF，忽略其他 trace 字段", async () => {
    const body = traceBody("2001:db8::42").replaceAll("\n", "\r\n");
    expect(await readDefaultTestPreviewEgress(async () => traceResponse(body)))
      .toEqual({ address: "2001:db8::42", family: 6 });
  });

  test("拒绝错误状态、响应类型、非 Cloudflare 标记和重定向", async () => {
    const body = traceBody("192.0.2.10");
    const redirected = traceResponse(body);
    Object.defineProperty(redirected, "redirected", { value: true });
    const wrongUrl = traceResponse(body);
    Object.defineProperty(wrongUrl, "url", { value: "https://example.invalid/cdn-cgi/trace" });
    for (const response of [
      traceResponse(body, { status: 403 }),
      traceResponse(body, { headers: { ...traceHeaders, "content-type": "text/html" } }),
      traceResponse(body, { headers: { ...traceHeaders, server: "nginx" } }),
      traceResponse(body, { headers: { ...traceHeaders, server: "cloudflare, nginx" } }),
      redirected,
      wrongUrl
    ]) {
      expect(await readDefaultTestPreviewEgress(async () => response)).toBeUndefined();
    }
  });

  test("拒绝重复、错误、缺失和非字面量的地址或主机字段", async () => {
    for (const body of [
      traceBody("192.0.2.10") + hostLine,
      traceBody("192.0.2.10") + "ip=192.0.2.10",
      traceBody("192.0.2.10").replace(hostLine, "h=example.invalid"),
      traceBody("192.0.2.10").replace(hostLine, ""),
      traceBody("192.0.2.10").replace("ip=", "other="),
      traceBody("192.0.2.10:443"),
      traceBody("fe80::1%local"),
      traceBody(" 192.0.2.10"),
      traceBody("192.0.2.010"),
      traceBody("nonnumeric")
    ]) {
      expect(await readDefaultTestPreviewEgress(async () => traceResponse(body))).toBeUndefined();
    }
  });

  test("按字节限制正文，过量立即取消并释放锁", async () => {
    const maxBytes = 2048;
    const body = traceBody("192.0.2.10");
    expect(await readDefaultTestPreviewEgress(async () => traceResponse(body.padEnd(maxBytes))))
      .toEqual({ address: "192.0.2.10", family: 4 });

    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body.padEnd(maxBytes - 1)));
        controller.enqueue(encoder.encode("字"));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      }
    });
    expect(await readDefaultTestPreviewEgress(async () => traceResponse(stream))).toBeUndefined();
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  test("截止时间覆盖响应头和挂起的正文，并终止传输", async () => {
    let headerSignal: RequestInit["signal"];
    let bodySignal: RequestInit["signal"];
    let bodyCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); },
      cancel() { bodyCancelled = true; }
    });
    const [headerResult, bodyResult] = await Promise.all([
      readDefaultTestPreviewEgress(async (_input, init) => {
        headerSignal = init?.signal;
        return new Promise<Response>(() => {});
      }),
      readDefaultTestPreviewEgress(async (_input, init) => {
        bodySignal = init?.signal;
        return traceResponse(stream);
      })
    ]);
    expect(headerResult).toBeUndefined();
    expect(bodyResult).toBeUndefined();
    expect(headerSignal?.aborted).toBe(true);
    expect(bodySignal?.aborted).toBe(true);
    expect(bodyCancelled).toBe(true);
    expect(stream.locked).toBe(false);
  }, 4000);

  test("网络失败或无效 UTF-8 无法产生出口诊断", async () => {
    expect(await readDefaultTestPreviewEgress(async () => { throw new Error("untrusted detail"); })).toBeUndefined();
    const invalid = new Response(new Uint8Array([0xc3, 0x28]), { status: 200, headers: traceHeaders });
    expect(await readDefaultTestPreviewEgress(async () => invalid)).toBeUndefined();
  });
});
