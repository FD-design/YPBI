import { describe, expect, test } from "bun:test";
import { inspectTestPreviewDeniedResponse } from "./test-preview-edge";

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
    expect(await inspectTestPreviewDeniedResponse(response, signal)).toEqual({ kind: "cloudflare_edge", code: 1006, rayId });
    expect(response.bodyUsed).toBe(false);
  });

  test("读取匹配 Ray ID 的结构化错误，丢弃其他字段", async () => {
    const response = jsonResponse({ ...edgeBody, detail: "untrusted detail", zone: "example.invalid" });
    expect(await inspectTestPreviewDeniedResponse(response, signal)).toEqual({ kind: "cloudflare_edge", code: 1020, rayId });
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
      expect(await inspectTestPreviewDeniedResponse(response, signal)).toMatchObject({ kind: "unclassified" });
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
      expect(await inspectTestPreviewDeniedResponse(response, signal)).toMatchObject({ kind: "unclassified" });
    }
  });

  test("上限按字节计算，超出 8 KiB 就取消而不等待正文结束", async () => {
    const maxBytes = 8 * 1024;
    const text = JSON.stringify(edgeBody);
    expect(await inspectTestPreviewDeniedResponse(
      new Response(text.padEnd(maxBytes), { status: 403, headers: jsonHeaders }), signal
    )).toEqual({ kind: "cloudflare_edge", code: 1020, rayId });

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
    expect(await inspectTestPreviewDeniedResponse(response, signal)).toMatchObject({ kind: "unclassified" });
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
    const outcome = inspectTestPreviewDeniedResponse(response, controller.signal);
    await readStarted;
    controller.abort();
    expect(await outcome).toMatchObject({ kind: "unclassified" });
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
      expect(await inspectTestPreviewDeniedResponse(jsonResponse(edgeBody), AbortSignal.abort())).toMatchObject({ kind: "unclassified" });
      expect(await inspectTestPreviewDeniedResponse(locked, signal)).toMatchObject({ kind: "unclassified" });
      expect(await inspectTestPreviewDeniedResponse(new Response(errored, { status: 403, headers: jsonHeaders }), signal)).toMatchObject({ kind: "unclassified" });
      expect(await inspectTestPreviewDeniedResponse(
        new Response(new Uint8Array([0xc3, 0x28]), { status: 403, headers: jsonHeaders }), signal
      )).toMatchObject({ kind: "unclassified" });
    } finally {
      heldReader.releaseLock();
    }
  });
});

describe("测试预览 403 来源分类", () => {
  test("Cloudflare 代理关联编号可用于追查，泛化 403 保持来源未确认", async () => {
    const response = new Response("<html>Forbidden</html>", { status: 403, headers: cloudflare });
    expect(await inspectTestPreviewDeniedResponse(response, signal)).toEqual({ kind: "unclassified", rayId });
    expect(response.bodyUsed).toBe(false);
    expect(await inspectTestPreviewDeniedResponse(
      new Response(null, { status: 403, headers: { "cf-ray": rayId } }), signal
    )).toEqual({ kind: "unclassified" });
  });

  test("读取真实 403 中固定的业务码和鉴权正文形态", async () => {
    const jsonWithoutProxy = (body: unknown) => new Response(JSON.stringify(body), {
      status: 403, headers: { "content-type": "application/json" }
    });
    expect(await inspectTestPreviewDeniedResponse(jsonWithoutProxy({ code: 2002, err: "请重新登录" }), signal))
      .toEqual({ kind: "upstream_auth", code: 2002 });
    expect(await inspectTestPreviewDeniedResponse(jsonResponse({ code: "2002", err: ["请联系管理员", "IP 限制"] }), signal))
      .toEqual({ kind: "upstream_ip_restricted", code: 2002, rayId });
    expect(await inspectTestPreviewDeniedResponse(jsonResponse(edgeBody), signal))
      .toEqual({ kind: "cloudflare_edge", code: 1020, rayId });
  });

  test("拒绝形态不匹配、正文信号冲突和过大的业务错误数组", async () => {
    for (const body of [
      { code: "02002", err: "IP限制" },
      { code: 403, err: "IP限制" },
      { code: 2002, err: "   " },
      { code: 2002, err: { message: "IP限制" } },
      { code: 2002, err: ["IP限制", false] },
      { code: 2002, err: Array(9).fill("IP限制") },
      { code: 2002, err: "IP限制" + "x".repeat(1024) },
      { ...edgeBody, error_code: 1016, code: 2002, err: "IP限制" }
    ]) {
      expect(await inspectTestPreviewDeniedResponse(jsonResponse(body), signal))
        .toEqual({ kind: "unclassified", rayId });
    }
  });

  test("诊断子期限取消挂起正文，保留已知的代理关联编号", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); },
      cancel() { cancelled = true; }
    });
    const response = new Response(stream, { status: 403, headers: jsonHeaders });
    expect(await inspectTestPreviewDeniedResponse(response, signal)).toEqual({ kind: "unclassified", rayId });
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  }, 2500);
});

