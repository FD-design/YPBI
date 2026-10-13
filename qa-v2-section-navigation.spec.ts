import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { DailyDashboardCatalog, DailyDashboardQuery, DailyDashboardSuccess } from "./contracts/daily-dashboard";

test.use({ channel: "chrome", viewport: { width: 1280, height: 950 }, contextOptions: { reducedMotion: "reduce" } });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("区块导航回归只允许本地隔离地址");

// Metadata comes from the existing service; all upstream reads return in-memory
// empty records. Browser responses below are synthetic, pending-validation data.
const generated = JSON.parse(execFileSync(process.env.YPBI_BUN ?? "bun", ["--no-env-file", "-e", `
  import { DailyDashboardService, dailyDashboardCatalog } from './server/v2/daily-dashboard.service';
  const catalog = dailyDashboardCatalog(true), results = {};
  const service = new DailyDashboardService({ get: async () => ({ code: 200, msg: { pageData: [], totalCount: 0 } }) });
  for (const board of catalog.data.items) if (board.metricIds.length) results[board.id] = await service.execute({ boardId: board.id, pid: 'PH', dateRange: ['2026-09-02', '2026-09-08'] });
  process.stdout.write(JSON.stringify({ catalog, results }));
`], { encoding: "utf8" })) as { catalog: { success: true; data: DailyDashboardCatalog }; results: Record<string, DailyDashboardSuccess> };
const boards = generated.catalog.data.items;
const url = (board = "5.2") => `${base}/dashboards/public?board=${board}&pid=PH&start=2026-09-02&end=2026-09-08`;
const navigation = (page: Page) => page.getByRole("navigation", { name: "本页区块", exact: true });
const content = (page: Page) => page.locator(".dashboard-workbench__content .v2-page").first();
const coreTitles = ["主结果", "效率与留存", "关键业务链路与质量", "广告点击表现", "经营明细"];

async function isolate(page: Page) {
  const control = { queries: [] as DailyDashboardQuery[], apiRequests: [] as string[] };
  await page.route("**/*", async route => {
    const request = route.request(), address = new URL(request.url());
    if (address.origin !== new URL(base).origin) return route.abort("blockedbyclient");
    if (!address.pathname.startsWith("/api/")) return route.continue();
    control.apiRequests.push(address.pathname);
    let body: unknown;
    if (address.pathname.endsWith("/auth/session")) body = { success: true, data: {
      user: { subjectId: "00000000-0000-4000-8000-000000000001", username: "qa.section.reader", displayName: "隔离导航验收", role: "reader", permissions: ["bi:read", "bi:export"], pidScope: "all" },
      expiresAt: "2099-01-01T00:00:00.000Z", csrfToken: "a".repeat(43), mustChangePassword: false
    } };
    else if (address.pathname.endsWith("/catalog/readable-dashboards")) body = generated.catalog;
    else if (address.pathname.endsWith("/catalog/platforms")) body = { success: true, data: { items: [{ id: "HX-001", pid: "PH", name: "Pornhub", order: 1 }] } };
    else if (address.pathname.endsWith("/queries/dashboards/daily-reading")) {
      const query = request.postDataJSON() as DailyDashboardQuery;
      control.queries.push(query);
      const template = generated.results[query.boardId];
      if (!template) throw new Error(`隔离样例不存在：${query.boardId}`);
      const count = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
      const { acquisitionGroups: _acquisition, playbackGroups: _playback, ...metadata } = template.data as DailyDashboardSuccess["data"] & { acquisitionGroups?: unknown; playbackGroups?: unknown };
      body = { ...template, data: { ...metadata, schemaVersion: "day-dashboard/v1", query,
        series: template.data.series.map(series => ({ metric: series.metric, points: Array.from({ length: count }, (_, index) => {
          const date = new Date(Date.parse(query.dateRange[0]) + index * 86400000).toISOString().slice(0, 10);
          const diagnostic = series.metric.id.startsWith("M020.");
          const inputs = series.metric.inputs.map((input, inputIndex) => ({ key: input.key, value: inputIndex ? 300 + index : 120 + index }));
          return { date, inputs, sourceStatus: diagnostic ? "SOURCE_INCOMPLETE" : "READY", state: diagnostic ? "no_value" : "available",
            value: diagnostic ? null : inputs.length === 1 ? inputs[0].value : inputs[0].value / inputs[1].value };
        }) }))
      } };
    } else return route.fulfill({ status: 404, json: { success: false, error: { code: "NOT_FOUND", message: "隔离测试未配置此接口", requestId: "qa-section" } } });
    await route.fulfill({ status: 200, json: body });
  });
  return control;
}

async function ready(page: Page, board = "5.2") {
  await page.goto(url(board));
  await expect(content(page).locator(".dashboard-header h1")).toHaveText(boards.find(item => item.id === board)!.title);
  await page.waitForLoadState("networkidle");
}

