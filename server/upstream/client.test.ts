import { describe, expect, test } from "bun:test";
import type { AppEnv } from "../config/env";
import { UpstreamClient, UpstreamError } from "./client";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { runWithUpstreamRequestProfile } from "./request-profile";
import { isBiV1MetricSelectionRejection } from "./bi-v1.request-isolation";

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
  UPSTREAM_CREDENTIALS_FILE: join(tmpdir(), "bi-upstream-client-test-unused.json"),
  WORKSPACE_FILE: join(tmpdir(), "bi-workspace-client-test-unused.json"),
  BI_V2_CORE_OVERVIEW_QUERY_ENABLED: false,
  BI_LOCAL_DASHBOARD_READING_ENABLED: false,
  BI_PRODUCTION_DASHBOARD_READING_ENABLED: false,
  BI_PRODUCTION_OPERATING_ASYNC_ENABLED: false,
  BI_TEST_DATA_PREVIEW_ENABLED: false,
  REQUEST_TIMEOUT_MS: 1000,
  MAX_PLATFORM_CONCURRENCY: 1
};

describe("UpstreamClient 站点用户名与Token配对", () => {
  const response = () => new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200 });
  async function withFile(run: (file: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), "bi-upstream-pair-"));
    try { await run(join(directory, "credentials.json")); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  const requestPair = (init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    return { userName: headers.get("name"), token: headers.get("x-token") };
  };

  test("候选用户名与Token仅验证不保存，不改变当前配对及缓存", () => withFile(async file => {
    const requests: Array<{ userName: string | null; token: string | null }> = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_url, init) => {
      requests.push(requestPair(init)); return response();
    });
    await client.get("/api/pair", { pid: "PH" });
    await client.verifyCredential("primary", "candidate-pair-token", "candidate-pair-user");
    await client.get("/api/pair", { pid: "PH" });
    expect(requests).toEqual([{ userName: "primary-user", token: "test-token" }, { userName: "candidate-pair-user", token: "candidate-pair-token" }]);
    expect(client.credentialStatus()[0].userName).toBe("primary-user");
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }));

  test("两站整对原子保存并重启恢复，后续只换Token沿用实际用户名", () => withFile(async file => {
    const requests: Array<{ url: string; userName: string | null; token: string | null }> = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: url.toString(), ...requestPair(init) }); return response();
    };
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, fetcher);
    await Promise.all([client.updateCredential("primary", "paired-primary-token", "paired-primary-user"),
      client.updateCredential("secondary", "paired-secondary-token", "paired-secondary-user")]);
    const persisted = JSON.parse(await readFile(file, "utf8"));
    expect(persisted.primary).toMatchObject({ userName: "paired-primary-user", token: "paired-primary-token" });
    expect(persisted.secondary).toMatchObject({ userName: "paired-secondary-user", token: "paired-secondary-token" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const restarted = new UpstreamClient({ ...env, UPSTREAM_USER_NAME: "unused-primary-user", UPSTREAM_SECONDARY_USER_NAME: "unused-secondary-user", UPSTREAM_CREDENTIALS_FILE: file }, fetcher);
    await restarted.verifyCredential("primary");
    await restarted.updateCredential("primary", "rotated-primary-token");
    await restarted.get("/api/pair", { pid: "PH" });
    await restarted.get("/api/pair", { pid: "FBI" });
    expect(requests.slice(-4).map(({ userName, token }) => ({ userName, token }))).toEqual([
      { userName: "paired-primary-user", token: "paired-primary-token" },
      { userName: "paired-primary-user", token: "rotated-primary-token" },
      { userName: "paired-primary-user", token: "rotated-primary-token" },
      { userName: "paired-secondary-user", token: "paired-secondary-token" }
    ]);
    expect(restarted.credentialStatus().map(({ site, userName, configured }) => ({ site, userName, configured }))).toEqual([
      { site: "primary", userName: "paired-primary-user", configured: true },
      { site: "secondary", userName: "paired-secondary-user", configured: true }
    ]);
    expect(JSON.stringify(restarted.credentialStatus())).not.toContain("rotated-primary-token");
    expect(restarted.isProtectedDiagnosticText("prefix-paired-primary-user-suffix")).toBe(true);
    expect(restarted.isProtectedDiagnosticText("paired-secondary-user")).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8")).primary.userName).toBe("paired-primary-user");
  }));

  test("旧token-only文件绑定原同站环境用户名，未迁移站点保持原值", () => withFile(async file => {
    const old = { primary: { token: "legacy-primary-token", updatedAt: "2026-10-19T00:00:00Z" }, secondary: { token: "legacy-secondary-token", updatedAt: "2026-10-19T00:00:00Z" } };
    await writeFile(file, JSON.stringify(old), { mode: 0o600 });
    const requests: ReturnType<typeof requestPair>[] = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_url, init) => { requests.push(requestPair(init)); return response(); });
    await client.get("/api/pair", { pid: "PH" }); await client.get("/api/pair", { pid: "FBI" });
    expect(requests).toEqual([{ userName: "primary-user", token: "legacy-primary-token" }, { userName: "secondary-user", token: "legacy-secondary-token" }]);
    await client.updateCredential("primary", "migrated-primary-token");
    const persisted = JSON.parse(await readFile(file, "utf8"));
    expect(persisted.primary).toMatchObject({ userName: "primary-user", token: "migrated-primary-token" });
    expect(persisted.secondary).toEqual(old.secondary);
  }));

  test("新配对缺失任一项时不分别借用环境凭据", () => withFile(async file => {
    for (const entry of [{ userName: "stored-user", updatedAt: "2026-10-19T00:00:00Z" }, { userName: "", token: "stored-token", updatedAt: "2026-10-19T00:00:00Z" }]) {
      await writeFile(file, JSON.stringify({ primary: entry }), { mode: 0o600 });
      let reads = 0;
      const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async () => { reads++; return response(); });
      expect(client.credentialStatus()[0]).toMatchObject({ configured: false, tokenHint: "未配置" });
      await expect(client.get("/api/pair", { pid: "PH" })).rejects.toMatchObject({ code: "UPSTREAM_NOT_CONFIGURED" });
      expect(reads).toBe(0);
    }
  }));

  test("候选账号验证失败保持上一整对、文件及缓存，成功换账号后不复用旧缓存", () => withFile(async file => {
    const requests: ReturnType<typeof requestPair>[] = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_url, init) => {
      const pair = requestPair(init); requests.push(pair);
      return pair.userName === "rejected-user" ? new Response(JSON.stringify({ code: 2002, err: "请重新登陆" }), { status: 200 }) : response();
    });
    await client.updateCredential("primary", "active-token", "active-user");
    await client.get("/api/pair", { pid: "PH" });
    const before = await readFile(file, "utf8");
    await expect(client.updateCredential("primary", "rejected-token", "rejected-user")).rejects.toMatchObject({ code: "UPSTREAM_AUTH_FAILED" });
    expect(await readFile(file, "utf8")).toBe(before);
    expect(client.credentialStatus()[0].userName).toBe("active-user");
    const count = requests.length;
    await client.get("/api/pair", { pid: "PH" });
    expect(requests).toHaveLength(count);
    await client.updateCredential("primary", "active-token", "next-user");
    await client.get("/api/pair", { pid: "PH" });
    expect(requests.at(-1)).toEqual({ userName: "next-user", token: "active-token" });
  }));

  test("同站并发更新在队列起点冻结配对，省略用户名沿用上一笔已生效配对", () => withFile(async file => {
    let acceptFirst!: (value: Response) => void, startedFirst!: () => void;
    const firstStarted = new Promise<void>(resolve => { startedFirst = resolve; });
    const requests: ReturnType<typeof requestPair>[] = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_url, init) => {
      const pair = requestPair(init); requests.push(pair);
      if (pair.token === "first-token") { startedFirst(); return new Promise<Response>(resolve => { acceptFirst = resolve; }); }
      return response();
    });
    const first = client.updateCredential("primary", "first-token", "first-user");
    await firstStarted;
    const second = client.updateCredential("primary", "second-token");
    expect(client.credentialStatus()[0].userName).toBe("primary-user");
    acceptFirst(response());
    await Promise.all([first, second]);
    expect(requests).toEqual([{ userName: "first-user", token: "first-token" }, { userName: "first-user", token: "second-token" }]);
    expect(JSON.parse(await readFile(file, "utf8")).primary).toMatchObject({ userName: "first-user", token: "second-token" });
  }));

  test("独立候选探针保留开始时的配对，晚到成功不覆盖并发保存结果", () => withFile(async file => {
    let acceptProbe!: (value: Response) => void;
    const requests: ReturnType<typeof requestPair>[] = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_url, init) => {
      const pair = requestPair(init); requests.push(pair);
      return pair.token === "probe-only-token" ? new Promise<Response>(resolve => { acceptProbe = resolve; }) : response();
    });
    const probe = client.verifyCredential("primary", "probe-only-token", "probe-only-user");
    await client.updateCredential("primary", "saved-pair-token", "saved-pair-user");
    acceptProbe(response());
    await expect(probe).resolves.toMatchObject({ site: "primary", valid: true });
    await client.get("/api/pair", { pid: "PH" });
    expect(requests).toEqual([{ userName: "probe-only-user", token: "probe-only-token" },
      { userName: "saved-pair-user", token: "saved-pair-token" }, { userName: "saved-pair-user", token: "saved-pair-token" }]);
    expect(client.credentialStatus()[0].userName).toBe("saved-pair-user");
    expect(JSON.parse(await readFile(file, "utf8")).primary).toMatchObject({ userName: "saved-pair-user", token: "saved-pair-token" });
  }));

  test("正式凭据探针固定化业务拒绝消息，反射候选Token的失败更新不保存", () => withFile(async file => {
    const reflectedToken = "fake-reflected-candidate-token", reflectedUser = "fake-reflected-user";
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_url, init) => {
      const pair = requestPair(init);
      return pair.token === reflectedToken ? new Response(JSON.stringify({ code: 400, err: `rejected ${pair.token} ${pair.userName}` }), { status: 200 }) : response();
    });
    await client.updateCredential("primary", "previous-safe-token", "previous-safe-user");
    const before = await readFile(file, "utf8");
    for (const operation of [() => client.verifyCredential("primary", reflectedToken, reflectedUser), () => client.updateCredential("primary", reflectedToken, reflectedUser)]) {
      const error = await operation().catch(error => error);
      expect(error).toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422, message: "后台拒绝凭据验证请求" });
      expect(error.message).not.toContain(reflectedToken);
      expect(error.message).not.toContain(reflectedUser);
    }
    expect(await readFile(file, "utf8")).toBe(before);
    expect(client.credentialStatus()[0]).toMatchObject({ userName: "previous-safe-user", tokenHint: "••••oken" });
    await client.get("/api/pair", { pid: "PH" });
  }));

  test("临时测试凭据探针同样固定化反射错误，普通数据请求保留原业务诊断", () => withFile(async file => {
    const reflectedToken = "fake-reflected-preview-token", message = `fixture rejection ${reflectedToken}`;
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file, BI_TEST_DATA_PREVIEW_ENABLED: true,
      UPSTREAM_TEST_API_BASE_URL: "https://preview.invalid", UPSTREAM_TEST_USER_NAME: "preview-user" }, async () =>
      new Response(JSON.stringify({ code: 400, err: message }), { status: 200 }));
    await expect(client.verifyPreviewCredential(reflectedToken)).rejects.toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422, message: "后台拒绝凭据验证请求" });
    await expect(client.get("/api/data", { pid: "PH" })).rejects.toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422, message });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }));

  test("候选用户名校验失败不发请求也不写入，测试上下文仍独立", () => withFile(async file => {
    const requests: ReturnType<typeof requestPair>[] = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_url, init) => { requests.push(requestPair(init)); return response(); });
    for (const userName of ["", "  ", "bad\nuser", "x".repeat(257)]) {
      await expect(client.updateCredential("primary", "valid-token", userName)).rejects.toMatchObject({ code: "INVALID_CREDENTIAL_INPUT" });
    }
    expect(requests).toHaveLength(0);
    await client.updateCredential("primary", "shared-token", "shared-user");
    await runWithUpstreamRequestProfile({ environment: "test", baseUrl: "https://preview.invalid", userName: "preview-user", token: "preview-token", cachePartition: "preview-pair" }, async () => {
      await client.get("/api/pair", { pid: "PH" }); await client.get("/api/pair", { pid: "FBI" });
    });
    await client.get("/api/pair", { pid: "PH" });
    expect(requests.slice(-3)).toEqual([{ userName: "preview-user", token: "preview-token" }, { userName: "preview-user", token: "preview-token" }, { userName: "shared-user", token: "shared-token" }]);
  }));
});

