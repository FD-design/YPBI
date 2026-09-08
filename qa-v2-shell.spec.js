import { expect, test } from "@playwright/test";

const baseUrl = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";

test.use({
  viewport: { width: 1280, height: 800 },
  channel: "chrome"
});

function authenticatedSession(role = "maintainer", mustChangePassword = false, csrfToken = "c".repeat(43)) {
  return {
    success: true,
    data: {
      user: {
        subjectId: "00000000-0000-4000-8000-000000000001",
        username: "qa.user",
        displayName: "QA 用户",
        role,
        permissions: role === "maintainer"
          ? ["bi:read", "bi:data-source-maintenance:enter"]
          : ["bi:read"],
        pidScope: "all"
      },
      expiresAt: "2099-09-08T00:00:00.000Z",
      mustChangePassword,
      csrfToken
    }
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(authenticatedSession())
  }));
});

// These route fixtures exist only in browser QA. Production V2 code always calls
// the real read-only /api/bi/v2 endpoints and never imports data from this file.
const metric = {
  id: "M016",
  code: "daily_active_user_count",
  name: "日活跃用户数",
  definition: "当天打开并登录产品的去重用户数",
  unit: "人",
  valueType: "integer",
  authority: {
    document: "全站指标体系.md",
    version: "v0.23-draft",
    validationStatus: "pending_validation",
    statusLabel: "技术称已实现（待验数）"
  },
  capabilities: {
    grains: ["day"],
    platformMode: "single_pid",
    dimensions: [],
    filters: [],
    comparisons: []
  }
};

function enumerateBusinessDates(dateRange) {
  const businessDates = [];
  const cursor = new Date(`${dateRange[0]}T00:00:00Z`);
  const end = new Date(`${dateRange[1]}T00:00:00Z`);
  while (cursor <= end) {
    businessDates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return businessDates;
}

async function installCatalogFixtures(page) {
  await page.route("**/api/bi/v2/catalog/metrics", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, data: { items: [metric] } })
  }));
  await page.route("**/api/bi/v2/catalog/platforms", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, data: { items: [{ id: "HX-001", pid: "PH", name: "Pornhub", order: 1 }] } })
  }));
}

async function installSuccessfulReadFixtures(page, onQuery = () => {}) {
  await installCatalogFixtures(page);
  await page.route("**/api/bi/v2/queries/metrics", async (route) => {
    const request = route.request().postDataJSON();
    onQuery(request);
    const businessDates = enumerateBusinessDates(request.dateRange);
    const unavailableDate = businessDates.at(-1);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          metric,
          scope: { pid: request.pid, platformName: "Pornhub" },
          grain: "day",
          dateRange: request.dateRange,
          seriesStatus: "partial",
          points: businessDates.slice(0, -1).map((businessDate, index) => ({
            businessDate,
            value: index === 0 ? 0 : 100 + index,
            state: "available"
          })),
          unavailableDates: [{ businessDate: unavailableDate, state: "no_record" }]
        },
        meta: {
          queryId: "query-qa-success",
          sourceApiIds: ["P_DAY_SUM"],
          fetchedAt: "2026-09-08T00:00:00.000Z",
          validationStatus: "pending_validation",
          watermark: null,
          warnings: ["QA fixture：验证真实 0 与缺失状态不会混淆。"]
        }
      })
    });
  });
}

test("1280 指标切片展示真实 0、无记录、图表和完整表，并保持 URL 历史", async ({ page }) => {
  const queries = [];
  await installSuccessfulReadFixtures(page, (query) => queries.push(query));

  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: /日活跃用户数/ })).toBeVisible();

  await page.getByRole("link", { name: "进入分析" }).click();
  await expect(page.getByRole("heading", { name: "日活跃用户数", exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("pid")).toBe("PH");
  await expect.poll(() => new URL(page.url()).searchParams.has("start")).toBe(true);
  await expect.poll(() => new URL(page.url()).searchParams.has("end")).toBe(true);
  expect(queries).toHaveLength(1);

  await expect(page.locator(".v2-result-surface .chart")).toHaveAttribute("role", "img");
  await expect(page.locator(".v2-result-surface canvas")).toBeVisible();
  const table = page.locator(".v2-result-table");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(7);
  await expect(table.getByRole("cell", { name: "0", exact: true })).toBeVisible();
  await expect(table.getByText("无记录", { exact: true })).toBeVisible();
  await expect(page.getByText(/Asia\/Shanghai/).first()).toBeVisible();
  await page.screenshot({ path: "/private/tmp/ypbi-v2-desktop-success.png", fullPage: true });

  const canonicalUrl = page.url();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(canonicalUrl);
  await expect(page.getByRole("heading", { name: "日活跃用户数", exact: true })).toBeVisible();
  expect(queries).toHaveLength(2);

  await page.goBack();
  await expect(page).toHaveURL(`${baseUrl}/data/metrics`);
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(canonicalUrl);
  await expect(page.locator(".v2-result-table")).toBeVisible();
});

