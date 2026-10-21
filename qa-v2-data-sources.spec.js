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
  let previewExpiresAt = options.previewExpiresAt ?? "2099-09-08T01:30:00.000Z";
  let statusFailure = false;
  let statusGate = null;
  let rejectNextActionWith401 = false;
  let loginAttempts = 0;
  const requests = [];
  const environmentRequests = [];
  let sources = sourceStatuses().map(source => options.unconfiguredPrimary && source.site === "primary" ? { ...source, configured: false, userName: "", tokenHint: "未配置" } : source);
  await page.route("**/api/bi/v2/data-environment", route => {
    const mode = route.request().headers()["x-ypbi-data-environment"];
    environmentRequests.push(mode);
    if (statusFailure) return route.fulfill({ status: 503, json: { success: false, error: { code: "V2_UPSTREAM_TIMEOUT", message: "隔离状态检查暂不可用", requestId: "qa-preview-status-unavailable" } } });
    if (mode === "test" && !previewActive) return route.fulfill({ status: 409, json: { success: false, error: { code: "DATA_PREVIEW_SESSION_REQUIRED", message: "测试数据会话无效，请重新验证测试 Token", requestId: "qa-preview-session-required" } } });
    return route.fulfill({ json: { success: true, data: mode === "test"
      ? { mode, testAvailable: true, userName: "fake-test-user", expiresAt: previewExpiresAt }
      : { mode: "production", testAvailable: true, expiresAt: null, userName: null } } });
  });
  await page.route("**/api/bi/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON?.() ?? undefined;
    requests.push({ method: request.method(), pathname: url.pathname, body });
    const isStatus = url.pathname.endsWith("/status");
    const returnedPreview = { enabled: options.previewEnabled ?? true, active: previewActive,
      userName: (options.previewEnabled ?? true) ? "fake-test-user" : null, expiresAt: previewActive ? previewExpiresAt : null };
    if (isStatus && statusGate) await statusGate;
    if (isStatus && statusFailure) return route.fulfill({ status: 503, json: { success: false, error: { code: "ADMIN_STATUS_UNAVAILABLE", message: "隔离状态检查暂不可用" } } });

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
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: sources }) });
    }
    if (url.pathname.endsWith("/data-preview/status")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: returnedPreview
        })
      });
    }
    if (url.pathname.endsWith("/data-preview/activate")) {
      if (options.rejectPreviewActivation) return route.fulfill({ status: 401, json: { success: false, error: { code: "UPSTREAM_AUTH_FAILED", message: "测试后台拒绝候选凭据", requestId: "qa-preview-activation-rejected" } } });
      previewActive = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { mode: "test", userName: "fake-test-user", expiresAt: previewExpiresAt, checkedAt: "2026-09-08T01:00:00.000Z" } })
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
      if (options.rejectCandidateSave) return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "UPSTREAM_AUTH_FAILED", message: "后台拒绝候选凭据", requestId: "fake-credential-probe-1" } }) });
      const updated = { ...sources.find(source => source.site === body.site), configured: true, userName: body.userName ?? sources.find(source => source.site === body.site).userName, tokenHint: "••••0002", updatedAt: "2026-09-08T01:01:00.000Z" };
      sources = sources.map(source => source.site === body.site ? updated : source);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: updated }) });
    }
    return route.abort();
  });
  return {
    requests, environmentRequests,
    setPreviewActive(value) { previewActive = value; },
    setPreviewExpiresAt(value) { previewExpiresAt = value; },
    setStatusFailure(value) { statusFailure = value; },
    holdStatus() {
      let release;
      statusGate = new Promise(resolve => { release = resolve; });
      return () => { statusGate = null; release(); };
    },
    expireOnNextAction() { rejectNextActionWith401 = true; }
  };
}

