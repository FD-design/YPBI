import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const baseUrl = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const metricDefinitions = JSON.parse(readFileSync(
  new URL("./server/v2/generated/metric-definitions.json", import.meta.url),
  "utf8"
));
const initialPassword = "qa-initial-password-001";
const replacementPassword = "qa-replacement-password-002";
const csrfOne = "a".repeat(43);
const csrfTwo = "b".repeat(43);

test.use({ viewport: { width: 1280, height: 800 }, channel: "chrome" });

function sessionData({
  subjectId = "00000000-0000-4000-8000-000000000001",
  username = "qa.user",
  displayName = "QA 用户",
  role = "reader",
  permissions = role === "maintainer" ? ["bi:read", "bi:data-source-maintenance:enter"] : ["bi:read"],
  mustChangePassword = false,
  csrfToken = csrfOne
} = {}) {
  return {
    user: {
      subjectId,
      username,
      displayName,
      role,
      permissions,
      pidScope: "all"
    },
    expiresAt: "2099-09-08T00:00:00.000Z",
    mustChangePassword,
    csrfToken
  };
}

function authError(code = "AUTHENTICATION_REQUIRED", message = "请先登录", requestId = "req-auth-qa") {
  return { success: false, error: { code, message, requestId } };
}

function metricCatalog() {
  return {
    success: true,
    data: metricDefinitions
  };
}

async function installMetricCatalog(page, responder = () => ({ status: 200, body: metricCatalog() })) {
  await page.route("**/api/bi/v2/catalog/metric-definitions", async (route) => {
    const response = responder();
    await route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
  });
}

test("未登录深链安全回到登录页，登录后 replace 返回完整同源地址", async ({ page }) => {
  const requests = [];
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(authError()) }));
  await page.route("**/api/bi/v2/auth/login", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sessionData() }) });
  });
  await installMetricCatalog(page);

  const returnPath = "/data/metrics?q=%E6%97%A5%E6%B4%BB#catalog";
  await page.goto(`${baseUrl}${returnPath}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "登录 YPBI" })).toBeVisible();
  await expect(page.locator("#v2-primary-navigation")).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(returnPath);

  const loginUrl = page.url();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "登录 YPBI" })).toBeVisible();
  await expect(page).toHaveURL(loginUrl);

  await page.getByLabel("账号").fill("qa.user");
  await page.getByLabel("密码", { exact: true }).fill(initialPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${baseUrl}${returnPath}`);
  expect(requests).toEqual([{ username: "qa.user", password: initialPassword }]);
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} });

  await page.goBack({ waitUntil: "domcontentloaded" });
  expect(new URL(page.url()).pathname).not.toBe("/login");
  await expect(page.getByRole("heading", { name: "登录 YPBI" })).toHaveCount(0);
});

test("登录失败保留账号但清空密码，不展示产品框架", async ({ page }) => {
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(authError()) }));
  await page.route("**/api/bi/v2/auth/login", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(authError("INVALID_CREDENTIALS", "账号或密码错误")) }));
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("账号").fill("qa.user");
  await page.getByLabel("密码", { exact: true }).fill(initialPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("账号或密码错误");
  await expect(page.getByLabel("账号")).toHaveValue("qa.user");
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
  await expect(page.locator("#v2-primary-navigation")).toHaveCount(0);
});

test("首次登录必须改密，带 CSRF 更新成功后才进入原页面", async ({ page }) => {
  let authenticated = false;
  let mustChangePassword = true;
  const passwordRequests = [];
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill(authenticated
    ? { status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sessionData({ mustChangePassword }) }) }
    : { status: 401, contentType: "application/json", body: JSON.stringify(authError()) }));
  await page.route("**/api/bi/v2/auth/login", (route) => {
    authenticated = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sessionData({ mustChangePassword: true }) }) });
  });
  await page.route("**/api/bi/v2/auth/password", async (route) => {
    passwordRequests.push({ method: route.request().method(), body: route.request().postDataJSON(), csrf: route.request().headers()["x-csrf-token"] });
    mustChangePassword = false;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sessionData({ mustChangePassword: false, csrfToken: csrfTwo }) }) });
  });
  await installMetricCatalog(page);

  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("账号").fill("qa.user");
  await page.getByLabel("密码", { exact: true }).fill(initialPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "首次登录，请设置新密码" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toHaveCount(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "首次登录，请设置新密码" })).toBeVisible();
  await expect(page.locator("#v2-primary-navigation")).toHaveCount(0);

  await page.getByLabel("当前密码").fill(initialPassword);
  await page.getByRole("textbox", { name: /^新密码/ }).fill(replacementPassword);
  await page.getByLabel("确认新密码").fill(replacementPassword);
  await page.getByRole("button", { name: "设置新密码并继续" }).click();
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toBeVisible();
  expect(passwordRequests).toEqual([{ method: "PUT", body: { currentPassword: initialPassword, newPassword: replacementPassword }, csrf: csrfOne }]);
});

