import { describe, expect, test } from "bun:test";
import { productionDataPreviewDefaults } from "../config/production-data-preview";
import { readDefaultTestPreviewWireCheck, testPreviewCredentialProbeUrl } from "./test-preview-wire-check";

const userName = "fixture-test-user";
const userAgent = "YPBI-Test-Preview/1.0";
const rayId = "abcdef0123456789-SIN";
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

describe("测试预览请求头对照", () => {
  test("使用北京时间上一完整业务日构造与凭据探针相同的留存地址", () => {
    const before = testPreviewCredentialProbeUrl(productionDataPreviewDefaults.baseUrl, "PH", Date.parse("2026-11-12T15:59:59Z"));
    const after = testPreviewCredentialProbeUrl(productionDataPreviewDefaults.baseUrl, "FBI", Date.parse("2026-11-12T16:00:00Z"));
    expect(before.origin).toBe(productionDataPreviewDefaults.baseUrl);
    expect(before.pathname).toBe("/api/admin/statistics/reletionsStatPlus/getDays");
    expect(Object.fromEntries(before.searchParams)).toEqual({
      pid: "PH", registerDate: "2026-11-11 00:00:00", registerEdDate: "2026-11-11 23:59:59"
    });
    expect(Object.fromEntries(after.searchParams)).toEqual({
      pid: "FBI", registerDate: "2026-11-12 00:00:00", registerEdDate: "2026-11-12 23:59:59"
    });
  });

  test("两组顺序发起同一个 GET，差异限于显式服务标识和 Accept", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let finishLegacy!: (response: Response) => void;
    const legacyResponse = new Promise<Response>(resolve => { finishLegacy = resolve; });
    const pending = readDefaultTestPreviewWireCheck(async (input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) return legacyResponse;
      return new Response("<html>Forbidden</html>", {
        status: 403, headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": rayId }
      });
    }, userName, userAgent);
    expect(calls).toHaveLength(1);
    finishLegacy(json({ code: 2002, err: ["secret-shaped fixture response"] }));
    const result = await pending;
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(calls[1].url);
    expect(new URL(calls[0].url).searchParams.get("pid")).toBe("PH");
    const legacyHeaders = Object.fromEntries(new Headers(calls[0].init?.headers));
    const currentHeaders = Object.fromEntries(new Headers(calls[1].init?.headers));
    expect(legacyHeaders).toEqual({ "x-token": "ypbi-wire-check-invalid-fixture-v1", name: userName });
    expect(currentHeaders).toEqual({ ...legacyHeaders, "user-agent": userAgent, accept: "application/json" });
    for (const { init } of calls) {
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      expect(init?.body).toBeUndefined();
      expect(init).not.toHaveProperty("proxy");
    }
    expect(result).toEqual({
      bunVersion: process.versions.bun,
      proxyEnvironment: { http: expect.any(Boolean), https: expect.any(Boolean), all: expect.any(Boolean), noProxy: expect.any(Boolean) },
      legacy: { outcome: "response", httpStatus: 200, responseFormat: "json", businessCode: 2002, denialKind: "upstream_auth" },
      current: { outcome: "response", httpStatus: 403, responseFormat: "html", denialKind: "unclassified", cloudflareRayId: rayId }
    });
  });

  test("Bun 仅报告非空的代理变量，诊断不会返回配置值", () => {
    const checkInSubprocess = `
      import { readDefaultTestPreviewWireCheck } from ${JSON.stringify(import.meta.resolve("./test-preview-wire-check.ts"))};
      const result = await readDefaultTestPreviewWireCheck(async () => Response.json(null), "fixture-user", "fixture-agent");
      console.log(JSON.stringify(result.proxyEnvironment));
    `;
    for (const { env, expected } of [
      {
        env: {},
        expected: { http: false, https: false, all: false, noProxy: false }
      },
      {
        env: { HTTP_PROXY: "", https_proxy: "http://fixture.invalid:3128", all_proxy: "", NO_PROXY: "fixture.invalid" },
        expected: { http: false, https: true, all: false, noProxy: true }
      },
      {
        env: { http_proxy: "http://fixture.invalid:3128", HTTPS_PROXY: "", ALL_PROXY: "http://fixture.invalid:3128", no_proxy: "" },
        expected: { http: true, https: false, all: true, noProxy: false }
      }
    ]) {
      const child = Bun.spawnSync({ cmd: [process.execPath, "--no-env-file", "-e", checkInSubprocess], env });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual(expected);
    }
  });

  test("校验固定业务码和 Cloudflare 拒绝，并且不返回任意正文或标头", async () => {
    let call = 0;
    const result = await readDefaultTestPreviewWireCheck(async () => {
      if (call++ === 0) return json({ code: "2002", err: "fixture", detail: "ignored" }, 401);
      return new Response("ignored", {
        status: 403,
        headers: { "content-type": "text/plain", server: "cloudflare", "cf-ray": rayId, "cf-error-type": "1020" }
      });
    }, userName, userAgent);
    expect(result.legacy).toEqual({
      outcome: "response", httpStatus: 401, responseFormat: "json", businessCode: 2002, denialKind: "upstream_auth"
    });
    expect(result.current).toEqual({
      outcome: "response", httpStatus: 403, responseFormat: "other", denialKind: "cloudflare_edge",
      cloudflareErrorCode: 1020, cloudflareRayId: rayId
    });
    const ipRestricted = await readDefaultTestPreviewWireCheck(
      async () => json({ code: 2002, err: ["fixture", "IP 限制"] }), userName, userAgent
    );
    expect(ipRestricted.current).toEqual({
      outcome: "response", httpStatus: 200, responseFormat: "json", businessCode: 2002, denialKind: "upstream_ip_restricted"
    });
    for (const body of [
      { code: 2002 }, { code: "02002", err: "fixture" }, { code: 2002, err: [null] },
      { code: 2002, err: "   " }, { code: 2002, err: "fixture", cloudflare_error: true }
    ]) {
      const result = await readDefaultTestPreviewWireCheck(async () => json(body), userName, userAgent);
      expect(result.legacy).toEqual({ outcome: "response", httpStatus: 200, responseFormat: "json" });
    }
  });

  test("识别 Nginx 标准 403 页，只输出模板标记并保留拒绝来源未确认", async () => {
    const page = [
      "<html>", "<head><title>403 Forbidden</title></head>", "<body>",
      "<center><h1>403 Forbidden</h1></center>", "<hr><center>nginx/1.28.0</center>",
      "</body>", "</html>", "<!-- a padding to disable MSIE and Chrome friendly error page -->"
    ].join("\r\n");
    const headers = { "content-type": "text/html", server: "cloudflare", "cf-ray": rayId };
    let count = 0;
    const result = await readDefaultTestPreviewWireCheck(async () => new Response(
      count++ === 0 ? page : page.replace("nginx/1.28.0", "nginx private fixture"), { status: 403, headers }
    ), userName, userAgent);
    const expected = { outcome: "response", httpStatus: 403, responseFormat: "html", denialKind: "unclassified", cloudflareRayId: rayId } as const;
    expect(result.legacy).toEqual({ ...expected, denialTemplate: "nginx_default_403" });
    expect(result.current).toEqual(expected);
  });

  test("超出 8 KiB 的响应立即取消，只保留已收到的响应状态和格式", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ code: 2002, err: "fixture" }).padEnd(8191)));
        controller.enqueue(encoder.encode("字"));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      }
    });
    let call = 0;
    const result = await readDefaultTestPreviewWireCheck(async () =>
      call++ === 0 ? new Response(stream, { headers: jsonHeaders }) : json(null), userName, userAgent);
    expect(result.legacy).toEqual({ outcome: "response", httpStatus: 200, responseFormat: "json" });
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  test("网络异常与跨域响应仅返回固定结果", async () => {
    const result = await readDefaultTestPreviewWireCheck(async (input, init) => {
      if (!new Headers(init?.headers).has("user-agent")) throw new Error("private fixture");
      const response = json({ code: 2002, err: "fixture" });
      Object.defineProperty(response, "url", { value: "https://example.invalid/elsewhere" });
      return response;
    }, userName, userAgent);
    expect(result.legacy).toEqual({ outcome: "network" });
    expect(result.current).toEqual({ outcome: "network" });
  });

  test("单组头部和正文超时均终止，并继续完成另一组对照", async () => {
    let headerSignal: RequestInit["signal"];
    let bodySignal: RequestInit["signal"];
    let cancelled = false;
    const stalledBody = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); },
      cancel() { cancelled = true; }
    });
    const [headerTimeout, bodyTimeout] = await Promise.all([
      readDefaultTestPreviewWireCheck(async (_input, init) => {
        if (new Headers(init?.headers).has("user-agent")) return json({ code: 2002, err: "fixture" });
        headerSignal = init?.signal;
        return new Promise<Response>(() => {});
      }, userName, userAgent),
      readDefaultTestPreviewWireCheck(async (_input, init) => {
        if (new Headers(init?.headers).has("user-agent")) return json({ code: 2002, err: "fixture" });
        bodySignal = init?.signal;
        return new Response(stalledBody, { headers: jsonHeaders });
      }, userName, userAgent)
    ]);
    expect(headerTimeout.legacy).toEqual({ outcome: "timeout" });
    expect(bodyTimeout.legacy).toEqual({ outcome: "timeout", httpStatus: 200, responseFormat: "json" });
    expect(headerTimeout.current.businessCode).toBe(2002);
    expect(bodyTimeout.current.businessCode).toBe(2002);
    expect(headerSignal?.aborted).toBe(true);
    expect(bodySignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(stalledBody.locked).toBe(false);
  }, 4500);
});
