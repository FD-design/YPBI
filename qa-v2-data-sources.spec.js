import { expect, test } from "@playwright/test";

const baseUrl = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const fakePassword = "fake-maintenance-password";
const fakeCandidate = "fake-candidate-token-0002";

test.use({
  viewport: { width: 1280, height: 800 },
  channel: "chrome"
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      success: true,
      data: {
        user: {
          subjectId: "00000000-0000-4000-8000-000000000001",
          username: "qa.maintainer",
          displayName: "QA 维护者",
          role: "maintainer",
          permissions: ["bi:read", "bi:data-source-maintenance:enter"],
          pidScope: "all"
        },
        expiresAt: "2099-09-08T00:00:00.000Z",
        mustChangePassword: false,
        csrfToken: "c".repeat(43)
      }
    })
  }));
  await page.route("**/api/bi/v2/data-environment", (route) => {
    const requestedMode = route.request().headers()["x-ypbi-data-environment"];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: requestedMode === "test"
          ? { mode: "test", testAvailable: true, userName: "fake-test-user", expiresAt: "2099-09-08T01:30:00.000Z" }
          : { mode: "production", testAvailable: true }
      })
    });
  });
});

function sourceStatuses(primaryHint = "••••0001") {
  return [
    { site: "primary", configured: true, tokenHint: primaryHint, updatedAt: null, userName: "fake-primary-user" },
    { site: "secondary", configured: true, tokenHint: "••••0004", updatedAt: "2026-09-08T00:00:00.000Z", userName: "fake-secondary-user" }
  ];
}

async function installMaintenanceFixtures(page, options = {}) {
  let authorized = options.authorized ?? false;
  let previewActive = options.previewActive ?? false;
  let rejectNextActionWith401 = false;
  let loginAttempts = 0;
  const requests = [];
  await page.route("**/api/bi/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON?.() ?? undefined;
    requests.push({ method: request.method(), pathname: url.pathname, body });

    if (url.pathname.endsWith("/auth/login")) {
      loginAttempts += 1;
      if (options.insecureLogin) {
        return route.fulfill({ status: 426, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "HTTPS_REQUIRED", message: "Token 维护仅允许通过 HTTPS 使用" } }) });
      }
      if (options.lockFirstLogin && loginAttempts === 1) {
        return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "MAINTENANCE_LOCKED", message: "验证失败次数过多，请稍后重试" } }) });
      }
      authorized = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { expiresAt: "2026-09-08T01:30:00.000Z" } })
      });
    }
    if (url.pathname.endsWith("/auth/logout")) {
      if (options.failLogout) return route.abort("failed");
      authorized = false;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { loggedOut: true } }) });
    }
    if (options.disabled && url.pathname.endsWith("/data-sources/status")) {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "MAINTENANCE_DISABLED", message: "数据源维护功能尚未启用" } }) });
    }
    if (!authorized || rejectNextActionWith401) {
      rejectNextActionWith401 = false;
      return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "MAINTENANCE_LOGIN_REQUIRED", message: "维护登录已失效，请重新登录" } }) });
    }
    if (url.pathname.endsWith("/data-sources/status")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sourceStatuses() }) });
    }
    if (url.pathname.endsWith("/data-preview/status")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            enabled: options.previewEnabled ?? true,
            active: previewActive,
            userName: (options.previewEnabled ?? true) ? "fake-test-user" : null,
            expiresAt: previewActive ? "2099-09-08T01:30:00.000Z" : null
          }
        })
      });
    }
    if (url.pathname.endsWith("/data-preview/activate")) {
      previewActive = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { mode: "test", userName: "fake-test-user", expiresAt: "2099-09-08T01:30:00.000Z", checkedAt: "2026-09-08T01:00:00.000Z" } })
      });
    }
    if (url.pathname.endsWith("/data-preview/deactivate")) {
      previewActive = false;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { mode: "production" } }) });
    }
    if (url.pathname.endsWith("/data-sources/test")) {
      if (options.proxyMisconfiguredOnAction) {
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "MAINTENANCE_PROXY_MISCONFIGURED", message: "数据源维护代理配置不完整" } }) });
      }
      if (options.disableOnAction) {
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "MAINTENANCE_DISABLED", message: "数据源维护功能尚未启用" } }) });
      }
      if (options.upstreamRateLimited) {
        return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "UPSTREAM_RATE_LIMITED", message: "后台接口请求过于频繁" } }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { site: body.site, valid: true, checkedAt: "2026-09-08T01:00:00.000Z" } }) });
    }
    if (url.pathname.endsWith("/data-sources/token")) {
      if (options.unknownSave) return route.abort("failed");
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { ...sourceStatuses("••••0002")[0], updatedAt: "2026-09-08T01:01:00.000Z" } }) });
    }
    return route.abort();
  });
  return {
    requests,
    expireOnNextAction() { rejectNextActionWith401 = true; }
  };
}

