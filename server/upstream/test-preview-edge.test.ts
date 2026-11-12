import { describe, expect, test } from "bun:test";
import { readTestPreviewEdgeRejection } from "./test-preview-edge";

const rayHex = "abcdef0123456789";
const rayId = rayHex + "-SIN";
const signal = new AbortController().signal;
const cloudflare = { server: "cloudflare", "cf-ray": rayId };
const jsonHeaders = { ...cloudflare, "content-type": "application/problem+json; charset=utf-8" };
const edgeBody = { cloudflare_error: true, error_code: 1020, ray_id: rayHex };
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 403, headers: jsonHeaders });

describe("测试预览 Cloudflare 403 分类", () => {
  test("固定响应头无需读取正文，结果只包含允许的错误码与 Ray ID", async () => {
    const response = new Response("untrusted detail", {
      status: 403,
      headers: { ...cloudflare, "cf-error-type": "1006" }
    });
    expect(await readTestPreviewEdgeRejection(response, signal)).toEqual({ code: 1006, rayId });
    expect(response.bodyUsed).toBe(false);
  });

  test("读取匹配 Ray ID 的结构化错误，丢弃其他字段", async () => {
    const response = jsonResponse({ ...edgeBody, detail: "untrusted detail", zone: "example.invalid" });
    expect(await readTestPreviewEdgeRejection(response, signal)).toEqual({ code: 1020, rayId });
    expect(response.body?.locked).toBe(false);
  });

  test("拒绝非 403、缺少 Cloudflare 标记、非固定错误码和畸形 Ray ID", async () => {
    for (const response of [
      new Response(null, { status: 401, headers: { ...cloudflare, "cf-error-type": "1020" } }),
      new Response(null, { status: 403, headers: { "cf-ray": rayId, "cf-error-type": "1020" } }),
      new Response(null, { status: 403, headers: { ...cloudflare, "cf-error-type": "1016" } }),
      new Response(null, { status: 403, headers: { ...cloudflare, "cf-error-type": "1020, 1020" } }),
      new Response(null, { status: 403, headers: { ...cloudflare, "cf-ray": rayId + ", extra", "cf-error-type": "1020" } }),
      new Response(null, { status: 403, headers: { ...cloudflare, "cf-ray": rayHex, "cf-error-type": "1020" } }),
      new Response(null, { status: 403, headers: { ...cloudflare, "cf-ray": rayHex + "-SIN1", "cf-error-type": "1020" } })
    ]) {
      expect(await readTestPreviewEdgeRejection(response, signal)).toBeUndefined();
    }
  });

  test("拒绝非 JSON、畸形 JSON 和不匹配的结构化信号", async () => {
    for (const response of [
      new Response(JSON.stringify(edgeBody), { status: 403, headers: cloudflare }),
      new Response("{", { status: 403, headers: jsonHeaders }),
      jsonResponse({ ...edgeBody, cloudflare_error: false }),
      jsonResponse({ ...edgeBody, error_code: "1020" }),
      jsonResponse({ ...edgeBody, error_code: 1016 }),
      jsonResponse({ ...edgeBody, ray_id: "0123456789abcdef" }),
      jsonResponse({ ...edgeBody, ray_id: rayId }),
      jsonResponse([edgeBody])
    ]) {
      expect(await readTestPreviewEdgeRejection(response, signal)).toBeUndefined();
    }
  });

  test("上限按字节计算，超出 8 KiB 就取消而不等待正文结束", async () => {
    const maxBytes = 8 * 1024;
    const text = JSON.stringify(edgeBody);
    expect(await readTestPreviewEdgeRejection(
      new Response(text.padEnd(maxBytes), { status: 403, headers: jsonHeaders }), signal
    )).toEqual({ code: 1020, rayId });

    const encoder = new TextEncoder();
    const almostFull = encoder.encode(text.padEnd(maxBytes - 1));
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(almostFull);
        controller.enqueue(encoder.encode("字"));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      }
    });
    const response = new Response(stream, { status: 403, headers: jsonHeaders });
    expect(await readTestPreviewEdgeRejection(response, signal)).toBeUndefined();
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  test("调用方取消时停止等待挂起的正文", async () => {
    const controller = new AbortController();
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        markReadStarted();
        return new Promise<void>(() => {});
      },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    const response = new Response(stream, { status: 403, headers: jsonHeaders });
    const outcome = readTestPreviewEdgeRejection(response, controller.signal);
    await readStarted;
    controller.abort();
    expect(await outcome).toBeUndefined();
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  test("中止、无效 UTF-8、读取错误和已加锁的正文均不分类", async () => {
    const locked = jsonResponse(edgeBody);
    const heldReader = locked.body!.getReader();
    const errored = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("untrusted detail")); }
    });
    try {
      expect(await readTestPreviewEdgeRejection(jsonResponse(edgeBody), AbortSignal.abort())).toBeUndefined();
      expect(await readTestPreviewEdgeRejection(locked, signal)).toBeUndefined();
      expect(await readTestPreviewEdgeRejection(new Response(errored, { status: 403, headers: jsonHeaders }), signal)).toBeUndefined();
      expect(await readTestPreviewEdgeRejection(
        new Response(new Uint8Array([0xc3, 0x28]), { status: 403, headers: jsonHeaders }), signal
      )).toBeUndefined();
    } finally {
      heldReader.releaseLock();
    }
  });
});