// Read semantic outer sections from the page, not a second board/metric table.
async function primaryTitles(page: Page) {
  return content(page).evaluate(root => {
    const visible = [...root.querySelectorAll<HTMLElement>(".dashboard-section-title,.dashboard-panel__title")].filter(heading => {
      if (heading.closest('.dashboard-metric-card,dialog,[role="dialog"],[hidden],[inert],[aria-hidden="true"],details:not([open])')) return false;
      const rectangle = heading.getBoundingClientRect();
      return rectangle.width > 0 && rectangle.height > 0 && getComputedStyle(heading).visibility === "visible";
    });
    const owners = visible.map(heading => heading.closest("section,article") ?? heading.parentElement ?? heading);
    return visible.filter((_heading, index) => !owners.some((owner, other) => other !== index && (owner !== owners[index] && owner.contains(owners[index]) || owner === owners[index] && other < index)))
      .map(heading => heading.textContent!.replace(/\s+/g, " ").trim());
  });
}

async function assertFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const nav = navigation(page);
  if (!await nav.count()) return;
  expect(await nav.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  for (const button of await nav.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
}

async function readingSnapshot(page: Page) {
  return content(page).evaluate(root => ({
    columns: [...root.querySelectorAll("th[data-column-key]")].map(cell => ({ key: cell.getAttribute("data-column-key"), text: cell.textContent })),
    cells: [...root.querySelectorAll(".core-review__detail tbody td")].map(cell => cell.textContent),
    badges: [...root.querySelectorAll(".data-origin-badge")].map(badge => badge.textContent),
    exports: [...root.querySelectorAll<HTMLButtonElement>("button")].filter(button => `${button.getAttribute("aria-label") ?? ""}${button.textContent}`.includes("导出"))
      .map(button => ({ name: button.getAttribute("aria-label") ?? button.textContent, disabled: button.disabled }))
  }));
}

async function assertReached(heading: Locator) {
  await expect(heading).toBeFocused();
  await expect.poll(() => heading.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + Math.min(box.width / 2, 40), box.top + box.height / 2);
    return box.top >= 0 && box.bottom <= innerHeight && Boolean(hit && (hit === element || element.contains(hit)));
  })).toBe(true);
}

for (const board of boards) for (const width of [1280, 1024, 390]) test(`页内区块来自可见主标题：${board.title} · ${width}`, async ({ page }) => {
  expect(boards).toHaveLength(11);
  await page.setViewportSize({ width, height: 950 });
  const control = await isolate(page);
  await ready(page, board.id);
  const titles = await primaryTitles(page), nav = navigation(page);
  if (titles.length < 3) await expect(nav).toHaveCount(0);
  else {
    await expect(nav).toBeVisible();
    expect(new Set(titles).size).toBe(titles.length);
    const beforeUrl = page.url(), beforeQueries = control.queries.length, beforeRequests = control.apiRequests.length, beforeReading = await readingSnapshot(page);
    const heading = content(page).getByRole("heading", { name: titles.at(-1)!, exact: true });
    if (width < 768) {
      await nav.getByRole("button", { name: /^定位区块：/ }).click();
      const listbox = page.getByRole("listbox", { name: "定位区块", exact: true });
      await expect(listbox.getByRole("option")).toHaveText(titles);
      const box = await listbox.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      await listbox.getByRole("option", { name: titles.at(-1)!, exact: true }).click();
      await expect(listbox).toHaveCount(0);
    } else {
      await expect(nav.getByRole("button")).toHaveText(titles);
      await nav.getByRole("button", { name: titles.at(-1)!, exact: true }).click();
    }
    await assertReached(heading);
    expect(page.url()).toBe(beforeUrl);
    expect(control.queries).toHaveLength(beforeQueries);
    expect(control.apiRequests).toHaveLength(beforeRequests);
    expect(await readingSnapshot(page)).toEqual(beforeReading);
  }
  await assertFits(page);
});

