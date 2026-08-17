import { describe, expect, test } from "bun:test";
import type { AppEnv } from "../config/env";
import { UpstreamClient, UpstreamError } from "./client";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlink } from "node:fs/promises";

const env: AppEnv = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3000,
  UPSTREAM_API_BASE_URL: "https://example.com",
  UPSTREAM_X_TOKEN: "test-token",
  UPSTREAM_USER_NAME: "primary-user",
  UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.com",
  UPSTREAM_SECONDARY_X_TOKEN: "secondary-token",
  UPSTREAM_SECONDARY_USER_NAME: "secondary-user",
  UPSTREAM_SECONDARY_PIDS: "FBI,TJD",
  UPSTREAM_CREDENTIALS_FILE: join(tmpdir(), "bi-upstream-client-test-unused.json"),
  WORKSPACE_FILE: join(tmpdir(), "bi-workspace-client-test-unused.json"),
  REQUEST_TIMEOUT_MS: 1000,
  MAX_PLATFORM_CONCURRENCY: 1
};

describe("UpstreamClient business errors", () => {
  test("按 PID 选择备用后台及其匹配凭证", async () => {
    let requestUrl = "";
    let requestHeaders: RequestInit["headers"];
    const client = new UpstreamClient(env, async (input, init) => {
      requestUrl = input.toString();
      requestHeaders = init?.headers;
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await client.get("/api/test", { pid: "TJD" });

    expect(requestUrl).toStartWith("https://secondary.example.com/api/test");
    expect(requestHeaders).toEqual({ "x-token": "secondary-token", name: "secondary-user" });
  });

  test("未列入备用平台的 PID 继续使用主后台", async () => {
    let requestUrl = "";
    let requestHeaders: RequestInit["headers"];
    const client = new UpstreamClient(env, async (input, init) => {
      requestUrl = input.toString();
      requestHeaders = init?.headers;
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await client.get("/api/test", { pid: "PH" });

    expect(requestUrl).toStartWith("https://example.com/api/test");
    expect(requestHeaders).toEqual({ "x-token": "test-token", name: "primary-user" });
  });

  test("将重新登录业务码映射为认证失败", async () => {
    const client = new UpstreamClient(env, async () => new Response(JSON.stringify({ code: 2002, err: "请重新登陆" }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.get("/api/test", {})).rejects.toMatchObject({ code: "UPSTREAM_AUTH_FAILED", statusCode: 401 });
  });

  test("将 IP 限制业务码映射为明确错误", async () => {
    const client = new UpstreamClient(env, async () => new Response(JSON.stringify({ code: 2002, err: "ip限制，请联系管理员" }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.get("/api/test", {})).rejects.toMatchObject({ code: "UPSTREAM_IP_RESTRICTED", statusCode: 403 });
  });

  test("将上游业务参数错误映射为 422 而不是内部 500", async () => {
    const client = new UpstreamClient(env, async () => new Response(JSON.stringify({ code: 400, err: ["请选择完整实验条件"] }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.get("/api/test", {})).rejects.toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422 });
  });

  test("留存接口无当日数据时归一化为空结果", async () => {
    const client = new UpstreamClient(env, async () => new Response(JSON.stringify({ code: 400, err: "没有该平台当日数据" }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.get("/api/admin/statistics/reletionsStatPlus/getDays", {})).resolves.toEqual({ code: 200, data: [] });
  });

  test("新 Token 验证成功后即时用于后续请求且状态不回显原文", async () => {
    const file = join(tmpdir(), `bi-upstream-credentials-${Date.now()}.json`);
    const requestTokens: string[] = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_input, init) => {
      requestTokens.push(String((init?.headers as Record<string, string>)["x-token"]));
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const status = await client.updateCredential("primary", "new-primary-token-1234");
    await client.get("/api/test", { pid: "PH" });

    expect(requestTokens).toEqual(["new-primary-token-1234", "new-primary-token-1234"]);
    expect(status.tokenHint).toBe("••••1234");
    expect(JSON.stringify(status)).not.toContain("new-primary-token");
    await unlink(file).catch(() => undefined);
  });
});