test("当前连接的20秒正常探针保持等待并展示真实成功，不误报维护超时", async ({ page }) => {
  const issuedAt = new Date("2026-10-14T08:00:00.000Z");
  await page.clock.install({ time: new Date(issuedAt.getTime() - 1000) });
  await page.clock.pauseAt(issuedAt);
  await installMaintenanceFixtures(page, { authorized: true });
  let pendingRoute;
  let finish;
  await page.route("**/api/bi/admin/data-sources/test", route => {
    pendingRoute = route;
    return new Promise(resolve => { finish = resolve; });
  });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  const secondary = page.locator(".v2-source-card").filter({ has: page.getByRole("heading", { name: "站2", exact: true }) });
  await secondary.getByRole("button", { name: "测试当前连接", exact: true }).click();
  try {
    await expect.poll(() => Boolean(pendingRoute)).toBe(true);
    expect(pendingRoute.request().postDataJSON()).toEqual({ site: "secondary" });
    await page.clock.fastForward(20_000);
    await expect(secondary.getByRole("button", { name: "正在测试", exact: true })).toBeDisabled();
    await expect(secondary).not.toContainText("维护服务响应超时");
    await pendingRoute.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { site: "secondary", valid: true, checkedAt: "2026-10-14T08:00:20.000Z" } }) });
    finish();
    await expect(secondary).toContainText("当前凭证探针通过");
    await expect(secondary.getByRole("button", { name: "测试当前连接", exact: true })).toBeEnabled();
  } finally {
    finish?.();
  }
});