test("390 强制改密页可退出切换账号，失败保持强制页、成功回登录", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let logoutStatus = 403;
  const logoutRequests = [];
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, data: sessionData({ mustChangePassword: true }) })
  }));
  await page.route("**/api/bi/v2/auth/logout", async (route) => {
    logoutRequests.push({ method: route.request().method(), csrf: route.request().headers()["x-csrf-token"] });
    if (logoutStatus === 403) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify(authError("CSRF_VALIDATION_FAILED", "安全校验失败")) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { loggedOut: true } }) });
  });

  await page.goto(`${baseUrl}/data/metrics?view=compact#catalog`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "首次登录，请设置新密码" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const card = await page.locator(".v2-auth-card").boundingBox();
  expect(card).not.toBeNull();
  expect(card.x).toBeGreaterThanOrEqual(0);
  expect(card.x + card.width).toBeLessThanOrEqual(390);

  const switchAccount = page.getByRole("button", { name: "退出并切换账号" });
  await switchAccount.click();
  await expect(page.getByRole("alert")).toContainText("安全校验失败");
  await expect(page.getByRole("heading", { name: "首次登录，请设置新密码" })).toBeVisible();
  await expect(page.locator("#v2-primary-navigation")).toHaveCount(0);

  logoutStatus = 200;
  await switchAccount.click();
  await expect(page.getByRole("heading", { name: "登录 YPBI" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/data/metrics?view=compact#catalog");
  expect(logoutRequests).toEqual([
    { method: "POST", csrf: csrfOne },
    { method: "POST", csrf: csrfOne }
  ]);
});

test("业务请求 401 全局清除旧页面并回登录，403 仅显示无权限", async ({ page }) => {
  let status = 200;
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sessionData() }) }));
  await installMetricCatalog(page, () => status === 200
    ? { status: 200, body: metricCatalog() }
    : { status, body: authError(status === 401 ? "AUTHENTICATION_REQUIRED" : "PID_ACCESS_DENIED", status === 401 ? "登录已失效" : "当前范围无权访问") });

  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#metric-open-M016")).toBeVisible();
  status = 403;
  await page.getByRole("button", { name: "刷新指标目录" }).click();
  await expect(page.getByRole("heading", { name: "当前范围无权访问" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录 YPBI" })).toHaveCount(0);

  status = 401;
  await page.getByRole("button", { name: "重新检查" }).click();
  await expect(page.getByRole("heading", { name: "登录 YPBI" })).toBeVisible();
  await expect(page.locator(".v2-table-surface")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/data/metrics");
});

test("页面重新获得焦点时复核会话，失效后清除旧页面并回登录", async ({ page }) => {
  let sessionValid = true;
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill(sessionValid
    ? { status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sessionData() }) }
    : { status: 401, contentType: "application/json", body: JSON.stringify(authError()) }));
  await installMetricCatalog(page);

  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#metric-open-M016")).toBeVisible();
  sessionValid = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(page.getByRole("heading", { name: "登录 YPBI" })).toBeVisible();
  await expect(page.locator(".v2-table-surface")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/data/metrics");
});