test("临时测试 Token 只创建当前会话并可明确切回正式数据", async ({ page }) => {
  const fixture = await installMaintenanceFixtures(page, { authorized: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });

  const preview = page.getByRole("region", { name: "临时测试数据" });
  const input = preview.getByLabel("测试 Token");
  await input.fill("fake-preview-token-0001");
  await preview.getByRole("button", { name: "验证并进入测试数据" }).click();

  await expect(preview.getByText("测试模式中", { exact: true })).toBeVisible();
  await expect(preview.getByText("测试数据", { exact: true })).toBeVisible();
  await expect(page.locator(".v2-data-environment").getByText("测试数据", { exact: true })).toBeVisible();
  await expect(input).toHaveCount(0);
  const activation = fixture.requests.find((item) => item.pathname.endsWith("/data-preview/activate"));
  expect(activation.body).toEqual({ token: "fake-preview-token-0001" });
  const storedValues = await page.evaluate(() => ({
    local: Object.values(localStorage),
    session: Object.values(sessionStorage)
  }));
  expect(storedValues.local.some((value) => value.includes("fake-preview-token-0001"))).toBe(false);
  expect(storedValues.session.some((value) => value.includes("fake-preview-token-0001"))).toBe(false);

  await preview.getByRole("button", { name: "结束测试会话" }).click();
  await expect(preview.getByText("未启用", { exact: true })).toBeVisible();
  await expect(preview.getByText("正式数据", { exact: true })).toBeVisible();
  expect(fixture.requests.filter((item) => item.pathname.endsWith("/data-preview/deactivate"))).toHaveLength(1);
});

test("维护登录后区分当前测试、候选验证和验证并保存", async ({ page }) => {
  const fixture = await installMaintenanceFixtures(page);
  await page.goto(`${baseUrl}/dashboards/public?design=dashboard-center`);
  await page.getByRole("link",{name:"连接真实数据",exact:true}).click();
  await expect(page).toHaveURL(`${baseUrl}/admin/data-sources`);
  await expect(page.getByRole("button",{name:"账号菜单，QA 维护者"})).toBeVisible();

  await expect(page.getByRole("heading", { name: "进入受保护配置" })).toBeVisible();
  await expect(page.getByRole("region", {name:"真实数据接入步骤"})).toContainText("连接通过不等于所有指标可用");
  await page.getByLabel("维护密码").fill(fakePassword);
  await page.getByRole("button", { name: "进入维护页面" }).click();
  await expect(page.getByRole("heading", { name: "站1", exact: true })).toBeVisible();

  const primaryCard = page.locator(".v2-source-card").filter({ has: page.getByRole("heading", { name: "站1", exact: true }) });
  const tokenInput = primaryCard.getByLabel("候选 Token");
  await expect(tokenInput).toHaveAttribute("autocomplete", "off");
  await expect(tokenInput).toHaveAttribute("data-1p-ignore", "true");
  await expect(primaryCard.getByText("已配置", { exact: true })).toBeVisible();
  await expect(primaryCard.getByText("本次维护会话尚未检测")).toBeVisible();

  await tokenInput.fill(fakeCandidate);
  await primaryCard.getByRole("button", { name: "测试当前连接" }).click();
  await expect(primaryCard.getByText("当前凭证探针通过")).toBeVisible();
  const currentTest = fixture.requests.filter((item) => item.pathname.endsWith("/data-sources/test")).at(-1);
  expect(currentTest.body).toEqual({ site: "primary" });
  await expect(tokenInput).toHaveValue(fakeCandidate);

  await primaryCard.getByRole("button", { name: "仅验证，不保存" }).click();
  await expect(primaryCard.getByText("候选 Token 验证通过，未保存，当前凭证未改变")).toBeVisible();
  await expect(tokenInput).toHaveValue(fakeCandidate);
  const candidateTest = fixture.requests.filter((item) => item.pathname.endsWith("/data-sources/test")).at(-1);
  expect(candidateTest.body).toEqual({ site: "primary", token: fakeCandidate });
  expect(fixture.requests.filter((item) => item.method === "PUT")).toHaveLength(0);

  const saveButton = primaryCard.getByRole("button", { name: "验证并保存", exact: true });
  await saveButton.click();
  const dialog = page.getByRole("dialog", { name: "确认替换站1当前 Token？" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
  await dialog.getByRole("button", { name: "取消" }).click();
  expect(fixture.requests.filter((item) => item.method === "PUT")).toHaveLength(0);

  await saveButton.click();
  await page.mouse.click(5, 5);
  await expect(dialog).not.toBeVisible();
  await expect(tokenInput).toHaveValue(fakeCandidate);
  await expect(saveButton).toBeFocused();
  expect(fixture.requests.filter((item) => item.method === "PUT")).toHaveLength(0);

  await saveButton.click();
  await page.getByRole("dialog", { name: "确认替换站1当前 Token？" }).getByRole("button", { name: "确认验证并保存" }).click();
  await expect(primaryCard.getByText("候选 Token 已验证、保存并立即生效")).toBeVisible();
  await expect(primaryCard.getByText("••••0002", { exact: true })).toBeVisible();
  await expect(tokenInput).toHaveValue("");
  expect(fixture.requests.filter((item) => item.method === "PUT")).toHaveLength(1);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "/private/tmp/ypbi-v2-data-sources-desktop.png" });

  const desktopCards = await page.locator(".v2-source-card").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect()));
  expect(Math.abs(desktopCards[0].top - desktopCards[1].top)).toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

  await page.setViewportSize({ width: 1024, height: 768 });
  const tabletCards = await page.locator(".v2-source-card").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect()));
  expect(tabletCards[1].top).toBeGreaterThan(tabletCards[0].bottom);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);

  await page.goto(`${baseUrl}/admin/data-sources/`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("navigation", { name: "产品主导航" }).getByRole("link", { name: "数据源维护", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "返回经典版" })).toHaveCount(0);
});

