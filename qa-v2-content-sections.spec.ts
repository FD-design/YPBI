import { expect, test, type Locator } from "@playwright/test";

test.use({ channel: "chrome", viewport: { width: 1280, height: 1000 } });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const view = { range: { start: "2026-09-02", end: "2026-09-08" }, compared: true, mixed: false };
const metricIds = (section: Locator) => section.locator('.dashboard-metric-card > header a[href^="/analysis/metrics/"]').evaluateAll(links => links.map(link => link.getAttribute("href")!.split("/").at(-1)));

test("内容指标按视频、搜索、作者社区连续阅读，各摘要和分析只保留一份", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.13&view=${encodeURIComponent(JSON.stringify(view))}`);
  const sections = page.locator("[data-content-section]");
  await expect(sections.locator(":scope > .dashboard-section-heading > h2")).toHaveText(["视频发现与互动", "搜索需求与承接", "作者与社区"]);
  await expect(page.getByRole("heading", { name: "发现、搜索与视频互动", exact: true })).toHaveCount(0);

  const video = page.getByRole("region", { name: "视频发现与互动", exact: true });
  const search = page.getByRole("region", { name: "搜索需求与承接", exact: true });
  const community = page.getByRole("region", { name: "作者与社区", exact: true });
  expect(await metricIds(video)).toEqual(["M109", "M106", "M107", "M108", "M047", "M048"]);
  expect(await metricIds(search)).toEqual(["M092", "M093", "M046"]);
  expect(await metricIds(community)).toEqual(["M049", "M050", "M051"]);
  await expect(video.getByLabel("内容发现总体摘要", { exact: true })).toHaveCount(1);
  await expect(page.locator('.dashboard-metric-card a[href="/analysis/metrics/M044"]')).toHaveCount(0);
  await expect(video.getByRole("article", { name: "视频互动排行", exact: true })).toHaveCount(1);
  await expect(search.getByRole("article", { name: "搜索需求", exact: true })).toHaveCount(1);
  await expect(community.getByRole("article", { name: "作者与社区明细", exact: true })).toHaveCount(1);

  const videoBlocks = [
    video.getByRole("article", { name: "内容发现总体与位置", exact: true }),
    video.getByRole("region", { name: "视频点击来源", exact: true }),
    video.getByRole("region", { name: "视频首页顶部频道Tab", exact: true }),
    video.getByRole("region", { name: "视频互动", exact: true })
  ];
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const blockBounds = await Promise.all(videoBlocks.map(block => block.boundingBox()));
    for (let index = 1; index < blockBounds.length; index++) {
      expect(blockBounds[index]!.y - (blockBounds[index - 1]!.y + blockBounds[index - 1]!.height)).toBeGreaterThanOrEqual(14);
    }
    const regionBounds = await Promise.all([video, search, community].map(section => section.boundingBox()));
    expect(regionBounds[1]!.y).toBeGreaterThan(regionBounds[0]!.y + regionBounds[0]!.height);
    expect(regionBounds[2]!.y).toBeGreaterThan(regionBounds[1]!.y + regionBounds[1]!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const [name, section] of [["video", video], ["search", search], ["community", community]] as const) {
      const heading = section.locator(":scope > .dashboard-section-heading");
      await heading.evaluate(element => element.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: `/private/tmp/ypbi-content-section-${name}-${width}.png` });
    }
  }
});

test("分区后的搜索分页、视频来源筛选与社区详情分别保留状态", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.13&view=${encodeURIComponent(JSON.stringify(view))}`);
  const sources = page.getByRole("article", { name: "全局页面与列表来源", exact: true });
  const sourceSearch = sources.getByRole("textbox", { name: "搜索视频点击来源", exact: true });
  await sourceSearch.fill("暗网");
  const sourceRows = sources.getByRole("table", { name: "视频点击来源完整结果", exact: true }).locator("tbody tr");
  expect(await sourceRows.count()).toBeGreaterThan(0);
  await expect(sourceRows.first()).toContainText("暗网");

  const search = page.getByRole("article", { name: "搜索需求", exact: true });
  const searchTable = search.getByRole("table", { name: "搜索需求完整结果", exact: true });
  await expect(search.getByRole("navigation", { name: "搜索需求完整结果分页", exact: true })).toContainText("共 126 条");
  await search.getByRole("button", { name: "第 3 页", exact: true }).click();
  await expect(searchTable.locator("tbody tr")).toHaveCount(26);
  const firstSearch = await searchTable.locator("tbody tr").first().textContent();

  const community = page.getByRole("article", { name: "作者与社区明细", exact: true });
  const comments = community.getByRole("button", { name: "评论提交用户数", exact: true });
  await comments.click();
  await expect(comments).toHaveAttribute("aria-pressed", "true");
  const detailTrigger = community.getByRole("button", { name: "查看同口径数据表", exact: true });
  await detailTrigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "作者与社区明细同口径数据表", exact: true });
  await expect(dialog).toContainText("评论提交用户数");
  await expect(dialog.getByRole("button", { name: "查看趋势", exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detailTrigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(sourceSearch).toHaveValue("暗网");
  await expect(comments).toHaveAttribute("aria-pressed", "true");
  await expect(searchTable.locator("tbody tr")).toHaveCount(26);
  await expect(searchTable.locator("tbody tr").first()).toHaveText(firstSearch!);
});