for (const scenario of [
  {
    title: "焦点复核发现账号 A 切换为 B 时卸载旧结果并按 B 重新取数",
    initialSession: sessionData(),
    nextSession: sessionData({
      subjectId: "00000000-0000-4000-8000-000000000002",
      username: "qa.second",
      displayName: "第二用户",
      csrfToken: csrfTwo
    }),
    expectedAccountName: "第二用户"
  },
  {
    title: "焦点复核发现同账号权限范围变化时卸载旧结果并重新取数",
    initialSession: sessionData({ role: "maintainer" }),
    nextSession: sessionData({ role: "reader" }),
    expectedAccountName: "QA 用户"
  }
]) {
  test(scenario.title, async ({ page }) => {
    let currentSession = scenario.initialSession;
    let catalogStatus = 200;
    let catalogRequests = 0;
    await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: currentSession })
    }));
    await installMetricCatalog(page, () => {
      catalogRequests += 1;
      return catalogStatus === 200
        ? { status: 200, body: metricCatalog() }
        : { status: 403, body: authError("PID_ACCESS_DENIED", "当前账号无权读取该目录") };
    });

    await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#metric-open-M016")).toBeVisible();
    const requestsBeforeScopeChange = catalogRequests;

    currentSession = scenario.nextSession;
    catalogStatus = 403;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    await expect(page.getByRole("button", { name: `账号菜单，${scenario.expectedAccountName}` })).toBeVisible();
    await expect(page.locator("#metric-open-M016")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "当前范围无权访问" })).toBeVisible();
    await expect(page.getByText("当前账号无权读取该目录", { exact: true })).toBeVisible();
    await expect.poll(() => catalogRequests).toBeGreaterThan(requestsBeforeScopeChange);
  });
}

test("缺少维护能力的会话不显示维护导航，直接深链也不会请求维护接口", async ({ page }) => {
  let adminRequests = 0;
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sessionData({ role: "reader" }) }) }));
  await page.route("**/api/bi/admin/**", (route) => { adminRequests += 1; return route.abort(); });
  await installMetricCatalog(page);
  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("link", { name: /数据源维护/ })).toHaveCount(0);
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "无权访问管理中心" })).toBeVisible();
  expect(adminRequests).toBe(0);
});

test("管理接口发现普通登录失效时卸载维护页面并回到登录页", async ({ page }) => {
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, data: sessionData({ role: "maintainer" }) })
  }));
  await page.route("**/api/bi/admin/data-sources/status", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify(authError("AUTHENTICATION_REQUIRED", "普通登录已失效"))
  }));

  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "登录 YPBI" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "数据源维护" })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/admin/data-sources");
});

test("改密成功更新 CSRF，下一次退出使用新令牌且写请求方法正确", async ({ page }) => {
  let logoutStatus = 403;
  const passwordRequests = [];
  const logoutRequests = [];
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sessionData({ role: "maintainer" }) }) }));
  await page.route("**/api/bi/v2/auth/password", async (route) => {
    passwordRequests.push({ method: route.request().method(), body: route.request().postDataJSON(), csrf: route.request().headers()["x-csrf-token"] });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sessionData({ role: "maintainer", csrfToken: csrfTwo }) }) });
  });
  await page.route("**/api/bi/v2/auth/logout", async (route) => {
    logoutRequests.push({ method: route.request().method(), csrf: route.request().headers()["x-csrf-token"] });
    if (logoutStatus === 403) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify(authError("CSRF_VALIDATION_FAILED", "安全校验失败")) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { loggedOut: true } }) });
  });
  await installMetricCatalog(page);
  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });

  const accountButton = page.getByRole("button", { name: "账号菜单，QA 用户" });
  await accountButton.click();
  await expect(page.getByRole("menu")).toContainText("@qa.user · 维护者");
  await page.getByRole("menuitem", { name: "修改密码" }).click();
  await page.getByLabel("当前密码").fill(initialPassword);
  await page.getByRole("button", { name: "取消" }).click();
  await expect(accountButton).toBeFocused();
  await accountButton.click();
  await page.getByRole("menuitem", { name: "修改密码" }).click();
  await expect(page.getByLabel("当前密码")).toHaveValue("");
  await expect(page.getByRole("textbox", { name: /^新密码/ })).toHaveValue("");
  await expect(page.getByLabel("确认新密码")).toHaveValue("");
  await page.getByLabel("当前密码").fill(initialPassword);
  await page.getByRole("textbox", { name: /^新密码/ }).fill(replacementPassword);
  await page.getByLabel("确认新密码").fill(replacementPassword);
  await page.getByRole("button", { name: "更新密码" }).click();
  await expect(page.getByRole("dialog", { name: "修改密码" })).toBeHidden();
  await expect(accountButton).toBeFocused();

  await accountButton.click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page.getByRole("alert")).toContainText("安全校验失败");
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toBeVisible();
  logoutStatus = 200;
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录 YPBI" })).toBeVisible();
  expect(passwordRequests).toEqual([{
    method: "PUT",
    body: { currentPassword: initialPassword, newPassword: replacementPassword },
    csrf: csrfOne
  }]);
  expect(logoutRequests).toEqual([
    { method: "POST", csrf: csrfTwo },
    { method: "POST", csrf: csrfTwo }
  ]);
});