test("维护会话失效后清空两站候选 Token 并返回登录", async ({ page }) => {
  const fixture = await installMaintenanceFixtures(page, { authorized: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  const tokenInputs = page.getByLabel("候选 Token");
  await tokenInputs.nth(0).fill("fake-primary-candidate-0001");
  await tokenInputs.nth(1).fill("fake-secondary-candidate-0002");

  fixture.expireOnNextAction();
  await page.getByRole("button", { name: "测试当前连接" }).first().click();
  await expect(page.getByRole("heading", { name: "进入受保护配置" })).toBeVisible();
  await page.getByLabel("维护密码").fill(fakePassword);
  await page.getByRole("button", { name: "进入维护页面" }).click();
  await expect(page.getByLabel("候选 Token").nth(0)).toHaveValue("");
  await expect(page.getByLabel("候选 Token").nth(1)).toHaveValue("");
});

test("390 像素下单列展示、保存对话框支持 Esc 且无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMaintenanceFixtures(page, { authorized: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".v2-source-card")).toHaveCount(2);
  await expect(page.locator(".v2-source-grid")).toHaveCSS("grid-template-columns", /358px/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const primaryCard = page.locator(".v2-source-card").first();
  await primaryCard.getByLabel("候选 Token").fill(fakeCandidate);
  const saveButton = primaryCard.getByRole("button", { name: "验证并保存", exact: true });
  await saveButton.click();
  await expect(page.getByRole("dialog", { name: "确认替换站1当前 Token？" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "确认替换站1当前 Token？" })).toHaveCount(0);
  await expect(saveButton).toBeFocused();
  await expect(page.locator(".v2-skip-link")).not.toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const actionHeights = await primaryCard.locator("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  expect(actionHeights.every((height) => height >= 44)).toBe(true);
  await page.screenshot({ path: "/private/tmp/ypbi-v2-data-sources-mobile.png", fullPage: true });
});

test("维护功能未启用时呈现独立不可用状态且不显示敏感输入", async ({ page }) => {
  await installMaintenanceFixtures(page, { disabled: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "数据源维护尚未启用" })).toBeVisible();
  await expect(page.getByText("错误代码：MAINTENANCE_DISABLED")).toBeVisible();
  await expect(page.getByLabel("维护密码")).toHaveCount(0);
  await expect(page.getByLabel("候选 Token")).toHaveCount(0);
});

test("退出请求失败时保留已登录页面并提示服务端会话可能仍有效", async ({ page }) => {
  await installMaintenanceFixtures(page, { authorized: true, failLogout: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });

  await page.getByLabel("候选 Token").first().fill(fakeCandidate);
  await page.getByRole("button", { name: "退出维护" }).click();

  await expect(page.getByRole("heading", { name: "站1", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("服务端维护会话可能仍然有效");
  await expect(page.getByRole("button", { name: "退出维护" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "进入受保护配置" })).toHaveCount(0);
  await expect(page.getByLabel("候选 Token").first()).toHaveValue("");
});

test("保存响应丢失时标记结果未知并保留候选值供核对", async ({ page }) => {
  await installMaintenanceFixtures(page, { authorized: true, unknownSave: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  const primaryCard = page.locator(".v2-source-card").first();
  const tokenInput = primaryCard.getByLabel("候选 Token");
  await tokenInput.fill(fakeCandidate);
  await primaryCard.getByRole("button", { name: "验证并保存", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认验证并保存" }).click();

  await expect(primaryCard.getByRole("alert")).toContainText("保存结果未确认");
  await expect(primaryCard.getByRole("alert")).not.toContainText("原凭证保持不变");
  await expect(tokenInput).toHaveValue(fakeCandidate);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("操作中维护能力被关闭时清空候选值并切换全局不可用状态", async ({ page }) => {
  await installMaintenanceFixtures(page, { authorized: true, disableOnAction: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("候选 Token").nth(0).fill("fake-primary-candidate-0001");
  await page.getByLabel("候选 Token").nth(1).fill("fake-secondary-candidate-0002");
  await page.getByRole("button", { name: "测试当前连接" }).first().click();

  await expect(page.getByRole("heading", { name: "数据源维护尚未启用" })).toBeVisible();
  await expect(page.getByLabel("候选 Token")).toHaveCount(0);
});

test("操作中代理配置异常时清空候选值并切换全局故障状态", async ({ page }) => {
  await installMaintenanceFixtures(page, { authorized: true, proxyMisconfiguredOnAction: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("候选 Token").nth(0).fill("fake-primary-candidate-0001");
  await page.getByLabel("候选 Token").nth(1).fill("fake-secondary-candidate-0002");
  await page.getByRole("button", { name: "测试当前连接" }).first().click();

  await expect(page.getByRole("heading", { name: "维护入口配置异常" })).toBeVisible();
  await expect(page.getByText("错误代码：MAINTENANCE_PROXY_MISCONFIGURED")).toBeVisible();
  await expect(page.getByLabel("候选 Token")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "站1", exact: true })).toHaveCount(0);
});

test("上游 429 只作为站点探针失败，不误判为维护登录锁定", async ({ page }) => {
  await installMaintenanceFixtures(page, { authorized: true, upstreamRateLimited: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  const primaryCard = page.locator(".v2-source-card").first();
  await primaryCard.getByRole("button", { name: "测试当前连接" }).click();

  await expect(primaryCard.getByRole("alert")).toContainText("后台接口请求过于频繁");
  await expect(page.getByRole("heading", { name: "站1", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "进入受保护配置" })).toHaveCount(0);
});

test("维护登录锁定响应后可在同页重新尝试", async ({ page }) => {
  await installMaintenanceFixtures(page, { lockFirstLogin: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  const passwordInput = page.getByLabel("维护密码");
  await passwordInput.fill(fakePassword);
  await page.getByRole("button", { name: "进入维护页面" }).click();
  await expect(page.getByRole("alert")).toContainText("验证失败次数过多");

  await passwordInput.fill(fakePassword);
  await expect(page.getByRole("button", { name: "进入维护页面" })).toBeEnabled();
  await page.getByRole("button", { name: "进入维护页面" }).click();
  await expect(page.getByRole("heading", { name: "站1", exact: true })).toBeVisible();
});

test("登录接口拒绝非安全传输时切换全局安全连接状态", async ({ page }) => {
  await installMaintenanceFixtures(page, { insecureLogin: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("维护密码").fill(fakePassword);
  await page.getByRole("button", { name: "进入维护页面" }).click();

  await expect(page.getByRole("heading", { name: "需要安全连接" })).toBeVisible();
  await expect(page.getByLabel("维护密码")).toHaveCount(0);
  await expect(page.getByLabel("候选 Token")).toHaveCount(0);
});