describe("UpstreamClient business errors", () => {
  test("取证文本检查屏蔽配置凭据与当前测试会话，不返回凭据值", async () => {
    const client = new UpstreamClient({
      ...env,
      TOKEN_MAINTENANCE_KEY: "fake-maintenance-protected-value",
      BI_AUTH_CSRF_SECRET: "fake-csrf-protected-value-000000000",
      DATABASE_URL: "postgres://fake-database-protected-value",
      BI_AUTH_DATABASE_URL: "postgres://fake-auth-database-protected-value"
    });
    for (const text of ["PH", "M016", "bi-v1", "effective_play_v3", "2026-10-12"]) {
      expect(client.isProtectedDiagnosticText(text)).toBe(false);
    }
    for (const text of ["test-token", "prefix-secondary-token-suffix", "primary-user", "https://example.com",
      "fake-maintenance-protected-value", "fake-csrf-protected-value-000000000",
      "postgres://fake-database-protected-value", "postgres://fake-auth-database-protected-value"]) {
      expect(client.isProtectedDiagnosticText(text)).toBe(true);
    }
    expect(client.isProtectedDiagnosticText("ephemeral-preview-token-7777")).toBe(false);
    await runWithUpstreamRequestProfile({
      environment: "test", baseUrl: "https://ephemeral.example.test", userName: "ephemeral-preview-user",
      token: "ephemeral-preview-token-7777", cachePartition: "ephemeral-preview-partition"
    }, async () => {
      for (const text of ["ephemeral-preview-token-7777", "ephemeral-preview-user", "ephemeral-preview-partition", "https://ephemeral.example.test"]) {
        expect(client.isProtectedDiagnosticText(text)).toBe(true);
      }
    });
    expect(client.isProtectedDiagnosticText("ephemeral-preview-token-7777")).toBe(false);
  });

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

  test("平台目录中归属站1的 PID 使用主后台", async () => {
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

  test("显式测试请求对主站和备用站 PID 使用同一临时测试凭据且请求结束后恢复正式路由", async () => {
    const requests: Array<{ url: string; headers: RequestInit["headers"] }> = [];
    const client = new UpstreamClient(env, async (input, init) => {
      requests.push({ url: input.toString(), headers: init?.headers });
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await runWithUpstreamRequestProfile({
      environment: "test",
      baseUrl: "https://test.example.com",
      token: "temporary-test-token",
      userName: "temporary-test-user",
      cachePartition: "preview-session-1"
    }, async () => {
      await client.get("/api/test", { pid: "PH" });
      await client.get("/api/test", { pid: "TJD" });
    });
    await client.get("/api/test", { pid: "PH" });

    expect(requests[0]).toMatchObject({ url: "https://test.example.com/api/test?pid=PH", headers: { "x-token": "temporary-test-token", name: "temporary-test-user" } });
    expect(requests[1]).toMatchObject({ url: "https://test.example.com/api/test?pid=TJD", headers: { "x-token": "temporary-test-token", name: "temporary-test-user" } });
    expect(requests[2]).toMatchObject({ url: "https://example.com/api/test?pid=PH", headers: { "x-token": "test-token", name: "primary-user" } });
  });

  test("正式与测试请求缓存严格分区，不会复用另一环境的返回值", async () => {
    let fetchCount = 0;
    const client = new UpstreamClient(env, async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ code: 200, msg: { fetchCount } }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await client.get("/api/test", { pid: "PH" });
    await runWithUpstreamRequestProfile({ environment: "test", baseUrl: "https://example.com", token: "test-token", userName: "primary-user", cachePartition: "preview-session-1" }, () => client.get("/api/test", { pid: "PH" }));
    await client.get("/api/test", { pid: "PH" });

    expect(fetchCount).toBe(2);
  });

  test("主数据源未配置 Token 时失败关闭且绝不发出匿名请求", async () => {
    let fetchCount = 0;
    const client = new UpstreamClient({ ...env, UPSTREAM_X_TOKEN: undefined }, async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    });

    await expect(client.get("/api/test", { pid: "PH" })).rejects.toMatchObject({
      code: "UPSTREAM_NOT_CONFIGURED",
      statusCode: 503
    });
    expect(fetchCount).toBe(0);
  });

  test("命中备用 PID 但备用路由不完整时失败关闭且不回落主后台", async () => {
    let fetchCount = 0;
    const client = new UpstreamClient({
      ...env,
      UPSTREAM_SECONDARY_API_BASE_URL: undefined,
      UPSTREAM_SECONDARY_USER_NAME: undefined,
      UPSTREAM_SECONDARY_X_TOKEN: undefined
    }, async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    });

    await expect(client.get("/api/test", { pid: "FBI" })).rejects.toMatchObject({
      code: "UPSTREAM_NOT_CONFIGURED",
      statusCode: 503
    });
    expect(fetchCount).toBe(0);
  });

  test("未知 PID 在网络请求前失败关闭且不会默认回落主后台", async () => {
    let fetchCount = 0;
    const client = new UpstreamClient(env, async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    });

    await expect(client.get("/api/test", { pid: "UNKNOWN" })).rejects.toMatchObject({
      code: "UPSTREAM_PID_NOT_AVAILABLE",
      statusCode: 422
    });
    expect(fetchCount).toBe(0);
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

  test("并发更新两个站点时串行合并凭证且不遗留临时文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bi-upstream-credentials-concurrent-"));
    const file = join(directory, "credentials.json");
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async () =>
      new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } })
    );

    try {
      await Promise.all([
        client.updateCredential("primary", "concurrent-primary-token"),
        client.updateCredential("secondary", "concurrent-secondary-token")
      ]);

      const persisted = JSON.parse(await readFile(file, "utf8")) as {
        primary?: { token: string; updatedAt: string };
        secondary?: { token: string; updatedAt: string };
      };
      expect(persisted.primary?.token).toBe("concurrent-primary-token");
      expect(persisted.secondary?.token).toBe("concurrent-secondary-token");
      expect(persisted.primary?.updatedAt).toBeString();
      expect(persisted.secondary?.updatedAt).toBeString();
      expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("候选凭证验证失败时保留原凭证且不创建临时文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bi-upstream-credentials-rejected-"));
    const file = join(directory, "credentials.json");
    const requestTokens: string[] = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_input, init) => {
      const token = String((init?.headers as Record<string, string>)["x-token"]);
      requestTokens.push(token);
      if (token === "rejected-primary-token") {
        return new Response(JSON.stringify({ code: 2002, err: "请重新登陆" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    try {
      await client.updateCredential("primary", "accepted-primary-token");
      const persistedBeforeFailure = await readFile(file, "utf8");

      await expect(client.updateCredential("primary", "rejected-primary-token")).rejects.toMatchObject({
        code: "UPSTREAM_AUTH_FAILED",
        statusCode: 401
      });
      await client.get("/api/test", { pid: "PH" });

      expect(await readFile(file, "utf8")).toBe(persistedBeforeFailure);
      expect(requestTokens.at(-1)).toBe("accepted-primary-token");
      expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("持久化失败时保留原活动凭证并清理已写入的临时文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bi-upstream-credentials-write-failure-"));
    const file = join(directory, "credentials.json");
    await mkdir(file);
    const requestTokens: string[] = [];
    const requestUserNames: string[] = [];
    const client = new UpstreamClient({ ...env, UPSTREAM_CREDENTIALS_FILE: file }, async (_input, init) => {
      requestTokens.push(String((init?.headers as Record<string, string>)["x-token"]));
      requestUserNames.push(String((init?.headers as Record<string, string>).name));
      return new Response(JSON.stringify({ code: 200, msg: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });

    try {
      await expect(client.updateCredential("primary", "unpersisted-primary-token", "unpersisted-primary-user")).rejects.toBeInstanceOf(Error);
      await client.get("/api/test", { pid: "PH" });

      expect(requestTokens).toEqual(["unpersisted-primary-token", "test-token"]);
      expect(requestUserNames).toEqual(["unpersisted-primary-user", "primary-user"]);
      expect(client.credentialStatus()[0].userName).toBe("primary-user");
      expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("UpstreamClient HTTP 参数拒绝兼容", () => {
  const metricMessage = "Unsupported metricCodes: M007";
  const jsonResponse = (payload: unknown, status: number) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  const readError = async (response: Response, path = "/api/admin/bi/v1/metrics") => {
    const client = new UpstreamClient(env, async () => response);
    try {
      await client.get(path, {});
    } catch (error) {
      return error;
    }
    throw new Error("拒绝响应必须保持失败");
  };

  for (const httpStatus of [200, 400, 422]) for (const code of [400, 422]) for (const array of [false, true]) {
    test(`HTTP ${httpStatus} / 业务 ${code} / ${array ? "字符串数组" : "字符串"}指标拒绝保留隔离依据`, async () => {
      const err = array ? [metricMessage, "请调整指标编码"] : metricMessage;
      const error = await readError(jsonResponse({ code, err }, httpStatus));
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422, message: array ? `${metricMessage}；请调整指标编码` : metricMessage });
      expect(isBiV1MetricSelectionRejection(error)).toBe(true);
    });
  }

  const invalidPayloads = [
    ["成功业务码", { code: 200, err: metricMessage }],
    ["其他业务码", { code: 500, err: metricMessage }],
    ["字符串业务码", { code: "422", err: metricMessage }],
    ["缺业务码", { err: metricMessage }],
    ["缺错误说明", { code: 422 }],
    ["空错误说明", { code: 422, err: "" }],
    ["空白错误说明", { code: 422, err: "   " }],
    ["空错误数组", { code: 400, err: [] }],
    ["空白错误数组项", { code: 400, err: [metricMessage, " "] }],
    ["混合类型错误数组", { code: 400, err: [metricMessage, 1] }],
    ["对象错误说明", { code: 422, err: { message: metricMessage } }],
    ["空响应", null]
  ] as const;
  for (const status of [400, 422]) {
    for (const [label, payload] of invalidPayloads) test(`HTTP ${status} ${label}保持HTTP失败`, async () => {
      const error = await readError(jsonResponse(payload, status));
      expect(error).toMatchObject({ code: "UPSTREAM_FAILED", statusCode: 502, message: `后台接口返回 ${status}` });
      expect(isBiV1MetricSelectionRejection(error)).toBe(false);
    });
    test(`HTTP ${status} 非JSON错误体保持HTTP失败`, async () => {
      const error = await readError(new Response("upstream rejected request", { status }));
      expect(error).toMatchObject({ code: "UPSTREAM_FAILED", statusCode: 502, message: `后台接口返回 ${status}` });
      expect(isBiV1MetricSelectionRejection(error)).toBe(false);
    });
    for (const err of ["Unsupported metricCodes: M007; permission denied", "指标查询没有权限，token无效", "endDate必须晚于startDate"]) {
      test(`HTTP ${status} ${err}保持参数失败且不触发指标隔离`, async () => {
        const error = await readError(jsonResponse({ code: 422, err }, status));
        expect(error).toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422, message: err });
        expect(isBiV1MetricSelectionRejection(error)).toBe(false);
      });
    }
    test(`HTTP ${status} 留存无当日数据说明不转为成功空结果`, async () => {
      const error = await readError(jsonResponse({ code: 400, err: "没有该平台当日数据" }, status), "/api/admin/statistics/reletionsStatPlus/getDays");
      expect(error).toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422 });
      expect(isBiV1MetricSelectionRejection(error)).toBe(false);
    });
  }

  for (const status of [200, 400, 422]) for (const ipRestricted of [false, true]) {
    test(`HTTP ${status} 业务2002保持${ipRestricted ? "IP限制" : "认证"}错误`, async () => {
      const error = await readError(jsonResponse({ code: 2002, err: ipRestricted ? "ip限制，请联系管理员" : "请重新登陆" }, status));
      expect(error).toMatchObject({ code: ipRestricted ? "UPSTREAM_IP_RESTRICTED" : "UPSTREAM_AUTH_FAILED", statusCode: ipRestricted ? 403 : 401 });
      expect(isBiV1MetricSelectionRejection(error)).toBe(false);
    });
  }

  for (const [status, code, statusCode] of [
    [401, "UPSTREAM_AUTH_FAILED", 401], [403, "UPSTREAM_AUTH_FAILED", 403],
    [429, "UPSTREAM_RATE_LIMITED", 429], [500, "UPSTREAM_FAILED", 502]
  ] as const) test(`HTTP ${status} 优先保留原错误边界`, async () => {
    const error = await readError(jsonResponse({ code: 422, err: metricMessage }, status));
    expect(error).toMatchObject({ code, statusCode });
    expect(isBiV1MetricSelectionRejection(error)).toBe(false);
  });

  test("网络错误保持来源失败且不触发指标隔离", async () => {
    const client = new UpstreamClient(env, async () => { throw new TypeError(metricMessage); });
    const error = await client.get("/api/admin/bi/v1/metrics", {}).catch(error => error);
    expect(error).toMatchObject({ code: "UPSTREAM_NETWORK_ERROR", statusCode: 502 });
    expect(isBiV1MetricSelectionRejection(error)).toBe(false);
  });
  test("请求超时保持504且不触发指标隔离", async () => {
    const client = new UpstreamClient({ ...env, REQUEST_TIMEOUT_MS: 5 }, async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("request aborted", "AbortError")), { once: true });
    }));
    const error = await client.get("/api/admin/bi/v1/metrics", {}).catch(error => error);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
    expect(isBiV1MetricSelectionRejection(error)).toBe(false);
  });
});

