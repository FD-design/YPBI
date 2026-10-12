import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const baseUrl = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const subjectId = "00000000-0000-4000-8000-000000000001";
const metricDefinitions = JSON.parse(readFileSync(new URL("./server/v2/generated/metric-definitions.json", import.meta.url), "utf8"));
const session = { success: true, data: {
  user: { subjectId, username: "qa.environment", displayName: "环境验收账号", role: "reader", permissions: ["bi:read"], pidScope: "all" },
  expiresAt: "2099-01-01T00:00:00Z", mustChangePassword: false, csrfToken: "a".repeat(43)
} };
const production = { success: true, data: { mode: "production", testAvailable: true, expiresAt: null, userName: null } };

test.use({ viewport: { width: 1280, height: 800 }, channel: "chrome" });

for (const outcome of ["success", "error"] as const) test(`切回正式后旧测试检查${outcome}响应不改写当前环境与后续请求`, async ({ page }) => {
  await page.addInitScript(({ subjectId }) => {
    sessionStorage.setItem(`ypbi.data-environment.v1:${subjectId}`, "test");
  }, { subjectId });
  let releaseOld!: () => void;
  const held = new Promise<void>(resolve => { releaseOld = resolve; });
  let environmentChecks = 0;
  let initialEnvironment: string | undefined;
  const catalogEnvironments: Array<string | undefined> = [];
  await page.route("**/api/bi/v2/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/session")) return route.fulfill({ status: 200, json: session });
    if (path.endsWith("/catalog/metric-definitions")) {
      catalogEnvironments.push(route.request().headers()["x-ypbi-data-environment"]);
      return route.fulfill({ status: 200, json: { success: true, data: metricDefinitions } });
    }
    if (path.endsWith("/data-environment")) {
      if (environmentChecks++ > 0) return route.fulfill({ status: 200, json: production });
      initialEnvironment = route.request().headers()["x-ypbi-data-environment"];
      await held;
      return route.fulfill(outcome === "success" ? {
        status: 200, json: { success: true, data: { mode: "test", testAvailable: true, expiresAt: "2099-01-01T00:00:00Z", userName: "old-in-memory-session" } }
      } : {
        status: 403, json: { success: false, error: { code: "DATA_PREVIEW_SESSION_REQUIRED", message: "旧测试会话已失效", requestId: "old-in-memory-check" } }
      });
    }
    return route.fulfill({ status: 404, json: { success: false, error: { code: "NOT_FOUND", message: "内存测试未配置此读取", requestId: "in-memory" } } });
  });

  try {
    await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => initialEnvironment).toBe("test");
    await expect(page.locator("#metric-open-M016")).toBeVisible();
    expect(catalogEnvironments).toEqual(["test"]);
    const environment = page.locator(".v2-data-environment");
    await expect(environment.getByText("测试数据", { exact: true })).toBeVisible();
    const beforeSwitch = catalogEnvironments.length;
    await environment.getByRole("button", { name: "切回正式", exact: true }).click();
    await expect(environment.getByText("正式数据", { exact: true })).toBeVisible();
    await expect.poll(() => catalogEnvironments.length).toBeGreaterThan(beforeSwitch);
    expect(catalogEnvironments.slice(beforeSwitch)).toEqual(["production"]);
    await expect(page.locator("#metric-open-M016")).toBeVisible();

    const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/bi/v2/data-environment");
    releaseOld();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(environment.getByText("正式数据", { exact: true })).toBeVisible();
    await expect(environment.getByRole("button", { name: "切回正式", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "登录 YPBI", exact: true })).toHaveCount(0);
    expect(await page.evaluate(subjectId => sessionStorage.getItem(`ypbi.data-environment.v1:${subjectId}`), subjectId)).toBeNull();

    const beforeRefresh = catalogEnvironments.length;
    await page.getByRole("button", { name: "刷新指标目录", exact: true }).click();
    await expect.poll(() => catalogEnvironments.length).toBeGreaterThan(beforeRefresh);
    expect(catalogEnvironments.slice(beforeRefresh)).toEqual(["production"]);
    await expect(page.locator("#metric-open-M016")).toBeVisible();
    await expect(environment.getByText("正式数据", { exact: true })).toBeVisible();
    if (outcome === "success") await page.screenshot({ path: "/private/tmp/ypbi-environment-lifecycle-1280.png" });
  } finally {
    releaseOld();
  }
});
