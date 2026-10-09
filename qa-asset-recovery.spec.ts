import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5198";
test.use({ channel: "chrome" });

// Production entry and error UI are real build artifacts; only delivery failures
// and the final application module are controlled. No backend is contacted.
async function fixture(page: Page, options: { oldEntry?: boolean; boundary?: boolean; runtime?: boolean } = {}) {
  const dist = new URL("./dist/", import.meta.url);
  const html = await readFile(new URL("index.html", dist), "utf8");
  const entry = html.match(/<script\b[^>]*src="([^"]+)"/)?.[1];
  if (!entry?.startsWith("/assets/")) throw new Error("Run npm run build before this production-artifact QA.");
  const entrySource = await readFile(new URL(`.${entry}`, dist), "utf8");
  const namespace = entrySource.match(/import\("\.\/ProductApp-[^"]+"\)\.then\(\w+=>\w+\.([\w$]+)\)/)?.[1];
  const appModule = (body: string) => `export function ProductApp(){${body}}${namespace ? `export const ${namespace}={ProductApp};` : ""}`;
  const oldEntry = "/assets/index-previousrelease.js";
  const navigations: string[] = [];
  const checks: string[] = [];
  const fetchOptions: { cache?: RequestCache; credentials?: RequestCredentials }[] = [];
  let allowApplication = false;
  let blockedBackends = 0;
  await page.exposeFunction("__qaObserveFetch", (options: { cache?: RequestCache; credentials?: RequestCredentials }) => { fetchOptions.push(options); });
  await page.addInitScript(() => {
    const request = window.fetch;
    window.fetch = (input, options) => {
      void (window as typeof window & { __qaObserveFetch: (options: { cache?: RequestCache; credentials?: RequestCredentials }) => Promise<void> }).__qaObserveFetch({ cache: options?.cache, credentials: options?.credentials });
      return request(input, options);
    };
  });
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(base).origin || url.pathname.startsWith("/api/")) {
      blockedBackends++;
      return route.abort();
    }
    if (url.pathname === "/__qa_seed__") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Local QA seed</title>" });
    if (url.pathname.startsWith("/assets/")) {
      if (/\/ProductApp-[^/]+\.js$/.test(url.pathname)) {
        if (allowApplication) return route.fulfill({ contentType: "text/javascript", body: appModule('return "资源恢复成功";') });
        if (options.boundary || options.runtime) return route.fulfill({ contentType: "text/javascript", body: appModule(`throw new TypeError(${JSON.stringify(options.runtime ? "QA render failure" : "Failed to fetch dynamically imported module: /assets/ConnectedBoard-missing.js")});`) });
        return route.abort("failed");
      }
      if (!/^\/assets\/[\w.-]+$/.test(url.pathname)) return route.fulfill({ status: 404, body: "Not found" });
      const path = url.pathname === oldEntry ? entry : url.pathname;
      const body = await readFile(new URL(`.${path}`, dist));
      return route.fulfill({ contentType: path.endsWith(".css") ? "text/css" : "text/javascript", body });
    }
    if (request.isNavigationRequest()) navigations.push(url.href);
    else checks.push(url.href);
    const firstOldPage = options.oldEntry && request.isNavigationRequest() && navigations.length === 1;
    return route.fulfill({ contentType: "text/html", headers: { "cache-control": "no-cache" }, body: firstOldPage ? html.replace(entry, oldEntry) : html });
  });
  await page.context().addCookies([{ name: "qa-session", value: "mock-session-preserved", url: base }]);
  await page.goto(`${base}/__qa_seed__`);
  await page.evaluate(() => {
    sessionStorage.setItem("ypbi:data-environment:user", "test");
    sessionStorage.setItem("qa-session", "mock-session-preserved");
    localStorage.setItem("qa-preference", "preserved");
  });
  return { navigations, checks, fetchOptions, succeed: () => { allowApplication = true; }, blockedBackends: () => blockedBackends };
}

async function expectPreserved(page: Page, href: string) {
  await expect(page.locator("#root")).toHaveText("资源恢复成功");
  await expect(page).toHaveURL(href);
  expect(await page.evaluate(() => ({ environment: sessionStorage.getItem("ypbi:data-environment:user"), session: sessionStorage.getItem("qa-session"), preference: localStorage.getItem("qa-preference") }))).toEqual({ environment: "test", session: "mock-session-preserved", preference: "preserved" });
  expect((await page.context().cookies()).find(cookie => cookie.name === "qa-session")?.value).toBe("mock-session-preserved");
}