test("390 用户菜单键盘可达，改密 dialog 失败清空、Esc 解锁并恢复页面几何", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const passwordRequests = [];
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sessionData({ role: "maintainer" }) }) }));
  await page.route("**/api/bi/v2/auth/password", async (route) => {
    passwordRequests.push({ method: route.request().method(), csrf: route.request().headers()["x-csrf-token"] });
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify(authError("CURRENT_PASSWORD_INVALID", "当前密码错误")) });
  });
  await installMetricCatalog(page);
  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });

  const accountButton = page.getByRole("button", { name: "账号菜单，QA 用户" });
  await accountButton.focus();
  await page.keyboard.press("ArrowDown");
  const changePasswordItem = page.getByRole("menuitem", { name: "修改密码" });
  const logoutItem = page.getByRole("menuitem", { name: "退出登录" });
  await expect(changePasswordItem).toBeFocused();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.keyboard.press("ArrowDown");
  await expect(logoutItem).toBeFocused();
  await page.keyboard.press("Home");
  await expect(changePasswordItem).toBeFocused();
  await page.keyboard.press("End");
  await expect(logoutItem).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(changePasswordItem).toBeFocused();

  const geometryBefore = await page.evaluate(() => {
    const shell = document.querySelector("#root > .ypbi-v2").getBoundingClientRect();
    return { shellX: shell.x, shellWidth: shell.width, scrollWidth: document.documentElement.scrollWidth };
  });
  await changePasswordItem.click();
  const dialog = page.getByRole("dialog", { name: "修改密码" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("当前密码")).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.dataset.scrollLocked)).toBe("true");
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(390);
  expect(dialogBox.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(844);
  const geometryDuring = await page.evaluate(() => {
    const shell = document.querySelector("#root > .ypbi-v2").getBoundingClientRect();
    return { shellX: shell.x, shellWidth: shell.width, scrollWidth: document.documentElement.scrollWidth };
  });
  expect(geometryDuring).toEqual(geometryBefore);

  await page.getByLabel("当前密码").fill(initialPassword);
  await page.getByRole("textbox", { name: /^新密码/ }).fill(replacementPassword);
  await page.getByLabel("确认新密码").fill(replacementPassword);
  await page.getByRole("button", { name: "更新密码" }).click();
  await expect(page.getByRole("alert")).toContainText("当前密码错误");
  await expect(page.getByLabel("当前密码")).toHaveValue("");
  await expect(page.getByRole("textbox", { name: /^新密码/ })).toHaveValue("");
  await expect(page.getByLabel("确认新密码")).toHaveValue("");
  expect(passwordRequests).toEqual([{ method: "PUT", csrf: csrfOne }]);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(accountButton).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.dataset.scrollLocked ?? null)).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const geometryAfter = await page.evaluate(() => {
    const shell = document.querySelector("#root > .ypbi-v2").getBoundingClientRect();
    return { shellX: shell.x, shellWidth: shell.width, scrollWidth: document.documentElement.scrollWidth };
  });
  expect(geometryAfter).toEqual(geometryBefore);
});

test("390 像素登录页保持单列、可点击尺寸且无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(authError()) }));
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "登录 YPBI" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const controls = await page.locator(".v2-auth-form input, .v2-auth-form button").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  expect(controls.every((height) => height >= 44)).toBe(true);
  await page.screenshot({ path: "/private/tmp/ypbi-v2-auth-mobile.png", fullPage: true });
});

test("外站与登录页自身不能作为登录回跳地址", async ({ page }) => {
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sessionData() }) }));
  await installMetricCatalog(page);
  await page.goto(`${baseUrl}/login?returnTo=${encodeURIComponent("https://example.com/steal")}`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(`${baseUrl}/data/metrics`);
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toBeVisible();

  await page.goto(`${baseUrl}/login?returnTo=${encodeURIComponent("/login/")}`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(`${baseUrl}/data/metrics`);
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toBeVisible();
});
