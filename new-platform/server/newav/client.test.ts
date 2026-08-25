import { describe, expect, test } from "bun:test";
import { NewavClient } from "./client";

describe("NewavClient", () => {
  test("使用独立 Bearer Token 和 /api/v1 前缀", async () => {
    let request: Request | undefined;
    const client = new NewavClient({ baseUrl: "https://newav0.com", token: "token-value", timeoutMs: 1000 }, async (input, init) => {
      request = new Request(input, init);
      return Response.json({ rows: [] });
    });
    await client.request("GET", "/admin/analytics/channels-daily", { from: "2026-08-01", to: "2026-08-02" });
    expect(request?.url).toBe("https://newav0.com/api/v1/admin/analytics/channels-daily?from=2026-08-01&to=2026-08-02");
    expect(request?.headers.get("authorization")).toBe("Bearer token-value");
  });

  test("认证失败映射为可维护错误", async () => {
    const client = new NewavClient({ baseUrl: "https://newav0.com", token: "expired", timeoutMs: 1000 }, async () => new Response(null, { status: 401 }));
    await expect(client.request("GET", "/admin/analytics/overview")).rejects.toMatchObject({ code: "NEWAV_AUTH_FAILED", statusCode: 401 });
  });
});