for (const width of [1280, 1024, 390]) {
  test(`${width}像素后台账号成对保存、刷新记住并在后续Token更新沿用`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await installMaintenanceFixtures(page, { authorized: true });
    await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
    const primary = page.locator(".v2-source-card").first();
    const secondary = page.locator(".v2-source-card").nth(1);
    await primary.getByRole("button", { name: "修改", exact: true }).click();
    const username = primary.getByLabel("候选后台用户名");
    await expect(username).toHaveValue("fake-primary-user");
    await username.fill("fake-own-primary-user");
    await primary.getByLabel("候选 Token").fill(fakeCandidate);
    await primary.getByRole("button", { name: "测试当前连接", exact: true }).click();
    await expect(primary).toContainText("当前凭证探针通过");
    expect(fixture.requests.filter(item => item.pathname.endsWith("/data-sources/test")).at(-1).body).toEqual({ site: "primary" });
    await primary.getByRole("button", { name: "仅验证，不保存", exact: true }).click();
    await expect(primary).toContainText("未保存");
    expect(fixture.requests.filter(item => item.pathname.endsWith("/data-sources/test")).at(-1).body).toEqual({ site: "primary", token: fakeCandidate, userName: "fake-own-primary-user" });
    await expect(primary.locator(".v2-source-facts")).toContainText("fake-primary-user");
    await primary.getByRole("button", { name: "验证并保存", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("全站");
    await page.getByRole("dialog").getByRole("button", { name: "确认验证并保存" }).click();
    await expect(primary.locator(".v2-source-facts")).toContainText("fake-own-primary-user");
    await expect(primary.getByLabel("候选 Token")).toHaveValue("");
    await expect(primary.getByLabel("候选后台用户名")).toHaveCount(0);
    await expect(secondary.locator(".v2-source-facts")).toContainText("fake-secondary-user");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(primary.locator(".v2-source-facts")).toContainText("fake-own-primary-user");
    await expect(primary.getByLabel("候选后台用户名")).toHaveCount(0);
    await primary.getByLabel("候选 Token").fill("fake-next-rotated-token-0005");
    await primary.getByRole("button", { name: "验证并保存", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认验证并保存" }).click();
    await expect(primary.getByLabel("候选 Token")).toHaveValue("");
    expect(fixture.requests.filter(item => item.pathname.endsWith("/data-sources/token")).at(-1).body).toEqual({ site: "primary", token: "fake-next-rotated-token-0005" });
    await expect(primary.locator(".v2-source-facts")).toContainText("fake-own-primary-user");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(fakeCandidate);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `/private/tmp/ypbi-20261020-credential-pair-${width}.png`, fullPage: true });
  });
}

test("换账号保存被拒绝保留完整草稿和旧账号，不污染另一个站点", async ({ page }) => {
  const fixture = await installMaintenanceFixtures(page, { authorized: true, rejectCandidateSave: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  const primary = page.locator(".v2-source-card").first();
  const secondary = page.locator(".v2-source-card").nth(1);
  await primary.getByRole("button", { name: "修改", exact: true }).click();
  await primary.getByLabel("候选后台用户名").fill("fake-rejected-user");
  await primary.getByLabel("候选 Token").fill(fakeCandidate);
  await secondary.getByLabel("候选 Token").fill("fake-other-site-token-0004");
  await primary.getByRole("button", { name: "验证并保存", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认验证并保存" }).click();
  await expect(primary.getByRole("alert")).toContainText("原后台账号与 Token 保持不变");
  await expect(primary.getByRole("alert")).toContainText("UPSTREAM_AUTH_FAILED");
  await expect(primary.getByRole("alert")).toContainText("fake-credential-probe-1");
  await expect(primary.getByLabel("候选后台用户名")).toHaveValue("fake-rejected-user");
  await expect(primary.getByLabel("候选 Token")).toHaveValue(fakeCandidate);
  await expect(primary.locator(".v2-source-facts")).toContainText("fake-primary-user");
  await expect(secondary.getByLabel("候选 Token")).toHaveValue("fake-other-site-token-0004");
  expect(fixture.requests.filter(item => item.method === "PUT")).toHaveLength(1);
});

test("首次配置必须填写账号，取消修改恢复原账号且不丢Token草稿", async ({ page }, info) => {
  const fixture = await installMaintenanceFixtures(page, { authorized: true, unconfiguredPrimary: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });
  const primary = page.locator(".v2-source-card").first();
  await expect(primary.getByRole("button", { name: "测试当前连接", exact: true })).toBeDisabled();
  await page.evaluate(() => {
    const requestFrame = window.requestAnimationFrame.bind(window);
    const callbacks = [];
    window.requestAnimationFrame = callback => { callbacks.push(callback); return -callbacks.length; };
    window.__qaReleaseAccountFocus = () => {
      window.requestAnimationFrame = requestFrame;
      for (const callback of callbacks) callback(performance.now());
      delete window.__qaReleaseAccountFocus;
    };
  });
  await primary.getByRole("button", { name: "设置", exact: true }).click();
  await expect(primary.getByLabel("候选后台用户名")).toHaveValue("");
  await primary.getByLabel("候选 Token").focus();
  await page.evaluate(() => window.__qaReleaseAccountFocus());
  await expect(primary.getByLabel("候选 Token")).toBeFocused();
  await primary.getByLabel("候选 Token").fill(fakeCandidate);
  await expect(primary.getByRole("button", { name: "验证并保存", exact: true })).toBeDisabled();
  await primary.getByLabel("候选后台用户名").fill("fake-first-account");
  await expect(primary.getByLabel("候选 Token")).toHaveValue(fakeCandidate);
  await expect(primary.getByRole("button", { name: "验证并保存", exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("first-credential-draft-ready.png"), fullPage: true });
  await primary.getByRole("button", { name: "验证并保存", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认验证并保存" }).click();
  await expect(primary.locator(".v2-source-facts")).toContainText("fake-first-account");
  await expect(primary.getByRole("button", { name: "测试当前连接", exact: true })).toBeEnabled();
  await primary.getByLabel("候选 Token").fill("fake-rotating-after-cancel-0001");
  await primary.getByRole("button", { name: "修改", exact: true }).click();
  await primary.getByLabel("候选后台用户名").fill("fake-cancelled-account");
  await primary.getByRole("button", { name: "取消修改", exact: true }).click();
  await expect(primary.getByLabel("候选后台用户名")).toHaveCount(0);
  await expect(primary.getByLabel("候选 Token")).toHaveValue("fake-rotating-after-cancel-0001");
  await primary.getByRole("button", { name: "仅验证，不保存", exact: true }).click();
  await expect(primary).toContainText("未保存");
  expect(fixture.requests.filter(item => item.pathname.endsWith("/data-sources/test")).at(-1).body).toEqual({ site: "primary", token: "fake-rotating-after-cancel-0001" });
  await page.screenshot({ path: info.outputPath("first-credential-cancel-keeps-draft.png"), fullPage: true });
});

test("临时测试 Token 只创建当前会话并可明确切回正式数据", async ({ page }) => {
  const fixture = await installMaintenanceFixtures(page, { authorized: true });
  await page.goto(`${baseUrl}/admin/data-sources`, { waitUntil: "domcontentloaded" });

  const preview = page.getByRole("region", { name: "临时测试数据" });
  await expect(preview).toContainText("24 小时到期或退出后删除");
  const input = preview.getByLabel("测试 Token");
  await input.fill("fake-preview-token-0001");
  await preview.getByRole("button", { name: "验证并进入测试数据" }).click();

  await expect(preview.getByText("测试模式中", { exact: true })).toBeVisible();
  await expect(preview.getByText("测试数据", { exact: true })).toBeVisible();
  await expect(page.locator(".v2-data-environment").getByText("测试数据", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "开发接口就绪检查" })).toHaveCount(0);
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

async function selectTestEnvironment(page) {
  await page.addInitScript(() => sessionStorage.setItem("ypbi.data-environment.v1:00000000-0000-4000-8000-000000000001", "test"));
}
async function foregroundEvents(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
}

test("旧测试页面恢复前台只读确认重启失效，撤销旧有效状态且保留两站草稿", async ({ page }, info) => {
  await selectTestEnvironment(page);
  const fixture = await installMaintenanceFixtures(page, { authorized: true, previewActive: true });
  await page.goto(`${baseUrl}/admin/data-sources`);
  const preview = page.getByRole("region", { name: "临时测试数据" });
  await expect(preview.getByText("测试模式中", { exact: true })).toBeVisible();
  const drafts = page.locator(".v2-source-card").getByLabel("候选 Token");
  await drafts.nth(0).fill("fake-primary-draft-preserved"); await drafts.nth(1).fill("fake-secondary-draft-preserved");
  fixture.setPreviewActive(false);
  await foregroundEvents(page);
  await expect(page.locator(".v2-data-environment")).toContainText("测试数据已失效");
  await expect(preview.getByText("测试模式中", { exact: true })).toHaveCount(0);
  await expect(preview.getByText("未启用", { exact: true })).toBeVisible();
  await expect(preview.getByLabel("测试 Token")).toBeVisible();
  await expect(preview).not.toHaveClass(/is-active/);
  await expect(preview).not.toContainText("2099/09/08");
  await expect(drafts.nth(0)).toHaveValue("fake-primary-draft-preserved");
  await expect(drafts.nth(1)).toHaveValue("fake-secondary-draft-preserved");
  expect(fixture.requests.every(request => request.method === "GET")).toBe(true);
  expect(await page.evaluate(() => sessionStorage.getItem("ypbi.data-environment.v1:00000000-0000-4000-8000-000000000001"))).toBe("test");
  await page.screenshot({ path: info.outputPath("preview-restart-invalid-keeps-drafts.png"), fullPage: true });
});

test("前台事件单飞，检查失败显示待确认而非成功且不丢测试Token草稿", async ({ page }) => {
  const fixture = await installMaintenanceFixtures(page, { authorized: true });
  await page.goto(`${baseUrl}/admin/data-sources`);
  const preview = page.getByRole("region", { name: "临时测试数据" });
  const token = preview.getByLabel("测试 Token");
  await token.fill("fake-preview-draft-preserved");
  const before = fixture.requests.length, release = fixture.holdStatus();
  try {
    await foregroundEvents(page);
    await expect.poll(() => fixture.requests.length).toBe(before + 2);
    await expect(preview).toContainText("正在确认");
    await foregroundEvents(page);
    expect(fixture.requests).toHaveLength(before + 2);
    fixture.setStatusFailure(true); release();
    await expect(preview).toContainText("状态待确认");
    await expect(preview).toContainText("暂时无法确认测试数据会话");
    await expect(preview).not.toHaveClass(/is-active/);
    await expect(token).toHaveValue("fake-preview-draft-preserved");
    fixture.setStatusFailure(false); await foregroundEvents(page);
    await expect(preview.getByText("未启用", { exact: true })).toBeVisible();
    await expect(token).toHaveValue("fake-preview-draft-preserved");
    expect(fixture.requests.every(request => request.method === "GET")).toBe(true);
  } finally { release(); }
});

for (const action of ["current", "candidate", "save"]) {
  test(`维护操作取消只读检查后补充复核-${action}`, async ({ page }) => {
    const fixture = await installMaintenanceFixtures(page, { authorized: true, previewActive: true });
    await page.goto(`${baseUrl}/admin/data-sources`);
    const preview = page.getByRole("region", { name: "临时测试数据" });
    const enter = preview.getByRole("button", { name: "进入测试数据", exact: true });
    const primary = page.locator(".v2-source-card").first();
    const drafts = page.locator(".v2-source-card").getByLabel("候选 Token");
    await expect(enter).toBeEnabled();
    await drafts.nth(0).fill(fakeCandidate);
    await drafts.nth(1).fill("fake-other-draft-preserved");
    const before = fixture.requests.filter(request => request.method === "GET").length;
    const release = fixture.holdStatus();
    try {
      await foregroundEvents(page);
      await expect.poll(() => fixture.requests.filter(request => request.method === "GET").length).toBe(before + 2);
      await expect(preview).toContainText("正在确认");
      await primary.getByRole("button", { name: action === "current" ? "测试当前连接" : action === "candidate" ? "仅验证，不保存" : "验证并保存", exact: true }).click();
      if (action === "save") await page.getByRole("dialog").getByRole("button", { name: "确认验证并保存" }).click();
      await expect(primary).toContainText(action === "current" ? "当前凭证探针通过" : action === "candidate" ? "候选凭据验证通过" : "候选凭据已验证、保存并立即生效");
      await expect.poll(() => fixture.requests.filter(request => request.method === "GET").length).toBe(before + 4);
      release();
      await expect(enter).toBeEnabled();
      await expect(preview).not.toContainText("正在确认");
      await expect(drafts.nth(0)).toHaveValue(action === "save" ? "" : fakeCandidate);
      await expect(drafts.nth(1)).toHaveValue("fake-other-draft-preserved");
      expect(fixture.requests.filter(request => request.method !== "GET").map(request => request.pathname)).toEqual([
        `/api/bi/admin/data-sources/${action === "save" ? "token" : "test"}`
      ]);
    } finally { release(); }
  });
}

test("测试会话激活失败退出确认中并保留草稿，后续仅只读复核", async ({ page }) => {
  const fixture = await installMaintenanceFixtures(page, { authorized: true, rejectPreviewActivation: true });
  await page.goto(`${baseUrl}/admin/data-sources`);
  const preview = page.getByRole("region", { name: "临时测试数据" });
  const token = preview.getByLabel("测试 Token");
  await token.fill("fake-rejected-preview-draft");
  await preview.getByRole("button", { name: "验证并进入测试数据" }).click();
  await expect(preview).toContainText("测试后台拒绝候选凭据");
  await expect(preview).toContainText("状态待确认");
  await expect(preview).not.toContainText("正在确认");
  await expect(token).toHaveValue("fake-rejected-preview-draft");
  await expect(page.locator(".v2-data-environment")).toContainText("正式数据");
  await foregroundEvents(page);
  await expect(preview.getByText("未启用", { exact: true })).toBeVisible();
  await expect(token).toHaveValue("fake-rejected-preview-draft");
  expect(fixture.requests.filter(request => request.method !== "GET").map(request => request.pathname)).toEqual(["/api/bi/admin/data-preview/activate"]);
});

test("维护操作取消检查后认证失效，不补读旧状态恢复受保护页面", async ({ page }) => {
  const fixture = await installMaintenanceFixtures(page, { authorized: true, previewActive: true });
  await page.goto(`${baseUrl}/admin/data-sources`);
  const primary = page.locator(".v2-source-card").first();
  await expect(primary).toBeVisible();
  const before = fixture.requests.filter(request => request.method === "GET").length;
  const release = fixture.holdStatus();
  try {
    await foregroundEvents(page);
    await expect.poll(() => fixture.requests.filter(request => request.method === "GET").length).toBe(before + 2);
    fixture.expireOnNextAction();
    await primary.getByRole("button", { name: "测试当前连接", exact: true }).click();
    await expect(page.getByRole("heading", { name: "进入受保护配置" })).toBeVisible();
    release();
    await foregroundEvents(page);
    await expect(page.getByRole("heading", { name: "进入受保护配置" })).toBeVisible();
    await expect(page.locator(".v2-source-card")).toHaveCount(0);
    expect(fixture.requests.filter(request => request.method === "GET")).toHaveLength(before + 2);
    expect(fixture.requests.filter(request => request.method !== "GET").map(request => request.pathname)).toEqual(["/api/bi/admin/data-sources/test"]);
  } finally { release(); }
});

test("测试会话到期自动只读复核，旧期限不延长且不自动退出或重新激活", async ({ page }) => {
  const issuedAt = new Date("2026-10-21T02:00:00.000Z");
  await page.clock.install({ time: new Date(issuedAt.getTime() - 1_000) }); await page.clock.pauseAt(issuedAt);
  await selectTestEnvironment(page);
  const fixture = await installMaintenanceFixtures(page, { authorized: true, previewActive: true, previewExpiresAt: new Date(issuedAt.getTime() + 5_000).toISOString() });
  await page.goto(`${baseUrl}/admin/data-sources`);
  const preview = page.getByRole("region", { name: "临时测试数据" });
  await expect(preview.getByText("测试模式中", { exact: true })).toBeVisible();
  fixture.setPreviewActive(false);
  await page.clock.fastForward(5_001);
  await expect(page.locator(".v2-data-environment")).toContainText("测试数据已失效");
  await expect(preview.getByText("未启用", { exact: true })).toBeVisible();
  await expect(preview.getByLabel("测试 Token")).toBeVisible();
  expect(fixture.environmentRequests.length).toBeGreaterThanOrEqual(2);
  expect(fixture.requests.every(request => request.method === "GET")).toBe(true);
});

test("旧只读检查晚到不能撤销新激活，进入已有测试会话先核实服务器当前状态", async ({ page }) => {
  const fixture = await installMaintenanceFixtures(page, { authorized: true });
  await page.goto(`${baseUrl}/admin/data-sources`);
  const preview = page.getByRole("region", { name: "临时测试数据" });
  await preview.getByLabel("测试 Token").fill("fake-preview-new-session");
  const before = fixture.requests.length, release = fixture.holdStatus();
  try {
    await foregroundEvents(page);
    await expect.poll(() => fixture.requests.length).toBe(before + 2);
    await preview.getByRole("button", { name: "验证并进入测试数据" }).click();
    await expect.poll(() => fixture.requests.filter(request => request.pathname.endsWith("/data-preview/activate")).length).toBe(1);
    release();
    await expect(preview.getByText("测试模式中", { exact: true })).toBeVisible();
    await expect(page.locator(".v2-data-environment")).toContainText("测试数据");
    await page.locator(".v2-data-environment").getByRole("button", { name: "切回正式", exact: true }).click();
    await expect(preview.getByRole("button", { name: "进入测试数据", exact: true })).toBeVisible();
    fixture.setPreviewActive(false);
    await preview.getByRole("button", { name: "进入测试数据", exact: true }).click();
    await expect(preview.getByText("未启用", { exact: true })).toBeVisible();
    await expect(page.locator(".v2-data-environment")).toContainText("正式数据");
    expect(fixture.requests.filter(request => request.method !== "GET").map(request => request.pathname)).toEqual(["/api/bi/admin/data-preview/activate"]);
  } finally { release(); }
});

test("维护登录后区分当前测试、候选验证和验证并保存", async ({ page }) => {
  const fixture = await installMaintenanceFixtures(page);
  await page.goto(`${baseUrl}/dashboards/public?design=dashboard-center`);
  await page.getByRole("link",{name:"连接真实数据",exact:true}).click();
  await expect(page).toHaveURL(`${baseUrl}/admin/data-sources`);
  await expect(page.getByRole("button",{name:"账号菜单，QA 维护者"})).toBeVisible();

  await expect(page.getByRole("heading", { name: "进入受保护配置" })).toBeVisible();
  await expect(page.locator(".v2-maintenance-login__intro")).toContainText("维护会话有效期 15 天。");
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
  await expect(primaryCard.getByText("候选凭据验证通过，未保存，当前凭证未改变")).toBeVisible();
  await expect(tokenInput).toHaveValue(fakeCandidate);
  const candidateTest = fixture.requests.filter((item) => item.pathname.endsWith("/data-sources/test")).at(-1);
  expect(candidateTest.body).toEqual({ site: "primary", token: fakeCandidate });
  expect(fixture.requests.filter((item) => item.method === "PUT")).toHaveLength(0);

  const saveButton = primaryCard.getByRole("button", { name: "验证并保存", exact: true });
  await saveButton.click();
  const dialog = page.getByRole("dialog", { name: "确认更新站1共享凭据？" });
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
  await page.getByRole("dialog", { name: "确认更新站1共享凭据？" }).getByRole("button", { name: "确认验证并保存" }).click();
  await expect(primaryCard.getByText("候选凭据已验证、保存并立即生效")).toBeVisible();
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
  await expect(page.getByRole("dialog", { name: "确认更新站1共享凭据？" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "确认更新站1共享凭据？" })).toHaveCount(0);
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