test("启动资源失败同 hash 人工恢复保留原 URL 与会话，错误页三档可操作", async ({ page }) => {
  const f = await fixture(page);
  const href = `${base}/dashboards/public?board=5.2&pid=PH&start=2020-01-01&end=2020-01-01&label=a%20b&x=1&x=2&__bi_asset_reload=business#daily`;
  await page.goto(href);
  await expect(page.getByRole("alert")).toContainText("页面资源加载失败");
  await expect.poll(() => f.checks.length).toBe(1);
  expect(f.navigations).toHaveLength(1);
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("alert")).toHaveCount(1);
    const button = page.getByRole("button", { name: "刷新页面" });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(900);
    const geometry = await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], scrollY, documentHeight: document.documentElement.scrollHeight, alerts: document.querySelectorAll('[role="alert"]').length }));
    expect(geometry.scrollY).toBe(0);
    expect(geometry.documentHeight).toBeLessThanOrEqual(900);
    console.log(`Error-page geometry ${width}: ${JSON.stringify({ ...geometry, button: box })}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/private/tmp/ypbi-asset-recovery-error-${width}.png` });
  }
  f.succeed();
  await page.getByRole("button", { name: "刷新页面" }).click();
  await expectPreserved(page, href);
  expect(f.navigations).toHaveLength(2);
  expect(f.navigations[1]).toMatch(/&__bi_asset_reload=[a-z0-9]+$/);
  expect(f.checks).toHaveLength(2);
  expect(f.fetchOptions).toEqual([{ cache: "no-store", credentials: "same-origin" }, { cache: "no-store", credentials: "same-origin" }]);
  expect(f.blockedBackends()).toBe(0);
});

test("新入口自动恢复一次后仍失败时保持冷却，点击可人工重试", async ({ page }) => {
  const f = await fixture(page, { oldEntry: true });
  const href = `${base}/admin/data-sources?pid=PH&label=a+b#sources`;
  await page.goto(href);
  await expect.poll(() => f.navigations.length).toBe(2);
  await expect(page.getByRole("alert")).toContainText("页面资源加载失败");
  await expect(page).toHaveURL(href);
  await page.waitForTimeout(350);
  expect(f.navigations).toHaveLength(2);
  expect(f.checks).toHaveLength(1);
  f.succeed();
  await page.getByRole("button", { name: "刷新页面" }).click();
  await expectPreserved(page, href);
  expect(f.navigations).toHaveLength(3);
  expect(f.checks).toHaveLength(2);
  expect(f.blockedBackends()).toBe(0);
});

test("React 错误边界与启动错误页使用同一人工恢复入口", async ({ page }) => {
  const f = await fixture(page, { boundary: true });
  const href = `${base}/dashboards/public?board=5.9&pid=PH#reading`;
  await page.goto(href);
  await expect(page.getByRole("alert")).toContainText("页面资源加载失败");
  await expect.poll(() => f.checks.length).toBe(1);
  f.succeed();
  await page.getByRole("button", { name: "刷新页面" }).click();
  await expectPreserved(page, href);
  expect(f.navigations).toHaveLength(2);
  expect(f.checks).toHaveLength(2);
  expect(f.blockedBackends()).toBe(0);
});

test("普通渲染错误不自动查版本或重试，人工刷新一次保持原 URL", async ({ page }) => {
  const f = await fixture(page, { runtime: true });
  const href = `${base}/dashboards/public?board=core&pid=PH#overview`;
  await page.goto(href);
  await expect(page.getByRole("alert")).toContainText("前端渲染发生异常");
  await page.waitForTimeout(350);
  expect(f.navigations).toHaveLength(1);
  expect(f.checks).toHaveLength(0);
  f.succeed();
  await page.getByRole("button", { name: "刷新页面" }).click();
  await expectPreserved(page, href);
  expect(f.navigations).toEqual([href.split("#")[0], href.split("#")[0]]);
  expect(f.checks).toHaveLength(0);
  expect(f.blockedBackends()).toBe(0);
});