describe("UpstreamClient 业务码类型准入", () => {
  const path = "/api/admin/statistics/todayVideos/getMany";
  const rejectedMessage = "请检查当前用户是否正常";
  const invalidCodes = [
    ["状态枚举对象", { 0: "Unknown", 1: "Fail", 200: "OK" }],
    ["普通对象", {}],
    ["数字数组", [200]],
    ["字符串数组", ["200"]],
    ["嵌套数组", [[200]]],
    ["null", null],
    ["true", true],
    ["false", false]
  ] as const;
  const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
    status, headers: { "content-type": "application/json" }
  });

  for (const [label, code] of invalidCodes) {
    test(`HTTP200 ${label}失败关闭，不猜认证、不写入成功缓存`, async () => {
      let fetchCount = 0;
      const healthy = { code: 200, msg: { pageData: [{ value: 7 }], totalCount: 1 } };
      const client = new UpstreamClient(env, async () => jsonResponse(++fetchCount === 1
        ? { code, err: rejectedMessage, msg: { pageData: [], totalCount: 0 } }
        : healthy));

      const error = await client.get(path, {}).catch(error => error);
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).toMatchObject({ code: "UPSTREAM_FAILED", statusCode: 502, message: "后台业务状态格式无效" });
      expect(isBiV1MetricSelectionRejection(error)).toBe(false);
      expect(fetchCount).toBe(1);
      await expect(client.get(path, {})).resolves.toEqual(healthy);
      await expect(client.get(path, {})).resolves.toEqual(healthy);
      expect(fetchCount).toBe(2);
    });
  }

  for (const [label, codeFields] of [
    ["数字200", { code: 200 }],
    ["字符串200", { code: "200" }],
    ["旧接口缺少code", {}]
  ] as const) {
    test(`${label}继续返回并缓存原成功结果`, async () => {
      let fetchCount = 0;
      const payload = { ...codeFields, msg: { pageData: [], totalCount: 0 } };
      const client = new UpstreamClient(env, async () => { fetchCount++; return jsonResponse(payload); });
      await expect(client.get(path, {})).resolves.toEqual(payload);
      await expect(client.get(path, {})).resolves.toEqual(payload);
      expect(fetchCount).toBe(1);
    });
  }

  for (const code of [400, "400", 422, "422", 500, "500"]) {
    test(`HTTP200 合法标量业务拒绝${JSON.stringify(code)}保留原分类和说明`, async () => {
      const client = new UpstreamClient(env, async () => jsonResponse({ code, err: rejectedMessage }));
      const error = await client.get(path, {}).catch(error => error);
      expect(error).toMatchObject({ code: "UPSTREAM_INVALID_REQUEST", statusCode: 422, message: rejectedMessage });
      expect(isBiV1MetricSelectionRejection(error)).toBe(false);
    });
  }

  for (const code of [[200], null]) {
    test(`畸形业务码${JSON.stringify(code)}不能进入留存空结果兼容`, async () => {
      const client = new UpstreamClient(env, async () => jsonResponse({ code, err: "没有该平台当日数据" }));
      await expect(client.get("/api/admin/statistics/reletionsStatPlus/getDays", {}))
        .rejects.toMatchObject({ code: "UPSTREAM_FAILED", statusCode: 502 });
    });
  }

  test("畸形成功码不能通过凭据探针", async () => {
    const client = new UpstreamClient(env, async () => jsonResponse({ code: [200], err: rejectedMessage, msg: {} }));
    await expect(client.verifyCredential("primary"))
      .rejects.toMatchObject({ code: "UPSTREAM_FAILED", statusCode: 502, message: "后台业务状态格式无效" });
  });
});
