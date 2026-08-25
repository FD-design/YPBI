import { afterEach, describe, expect, test } from "bun:test";
import type { PlatformEnv } from "./config";
import { buildApp } from "./app";

const testEnv: PlatformEnv = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3100,
  NEWAV_API_BASE_URL: "https://newav0.com",
  NEWAV_ACCESS_TOKEN: undefined,
  REQUEST_TIMEOUT_MS: 5_000
};

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("new platform API", () => {
  test("产品目录只暴露独立的 NewAV 产品", async () => {
    const app = await buildApp(testEnv);
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/products" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((product: { id: string }) => product.id)).toEqual(["newav"]);
  });

  test("缺少 NewAV Token 时查询返回可维护错误", async () => {
    const app = await buildApp(testEnv);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: { productId: "newav", datasetId: "overview", dateRange: ["2026-08-01", "2026-08-07"] }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ success: false, error: { code: "NEWAV_NOT_CONFIGURED" } });
  });

  test("拒绝倒置的日期区间", async () => {
    const app = await buildApp(testEnv);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: { productId: "newav", datasetId: "overview", dateRange: ["2026-08-07", "2026-08-01"] }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: { code: "INVALID_QUERY" } });
  });
});