test("1024 有记录但全无值时保留逐日状态，不画图也不补 0", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installCatalogFixtures(page);
  await page.route("**/api/bi/v2/queries/metrics", async (route) => {
    const request = route.request().postDataJSON();
    const businessDates = enumerateBusinessDates(request.dateRange);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          metric,
          scope: { pid: request.pid, platformName: "Pornhub" },
          grain: request.grain,
          dateRange: request.dateRange,
          seriesStatus: "no_values",
          points: [],
          unavailableDates: businessDates.map((businessDate, index) => ({
            businessDate,
            state: index === 0 ? "no_value" : "no_record"
          }))
        },
        meta: {
          queryId: "query-qa-no-values",
          sourceApiIds: ["P_DAY_SUM"],
          fetchedAt: "2026-09-08T00:00:00.000Z",
          validationStatus: "pending_validation",
          watermark: null,
          warnings: ["QA fixture：有记录但指标值为空。"]
        }
      })
    });
  });

  await page.goto(`${baseUrl}/analysis/metrics/M016`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "有记录但无可用值" })).toBeVisible();
  await expect(page.locator(".v2-result-surface")).toHaveCount(0);
  await expect(page.locator(".v2-result-table tbody tr")).toHaveCount(7);
  await expect(page.locator(".v2-result-table tbody td.is-number")).toHaveText(["—", "—", "—", "—", "—", "—", "—"]);
  await expect(page.getByText("无值", { exact: true })).toBeVisible();
  await expect(page.getByText("无记录", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: "/private/tmp/ypbi-v2-no-values-1024.png", fullPage: true });
});

test("查询回显与原请求不一致时拒绝结果并展示稳定错误码", async ({ page }) => {
  await installCatalogFixtures(page);
  await page.route("**/api/bi/v2/queries/metrics", async (route) => {
    const request = route.request().postDataJSON();
    const businessDates = enumerateBusinessDates(request.dateRange);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          metric,
          scope: { pid: "XH", platformName: "错误回显平台" },
          grain: request.grain,
          dateRange: request.dateRange,
          seriesStatus: "available",
          points: businessDates.map((businessDate, index) => ({ businessDate, value: index, state: "available" })),
          unavailableDates: []
        },
        meta: {
          queryId: "query-qa-echo-conflict",
          sourceApiIds: ["P_DAY_SUM"],
          fetchedAt: "2026-09-08T00:00:00.000Z",
          validationStatus: "pending_validation",
          watermark: null,
          warnings: ["QA fixture：服务端回显 PID 与请求不一致。"]
        }
      })
    });
  });

  await page.goto(`${baseUrl}/analysis/metrics/M016`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("错误代码：INVALID_V2_QUERY_RESPONSE")).toBeVisible();
  await expect(page.locator(".v2-result-surface")).toHaveCount(0);
  await expect(page.locator(".v2-result-table")).toHaveCount(0);
});

test("503 身份来源不可用时失败关闭并显示请求 ID", async ({ page }) => {
  await page.route("**/api/bi/v2/catalog/metrics", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({
      success: false,
      error: {
        code: "IDENTITY_PROVIDER_UNAVAILABLE",
        message: "正式身份来源当前不可用",
        requestId: "req-qa-503"
      }
    })
  }));

  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "身份能力暂不可用" })).toBeVisible();
  await expect(page.getByText("错误代码：IDENTITY_PROVIDER_UNAVAILABLE")).toBeVisible();
  await expect(page.getByText("请求 ID：req-qa-503")).toBeVisible();
  await expect(page.locator(".v2-table-surface")).toHaveCount(0);
  await page.screenshot({ path: "/private/tmp/ypbi-v2-identity-unavailable.png", fullPage: false });
});

test("390 移动导航使用 modal dialog、恢复焦点且不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSuccessfulReadFixtures(page);
  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toBeVisible();
  await expect(page.locator(".v2-table-surface")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole("link", { name: "进入分析" }).click();
  await expect(page.getByRole("heading", { name: "日活跃用户数", exact: true })).toBeVisible();
  await expect(page.locator(".v2-result-table")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 220));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(220);
  await expect.poll(async () => (await page.locator(".v2-topbar").boundingBox())?.y ?? -1).toBe(0);

  const navigation = page.locator("#v2-primary-navigation");
  await expect(navigation).toHaveAttribute("aria-hidden", "true");
  await expect(navigation).toHaveAttribute("inert", "");
  const openButton = page.getByRole("button", { name: "打开主导航" });
  await openButton.click();

  const dialog = page.getByRole("dialog", { name: "产品导航" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("button", { name: "关闭主导航" })).toBeFocused();
  expect(await page.evaluate(() => document.body.dataset.scrollLocked)).toBe("true");
  await expect.poll(async () => (await dialog.boundingBox())?.x).toBe(0);
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(290);
  await page.screenshot({ path: "/private/tmp/ypbi-v2-mobile-navigation.png", fullPage: false });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(openButton).toBeFocused();
  expect(await page.evaluate(() => document.body.dataset.scrollLocked)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