describe("测试预览 Cloudflare HTML 拒绝页", () => {
  const host = "api.example.invalid";
  const htmlHeaders = { ...cloudflare, "content-type": "text/html; charset=UTF-8" };
  const denialPage = [
    "<!doctype html><html><head>",
    "<title>Access denied | " + host + " used Cloudflare to restrict access | " + host + " | Cloudflare</title>",
    "</head><body>",
    '<div id="cf-wrapper"><div id="cf-error-details">',
    "<header><h1>Error <span>1010</span></h1><h2>Access denied</h2></header>",
    "<main><h2>What happened?</h2></main>",
    '<div class="cf-error-footer"><p><span>Cloudflare Ray ID: <strong>' + rayHex + "</strong></span>",
    "<span>Performance and Security by Cloudflare</span></p></div>",
    "</div></div></body></html>"
  ].join("\n");

  function htmlResponse(body: string, options: { headers?: ResponseInit["headers"]; status?: number; host?: string } = {}) {
    const response = new Response(body, { status: options.status ?? 403, headers: options.headers ?? htmlHeaders });
    Object.defineProperty(response, "url", { value: "https://" + (options.host ?? host) + "/api/admin/stats" });
    return response;
  }

  test("匹配已知模板的单个嵌套错误标题、关联编号和响应来源", async () => {
    const html = denialPage.replace("<main>", [
      "<!-- <h1>Error 1006</h1> -->",
      '<script>const fake = "<h1>Error 1020</h1>";</script>',
      '<style>.fake::before { content: "<h1>Error 1009</h1>"; }</style>',
      "<template><h1>Error 1106</h1></template><main>"
    ].join("\n"));
    expect(await inspectTestPreviewDeniedResponse(htmlResponse(html), signal))
      .toEqual({ kind: "cloudflare_edge", code: 1010, rayId });
  });

  test("泛化、错源、缺模板、重复或正文 Ray 不一致时只保留可关联的响应头", async () => {
    for (const response of [
      htmlResponse("<html><h1>403 Forbidden</h1><p>Cloudflare</p></html>"),
      htmlResponse(denialPage, { host: "different.example.invalid" }),
      htmlResponse(denialPage.replace('id="cf-wrapper"', 'id="wrapper"')),
      htmlResponse(denialPage.replace('id="cf-error-details"', 'id="details"')),
      htmlResponse(denialPage.replace('class="cf-error-footer"', 'class="footer"')),
      htmlResponse(denialPage.replace("<h2>Access denied</h2>", "<h2>Forbidden</h2>")),
      htmlResponse(denialPage.replace("<span>1010</span>", "<span>1016</span>")),
      htmlResponse(denialPage.replace("</h1>", "</h1><h1>Error 1020</h1>")),
      htmlResponse(denialPage.replace(rayHex, "0123456789abcdef")),
      htmlResponse(denialPage.replace("<strong>" + rayHex + "</strong>", rayHex)),
      htmlResponse(denialPage.replace("<strong>" + rayHex + "</strong>", rayHex + " <strong>" + rayHex + "</strong>")),
      htmlResponse(denialPage.replace("</strong>", "</strong> Cloudflare Ray ID: 0123456789abcdef")),
      htmlResponse(denialPage.replace("<h1>Error <span>1010</span></h1>", "<!-- <h1>Error 1010</h1> -->")),
      htmlResponse(denialPage.replace("<h1>Error <span>1010</span></h1>", "<h1><script>Error 1010</script></h1>"))
    ]) {
      expect(await inspectTestPreviewDeniedResponse(response, signal)).toEqual({ kind: "unclassified", rayId });
    }
  });

  test("只检查代理的 HTML 403，按同一上限读取正文", async () => {
    expect(await inspectTestPreviewDeniedResponse(htmlResponse(denialPage.padEnd(8 * 1024)), signal))
      .toEqual({ kind: "cloudflare_edge", code: 1010, rayId });
    expect(await inspectTestPreviewDeniedResponse(htmlResponse(denialPage.padEnd(8 * 1024 + 1)), signal))
      .toEqual({ kind: "unclassified", rayId });
    expect(await inspectTestPreviewDeniedResponse(htmlResponse(denialPage, { status: 401 }), signal))
      .toEqual({ kind: "unclassified" });
    const plainText = htmlResponse(denialPage, { headers: { ...cloudflare, "content-type": "text/plain" } });
    expect(await inspectTestPreviewDeniedResponse(plainText, signal)).toEqual({ kind: "unclassified", rayId });
    expect(plainText.bodyUsed).toBe(false);
    const noProxy = htmlResponse(denialPage, { headers: { "content-type": "text/html", "cf-ray": rayId } });
    expect(await inspectTestPreviewDeniedResponse(noProxy, signal)).toEqual({ kind: "unclassified" });
    expect(noProxy.bodyUsed).toBe(false);
  });
});