for (const width of [1280, 1024, 390]) test(`核心五区块只滚动，93列与来源状态不变：${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 950 });
  const control = await isolate(page);
  await ready(page);
  const nav = navigation(page);
  await expect.poll(() => primaryTitles(page)).toEqual(coreTitles);
  const before = await readingSnapshot(page), beforeUrl = page.url(), beforeQueries = control.queries.length, beforeRequests = control.apiRequests.length;
  expect(before.columns).toHaveLength(93);
  expect(new Set(before.columns.map(column => column.key)).size).toBe(93);
  expect(before.badges.some(text => text?.includes("待验数"))).toBe(true);
  expect(before.cells.some(text => text?.includes("部分数据，仅供参考"))).toBe(true);
  await assertFits(page);
  if (width === 1280) await page.screenshot({ path: "outputs/20261013-bi-section-navigation/core-1280.png", fullPage: false });
  if (width < 768) {
    const menu = nav.getByRole("button", { name: /^定位区块：/ });
    await menu.click();
    const listbox = page.getByRole("listbox", { name: "定位区块", exact: true });
    await expect(listbox.getByRole("option")).toHaveText(coreTitles);
    await page.screenshot({ path: "outputs/20261013-bi-section-navigation/core-menu-390.png", fullPage: false });
    const last = listbox.getByRole("option", { name: "经营明细", exact: true });
    await last.focus();
    await last.press("Enter");
    await expect(listbox).toHaveCount(0);
  } else {
    await expect(nav.getByRole("button")).toHaveText(coreTitles);
    const last = nav.getByRole("button", { name: "经营明细", exact: true });
    await last.focus();
    await last.press("Enter");
  }
  await assertReached(content(page).getByRole("heading", { name: "经营明细", exact: true }));
  if (width === 390) await page.screenshot({ path: "outputs/20261013-bi-section-navigation/core-target-390.png", fullPage: false });
  expect(page.url()).toBe(beforeUrl);
  expect(control.queries).toHaveLength(beforeQueries);
  expect(control.apiRequests).toHaveLength(beforeRequests);
  expect(await readingSnapshot(page)).toEqual(before);
  await assertFits(page);
});

test("隐藏details和嵌套标题不进入导航；短页不出现导航", async ({ page }) => {
  const control = await isolate(page);
  await ready(page);
  const beforeUrl = page.url(), beforeQueries = control.queries.length;
  await content(page).evaluate(root => {
    const closed = document.createElement("details");
    closed.innerHTML = '<summary>隔离反例</summary><section><h2 class="dashboard-section-title">隐藏明细反例</h2></section>';
    root.append(closed);
    const nested = document.createElement("article");
    nested.innerHTML = '<h2 class="dashboard-panel__title">嵌套标题反例</h2>';
    root.querySelector("#core-main-results")!.closest("section")!.append(nested);
    return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(navigation(page).getByRole("button")).toHaveText(coreTitles);
  await expect(navigation(page).getByRole("button", { name: /隐藏明细反例|嵌套标题反例/ })).toHaveCount(0);
  expect(page.url()).toBe(beforeUrl);
  expect(control.queries).toHaveLength(beforeQueries);
  await ready(page, "5.15");
  await expect.poll(() => primaryTitles(page)).toEqual(["启动诊断", "版本表现"]);
  await expect(navigation(page)).toHaveCount(0);
});

test("切看板和历史返回清理旧导航、焦点与延迟滚动", async ({ page }) => {
  await isolate(page);
  await ready(page);
  await navigation(page).getByRole("button", { name: "经营明细", exact: true }).click();
  await assertReached(content(page).getByRole("heading", { name: "经营明细", exact: true }));
  await page.getByRole("searchbox", { name: "搜索看板", exact: true }).fill(boards.find(board => board.id === "5.7")!.title);
  const nextBoard = page.getByRole("navigation", { name: "公共看板列表", exact: true }).getByRole("link", { name: boards.find(board => board.id === "5.7")!.title, exact: true });
  await expect(nextBoard).toBeVisible();
  // Schedule a jump and immediately leave in the same task, before its two
  // animation frames run. The next board must own the remaining focus/scroll.
  await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="本页区块"]')!;
    [...nav.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "经营明细")!.click();
    document.querySelector<HTMLAnchorElement>('.dashboard-directory__item[href*="board=5.7"]')!.click();
  });
  await expect(content(page).locator(".dashboard-header h1")).toHaveText(boards.find(board => board.id === "5.7")!.title);
  await page.waitForLoadState("networkidle");
  await expect.poll(async () => navigation(page).getByRole("button").allTextContents()).toEqual(await primaryTitles(page));
  await expect(navigation(page).getByRole("button", { name: "经营明细", exact: true })).toHaveCount(0);
  await expect(content(page).locator('.dashboard-section-title[tabindex="-1"],.dashboard-panel__title[tabindex="-1"]')).toHaveCount(0);
  await page.goBack();
  await expect(content(page).locator(".dashboard-header h1")).toHaveText(boards.find(board => board.id === "5.2")!.title);
  await expect(navigation(page).getByRole("button")).toHaveText(coreTitles);
  await expect(content(page).locator("#core-operating-detail")).not.toHaveAttribute("tabindex", "-1");
  await navigation(page).getByRole("button", { name: "主结果", exact: true }).click();
  await assertReached(content(page).getByRole("heading", { name: "主结果", exact: true }));
});

test("跳转前后经营导出文件与93列表头逐字节一致", async ({ page }) => {
  const control = await isolate(page);
  await ready(page);
  const download = async () => {
    await content(page).getByRole("button", { name: "导出经营明细", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "导出经营明细", exact: true });
    await expect(dialog).toContainText("真实后台结果，标记待验数");
    const pending = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "下载 XLSX", exact: true }).click();
    const file = await pending;
    return { name: file.suggestedFilename(), bytes: readFileSync((await file.path())!) };
  };
  const before = await download(), columns = (await readingSnapshot(page)).columns, count = control.queries.length, address = page.url();
  expect(before.name).toBe("经营明细-待验数.xlsx");
  expect(columns).toHaveLength(93);
  await navigation(page).getByRole("button", { name: "经营明细", exact: true }).click();
  await assertReached(content(page).getByRole("heading", { name: "经营明细", exact: true }));
  const after = await download();
  expect(after.name).toBe(before.name);
  expect(after.bytes.equals(before.bytes)).toBe(true);
  expect((await readingSnapshot(page)).columns).toEqual(columns);
  expect(control.queries).toHaveLength(count);
  expect(page.url()).toBe(address);
});
