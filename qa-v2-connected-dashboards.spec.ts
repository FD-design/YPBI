import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { DailyDashboardSuccess } from "./contracts/daily-dashboard";
import type { DailyDashboardQuery } from "./contracts/daily-dashboard";

test.use({ channel: "chrome", viewport: { width: 1440, height: 1000 } });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
// Use the server's Bun runtime to load its generated JSON metadata without
// changing production imports for the Node-based browser test runner.
const generated = JSON.parse(execFileSync("bun", ["-e", `
  import { DailyDashboardService, dailyDashboardCatalog } from './server/v2/daily-dashboard.service';
  const catalog = dailyDashboardCatalog(true), results = {};
  const service = new DailyDashboardService({ get: async () => ({ code: 200, msg: { pageData: [], totalCount: 0 } }) });
  for (const board of catalog.data.items) if (board.metricIds.length) results[board.id] = await service.execute({ boardId: board.id, pid: 'PH', dateRange: ['2026-09-02', '2026-09-08'] });
  const periodResult = await new DailyDashboardService({ get: async () => ({ msg: { pageData: Array.from({ length: 7 }, (_, i) => ({ pid: 'PH', sumDate: '2026-09-0' + (i+2), totalVistCount: 100+i })), totalCount: 7 } }) }).execute({ boardId: '5.7', pid: 'PH', dateRange: ['2026-09-02', '2026-09-08'] });
  process.stdout.write(JSON.stringify({ catalog, results, periodResult }));
`], { encoding: "utf8" }));
const catalog = generated.catalog as { success: true; data: { items: { id: string; title: string; metricIds: string[] }[] } };
const boards = catalog.data.items;
const url = (id = "5.2", extra = "") => `${base}/dashboards/public?board=${id}&pid=PH&start=2026-09-02&end=2026-09-08${extra}`;
const card = (page: Page, name: string) => page.locator(".dashboard-metric-card").filter({ has: page.getByRole("link", { name, exact: true }) }).first();

async function fixtures(page: Page, opts: { export?: boolean; emptyEnd?: boolean; emptyCurrent?: boolean; zero?: boolean; zeroTypes?: boolean; statistics?: boolean } = {}) {
  const control = { fail: false, failPrevious: false, calls: [] as DailyDashboardQuery[] };
  await page.route("**/api/bi/v2/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path.endsWith("/auth/session")) body = { success: true, data: { user: { subjectId: "00000000-0000-4000-8000-000000000001", username: "qa.reader", displayName: "验收账号", role: "reader", permissions: ["bi:read", ...(opts.export ? ["bi:export"] : [])], pidScope: "all" }, expiresAt: "2099-01-01T00:00:00.000Z", csrfToken: "a".repeat(43), mustChangePassword: false } };
    else if (path.endsWith("/catalog/readable-dashboards")) body = catalog;
    else if (path.endsWith("/catalog/platforms")) body = { success: true, data: { items: [{ id: "HX-001", pid: "PH", name: "Pornhub", order: 1 }, { id: "HX-021", pid: "FBI", name: "小红书", order: 2 }] } };
    else if (path.endsWith("/queries/dashboards/daily-reading")) {
      const query = route.request().postDataJSON() as DailyDashboardQuery;
      control.calls.push(query);
      if (opts.statistics) return route.fulfill({ status: 200, json: generated.periodResult });
      if (control.fail || control.failPrevious && query.dateRange[1] < "2026-09-02") return route.fulfill({ status: 504, json: { success: false, error: { code: "UPSTREAM_TIMEOUT", message: "上游超时，请重试", requestId: "qa-timeout" } } });
      const count = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
      const rows = Array.from({ length: count }, (_, index) => {
        const date = new Date(Date.parse(query.dateRange[0]) + index * 86400000).toISOString().slice(0, 10), n = Number(date.slice(-2)), factor = query.pid === "FBI" ? 10 : 1;
        return {
          androidLoginUserCount:60,iosLoginUserCount:40,webLoginUserCount:8,oldUserLoginUserCount:70,
          androidNewUserCount:12,iosNewUserCount:10,webNewUserCount:6,
          androidWatchUserCount:50,iosWatchUserCount:30,webWatchUserCount:8,newUserWatchUserCount:38,oldUserWatchUserCount:50,
          natureRegisterCount:opts.zeroTypes?0:12,channelInternalRegisterCount:opts.zeroTypes?0:16,vipChargeAmt:30,goldChargeAmt:10.5,
          newUserDiamondChargeAmt:10,newUserVipChargeAmt:8,newUserGoldChargeAmt:2,
          totalVistCount:1000,totalDownCountNoDedup:100,visiCountNoDedup:1000,totalDownCountByIp:80,ipStatTotalCount:800,
          totalAllCount:10,totalSurCount:7,aliTotalCount:6,aliTotalSucCount:4,wxTotalCount:4,wxTotalSucCount:3,
          registerCount:100,"afterFirstData1.loginCnt":40,"afterFirstData3.loginCnt":30,"afterFirstData7.loginCnt":20,"afterFirstData30.loginCnt":10,
          "signInRate.raw.signed":20,adsClickedNewCount:6,adsClickedNewPerson:2,navClickedNewCount:1,navClickedNewPerson:1,newUserTotalClickedCount:7,newUserTotalClickedPerson:3,
          pid: query.pid, sumDate: date, loginUserCount: opts.zero ? 0 : (100 + n) * factor, registerUserCount: 20 + n, watchUserCount: 80 + n, totalChargeUserCount: 4, newUserChargeUserCount: 2, diamondChargeAmt: 40.5, adsCount: 20, navCount: 5, totalClickedCount: 26, adsClickedPerson: 10, navClickedPerson: 3, totalClickedPerson: 11 };
      }).filter(row => (!opts.emptyEnd || row.sumDate !== query.dateRange[1]) && (!opts.emptyCurrent || query.dateRange[1] < "2026-09-02"));
      const template = generated.results[query.boardId] as DailyDashboardSuccess;
      body = { ...template, data: { ...template.data, schemaVersion: "day-dashboard/v1", query, series: template.data.series.map(series => ({
        metric: series.metric, points: Array.from({ length: count }, (_, index) => {
          const date = new Date(Date.parse(query.dateRange[0]) + index * 86400000).toISOString().slice(0, 10);
          const row = rows.find(item => item.sumDate === date) as Record<string, unknown> | undefined;
          const inputs = series.metric.inputs.map(input => ({ key: input.key, value: row && row[input.key] != null ? Number(row[input.key]) : null }));
          const numerator = inputs[0].value, denominator = inputs[1]?.value;
          const state = !row ? "no_record" : inputs.some(input=>input.value===null) ? "no_value" : denominator === 0 ? "zero_denominator" : "available";
          return { date, inputs, state, value: state !== "available" ? null : denominator == null ? numerator : numerator! / denominator };
        })
      })) } };
    } else return route.fulfill({ status: 404, json: { success: false, error: { code: "NOT_FOUND", message: "测试中未配置接口", requestId: "qa" } } });
    return route.fulfill({ status: 200, json: body });
  });
  return control;
}

test("真实v2周期合计均值、简短日期、详情和导出同源，旧v1兼容", async ({ page }) => {
  await fixtures(page, { export: true, statistics: true });
  await page.goto(url("5.7"));
  const item = card(page, "落地页访问次数");
  await expect(item.locator("time.metric-summary__date")).toHaveText("9-8（二）");
  await expect(item.locator(".metric-summary__number strong")).toHaveText("106");
  await expect(item.locator(".metric-summary__supplementary")).toContainText("合计721");
  await expect(item.locator(".metric-summary__supplementary")).toContainText("均值103");
  await expect(item).not.toContainText("趋势对比：");
  await item.getByRole("button", { name: "查看落地页访问次数说明", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("周期统计")).toContainText("合计 721 次 · 均值 103 次");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出", exact: true }).click();
  const csv = readFileSync((await (await download).path())!, "utf8");
  expect(csv).toContain('"当前期·合计","PH","2026-09-02 至 2026-09-08","","721"');
  expect(csv).toContain('"当前期·均值","PH","2026-09-02 至 2026-09-08","","103"');
  await dialog.getByRole("button", { name: "关闭详情", exact: true }).click();
  await item.screenshot({ path: "/private/tmp/ypbi-real-period-card.png" });
  await page.unroute("**/api/bi/v2/**");
  await fixtures(page);
  await page.reload();
  await expect(item.locator(".metric-summary__number strong")).toHaveText("1,000");
  await expect(item.locator(".metric-summary__supplementary")).toHaveCount(0);
});

test("真实活跃二维只使用独立总体与单维结果，缺失交叉不补演示", async ({page}) => {
  await fixtures(page,{export:true});
  await page.goto(url("5.8"));
  const panel=page.getByRole("article",{name:"活跃结构",exact:true}), scope=panel.getByLabel("分析范围",{exact:true});
  const grouped=panel.locator(".topic-preview__group-summary");
  await expect(grouped.locator("section")).toHaveCount(4);
  await expect(grouped).toContainText("该范围待接入");
  const matrix=panel.getByRole("table",{name:"活跃结构二维交叉表",exact:true});
  expect(await matrix.getByText("该范围待接入",{exact:true}).count()).toBeGreaterThanOrEqual(4);
  await expect(matrix.getByRole("button",{name:/^Android · 新用户 · /})).toHaveCount(0);
  await scope.getByRole("radiogroup",{name:"展示方式",exact:true}).getByRole("radio",{name:"总体",exact:true}).click();
  await expect(panel.locator(".metric-summary__number strong")).toHaveText("108");
  await expect(panel.locator(".data-origin-badge")).toContainText("待验数");
  await matrix.getByRole("button",{name:/^Android · 总体 · /}).click();
  await expect(panel.locator(".metric-summary__number strong")).toHaveText("60");
  await scope.getByRole("button",{name:"恢复总体",exact:true}).click();
  await expect(panel.locator(".metric-summary__number strong")).toHaveText("108");
  expect(page.url()).not.toContain("design=");
});

test("真实二维结束日缺失保留历史与下载", async ({page}) => {
  await fixtures(page,{export:true,emptyEnd:true});await page.goto(url("5.8"));
  const panel=page.getByRole("article",{name:"活跃结构",exact:true});
  await panel.getByLabel("分析范围",{exact:true}).getByRole("radiogroup",{name:"展示方式",exact:true}).getByRole("radio",{name:"总体",exact:true}).click();
  await expect(panel.locator(".metric-summary__number strong")).toHaveText("—");
  await expect(panel.getByRole("img",{name:/逐日折线趋势/})).toBeVisible();
  await panel.getByRole("tab",{name:"表格",exact:true}).click();
  await expect(panel.getByRole("region",{name:/表格视图/})).toContainText("107");
  await panel.getByRole("button",{name:"导出活跃结构二维分析",exact:true}).first().click();
  const downloaded=page.waitForEvent("download");await page.getByRole("button",{name:"下载 XLSX",exact:true}).click();
  expect((await downloaded).suggestedFilename()).toContain("待验数");
});

for (const board of boards) test(`原版结构保留：${board.title}`, async ({ page }) => {
  await fixtures(page);
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=${board.id}`);
  await expect(page.locator(".dashboard-header h1")).toHaveText(board.title);
  const structure = () => page.locator(".dashboard-workbench__content").evaluate(root => ({
    sections: [...root.querySelectorAll(".dashboard-section-title,.dashboard-panel__title")].map(item => item.textContent!.replace(/演示数据|待验数/g, "").trim()),
    grids: [...root.querySelectorAll(".topic-preview__grid,.acquisition-preview__grid,.core-review__metric-grid")].map(item => ({ class: item.className, columns: getComputedStyle(item).gridTemplateColumns })),
    cards: [...root.querySelectorAll(".dashboard-metric-card")].map(item => ({ title: item.querySelector("header a,header .dashboard-metric-card__title-button")?.textContent, width: Math.round(item.getBoundingClientRect().width) }))
  }));
  const baseline = await structure();
  await page.goto(url(board.id));
  await expect(page.locator(".dashboard-header h1")).toHaveText(board.title);
  if (board.metricIds.length) await expect(page.locator(".data-origin-badge").filter({ hasText: "待验数" }).first()).toBeVisible();
  await expect.poll(structure).toEqual(baseline);
  await expect(page.locator(".daily-metric,.daily-dashboard__grid,vite-error-overlay")).toHaveCount(0);
  expect(page.url()).not.toContain("design=");
  if (board.id === "5.2") {
    await expect(card(page,"观影总时长").locator("header")).not.toContainText("已验数");
    await page.screenshot({ path: "/private/tmp/ypbi-connected-core.png", fullPage: false });
  }
});

test("当前值、计算输入、逐日点和真实导出共用查询", async ({ page }) => {
  const control = await fixtures(page, { export: true });
  await page.goto(url());
  await expect(card(page, "日活跃用户数").locator(".dashboard-metric-card__value")).toContainText("108");
  await card(page, "日活跃用户数").getByRole("button", { name: /当前期09-02/ }).click();
  await expect(page.getByRole("dialog")).toContainText("当前期 · 2026-09-02");
  await expect(page.getByRole("dialog")).toContainText("102 人");
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await card(page, "活跃用户观影率").getByRole("button", { name: "查看活跃用户观影率说明", exact: true }).click();
  const row = page.getByRole("dialog").locator("tbody tr").last();
  await expect(row).toContainText("88"); await expect(row).toContainText("108"); await expect(row).toContainText("81.48");
  const download = page.waitForEvent("download"); await page.getByRole("dialog").getByRole("button", { name: "导出", exact: true }).click();
  expect(readFileSync((await (await download).path())!, "utf8")).toContain('"2026-09-08","88","108"');
  expect(control.calls[0]).toEqual({ boardId: "5.2", pid: "PH", dateRange: ["2026-09-02", "2026-09-08"] });
});

test("真实周期对比、切平台、纯数值、历史返回不进入设计身份", async ({ page }) => {
  const control = await fixtures(page);
  await page.goto(url());
  await expect(card(page, "日活跃用户数")).toContainText("108");
  await page.getByRole("button", { name: "对比周期：不对比", exact: true }).click();
  await page.getByRole("option", { name: "上一等长周期", exact: true }).click();
  await page.locator(".dashboard-header").getByRole("button", { name: "应用", exact: true }).click();
  await expect(card(page, "日活跃用户数").locator(".dashboard-metric-card__comparison")).toContainText("6.93%");
  await page.getByRole("button", { name: "选择平台：Pornhub", exact: true }).click();
  await page.getByRole("option", { name: "小红书", exact: true }).click();
  await page.locator(".dashboard-header").getByRole("button", { name: "应用", exact: true }).click();
  await expect(card(page, "日活跃用户数").locator(".dashboard-metric-card__value")).toContainText("1,080");
  await page.getByRole("radio", { name: "纯数值", exact: true }).check();
  await expect(card(page, "日活跃用户数")).toHaveClass(/is-mode-value/);
  await page.goBack(); await expect(card(page, "日活跃用户数").locator(".dashboard-metric-card__value")).toContainText("108");
  expect(page.url()).not.toContain("design="); expect(control.calls.some(query => query.dateRange[1] === "2026-09-01")).toBe(true);
});

test("结束日缺失保留历史趋势与明细，真实0保持0", async ({ page }) => {
  await fixtures(page, { emptyEnd: true }); await page.goto(url("5.8"));
  const active = card(page, "日活跃用户数");
  await expect(active).toContainText("当日无记录");
  await expect(active.getByRole("region", { name: "日活跃用户数折线视图" })).toBeVisible();
  await active.getByRole("button", { name: "查看同口径数据表" }).click();
  await expect(page.getByRole("dialog")).toContainText("2026-09-07");
  await page.getByRole("dialog").getByRole("button", { name: /关闭/ }).click();
  await page.unroute("**/api/bi/v2/**"); await fixtures(page, { zero: true }); await page.goto(url());
  await expect(card(page, "日活跃用户数").locator(".dashboard-metric-card__value strong")).toHaveText("0");
});

test("失败不退回演示；刷新失败保留旧真值，重试恢复", async ({ page }) => {
  const control = await fixtures(page); control.fail = true; await page.goto(url());
  await expect(card(page, "日活跃用户数")).toContainText("暂时无法读取");
  await expect(card(page, "日活跃用户数").locator(".dashboard-metric-card__value")).toHaveCount(0);
  control.fail = false; await card(page, "日活跃用户数").getByRole("button", { name: "重试此卡" }).click();
  await expect(card(page, "日活跃用户数").locator(".dashboard-metric-card__value")).toContainText("108");
  control.fail = true; await page.getByRole("button", { name: "刷新看板", exact: true }).click();
  await expect(page.getByText("刷新失败，真实区域保留上次结果。")).toBeVisible();
  await expect(card(page, "日活跃用户数").locator(".dashboard-metric-card__value")).toContainText("108");
});

test("支付总体真分母、支付方式真实计数隔离及阅读者导出限制", async ({ page }) => {
  await fixtures(page); await page.goto(url("5.11"));
  await expect(page.locator(".payment-business__summary")).toContainText("10.13");
  const evidence = page.getByRole("table", { name: "支付方式成功率核对", exact: true });
  await expect(evidence.locator("tbody tr").first().locator("td")).toHaveText(["支付宝", "4 次", "6 次", "66.67 %", "2026-09-08", "待验数"]);
  await expect(evidence.locator("tbody tr").last().locator("td")).toHaveText(["微信", "3 次", "4 次", "75.00 %", "2026-09-08", "待验数"]);
  await page.getByRole("button", { name: "查看同口径数据表" }).first().click();
  const dialog = page.getByRole("dialog"); const overall = dialog.locator("tbody tr").first();
  await expect(overall.locator("td").last()).toContainText("108 人");
  await dialog.getByRole("button", { name: "导出拉单与充值", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载 XLSX", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "关闭导出", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /关闭/ }).click();
  await page.getByRole("radio", { name: "支付宝", exact: true }).check();
  await expect(page.locator(".payment-business__summary .data-origin-badge").filter({ hasText: "待验数" })).toHaveCount(3);
});

test("支付方式缺失日保留空输入，不用演示填补真实比率", async ({ page }) => {
  await fixtures(page, { emptyEnd: true }); await page.goto(url("5.11"));
  const evidence = page.getByRole("table", { name: "支付方式成功率核对", exact: true });
  for (const row of await evidence.locator("tbody tr").all()) {
    await expect(row.locator("td").nth(1)).toHaveText("—");
    await expect(row.locator("td").nth(2)).toHaveText("—");
    await expect(row.locator("td").nth(3)).toHaveText("—");
    await expect(row).toContainText("当日无记录");
    await expect(row).not.toContainText("演示数据");
  }
});

test("收藏和我的概览维持原工作台及本地对象，不切换假身份", async ({ page }) => {
  await fixtures(page); await page.goto(url());
  await page.getByRole("button", { name: "收藏看板", exact: true }).click();
  await expect(page.getByRole("button", { name: "我的收藏 1", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "我的概览", exact: true }).click();
  await expect(page.locator(".dashboard-workbench__directory")).toBeVisible();
  await page.getByRole("button", { name: "新建看板", exact: true }).click();
  await page.getByRole("textbox", { name: "方案名称" }).fill("联调本地看板");
  await page.getByRole("button", { name: "保存本次体验", exact: true }).click();
  await expect(page.locator(".dashboard-header h1")).toHaveText("联调本地看板");
  await expect(page.getByRole("button", { name: "账号菜单，验收账号" })).toBeVisible(); expect(page.url()).not.toContain("design=");
  await page.getByRole("button", { name: "新建指标分析", exact: true }).click();
  expect(page.url()).toContain("local=workspace"); await expect(page.locator(".personal-workspace-preview")).toBeVisible();
});

for (const width of [1280, 1024, 390]) test(`长日期和响应式保留原结构 ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 950 }); await fixtures(page);
  await page.goto(`${base}/dashboards/public?board=5.8&pid=PH&start=2025-09-08&end=2026-09-08`);
  await expect(card(page, "日活跃用户数").locator(".dashboard-metric-card__value")).toContainText("108");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  await page.getByRole("button", { name: "选择平台：Pornhub", exact: true }).click();
  await page.getByRole("option", { name: "小红书", exact: true }).click();
  await page.locator(".dashboard-header").getByRole("button", { name: "应用", exact: true }).click();
  await expect(card(page, "日活跃用户数").locator(".dashboard-metric-card__value")).toContainText("1,080");
  await page.screenshot({ path: `/private/tmp/ypbi-connected-${width}.png`, fullPage: false });
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});

test("专题刷新发出真实请求，对比期刷新失败保留标识", async ({ page }) => {
  const control = await fixtures(page); await page.goto(url("5.8", "&compare=previous"));
  const active = card(page, "日活跃用户数");
  await expect(active.locator(".dashboard-metric-card__comparison")).toContainText("6.93%");
  const before = control.calls.length; control.failPrevious = true;
  await page.getByRole("button", { name: "刷新看板", exact: true }).click();
  await expect.poll(() => control.calls.length).toBeGreaterThan(before);
  await expect(active).toContainText("对比期刷新失败");
  await expect(active.locator(".dashboard-metric-card__value")).toContainText("108");
});

test("详细图点击对比线保留对比日期，当前期全空仍显示对比趋势", async ({ page }) => {
  await fixtures(page, { emptyCurrent: true }); await page.goto(url("5.8", "&compare=previous"));
  const active = card(page, "日活跃用户数"); await expect(active).toContainText("当日无记录");
  const chart = active.getByRole("img", { name: "日活跃用户数逐日折线趋势", exact: true });
  await chart.scrollIntoViewIfNeeded();
  const point = await chart.evaluate(async el => {
    const modulePath = "/node_modules/.vite/deps/echarts_core.js";
    const { getInstanceByDom } = await import(modulePath);
    const instance = getInstanceByDom(el), option = instance.getOption();
    const seriesIndex = option.series.findIndex((series: { name: string }) => series.name === "对比期");
    const datum = option.series[seriesIndex].data[2];
    const pixel = instance.convertToPixel({ seriesIndex }, [2, typeof datum === "object" ? datum.value : datum]), rect = el.getBoundingClientRect();
    return { x: rect.left + pixel[0], y: rect.top + pixel[1] };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole("dialog")).toContainText("对比期 · 2026-08-28");
  await expect(page.getByRole("dialog")).toContainText("128 人");
});

test("空结束日紧凑卡仍可缩放，链路计算入口使用真实输入", async ({ page }) => {
  await fixtures(page, { emptyEnd: true });
  await page.goto(`${base}/dashboards/public?board=5.2&pid=PH&start=2026-08-01&end=2026-09-08`);
  const active = card(page, "日活跃用户数"); await expect(active).toContainText("当日无记录");
  await expect(active.getByRole("slider", { name: "图表起始日期" })).toBeVisible();
  await active.getByRole("slider", { name: "图表起始日期" }).focus(); await page.keyboard.press("ArrowRight");
  await expect(active.getByRole("slider", { name: "图表起始日期" })).toHaveValue("1");
  await page.locator(".core-review__chains-layout").getByRole("button", { name: "查看活跃用户观影率说明", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("日活跃用户数（人）");
  await expect(page.getByRole("dialog")).toContainText("观影用户数（人）");
});

test("真实落地诊断沿用结束日与独立参考日，详情导出不回退演示", async ({ page }) => {
  await fixtures(page, { export: true });
  await page.goto(url("5.7", "&compare=previous"));
  const panel = page.getByRole("article", { name: "落地页转化诊断", exact: true });
  const visit = panel.getByRole("article", { name: "落地页访问次数轻量诊断", exact: true });
  await expect(panel.locator(".data-origin-badge--pending")).toHaveText("待验数");
  await expect(visit.locator(".metric-summary__context")).toHaveText("9-8（二）");
  await expect(visit.locator(".metric-summary__number strong")).toHaveText("1,000");
  await expect(visit.locator(".metric-summary__comparison")).toHaveCount(2);
  await visit.getByRole("button", { name: "查看趋势与数据", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "落地页访问次数 · 完整趋势与数据", exact: true });
  await dialog.getByRole("tab", { name: "表格", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出", exact: true }).click();
  const raw = readFileSync((await (await downloading).path())!, "utf8");
  expect(raw).toContain("较前一天基准");
  expect(raw).toContain("2026-09-07");
  expect(raw).toContain("较上周同日基准");
  expect(raw).toContain("2026-09-01");
  expect(raw).not.toContain("演示数据");
  await page.keyboard.press("Escape");

  await page.unroute("**/api/bi/v2/**");
  await fixtures(page, { export: true, emptyEnd: true });
  await page.goto(url("5.7", "&compare=previous"));
  const missingVisit = page.getByRole("article", { name: "落地页访问次数轻量诊断", exact: true });
  await expect(missingVisit.locator(".metric-summary__number strong")).toHaveText("—");
  await expect(missingVisit.getByRole("status").filter({ hasText: "当日无记录" })).toBeVisible();
  await expect(missingVisit.locator(".compact-metric-reading__trend svg")).toBeVisible();
  await missingVisit.getByRole("button", { name: "查看趋势与数据", exact: true }).click();
  const missingDialog = page.getByRole("dialog", { name: "落地页访问次数 · 完整趋势与数据", exact: true });
  await expect(missingDialog.getByRole("status")).toContainText("当日无记录");
  await expect(missingDialog.getByRole("region", { name: "落地页访问次数折线视图", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.unroute("**/api/bi/v2/**");
  const failed = await fixtures(page, { export: true });
  failed.fail = true;
  await page.goto(url("5.7", "&compare=previous"));
  const failedVisit = page.getByRole("article", { name: "落地页访问次数轻量诊断", exact: true });
  await expect(failedVisit.locator(".metric-summary__number strong")).toHaveText("—");
  await expect(failedVisit.getByRole("status").filter({ hasText: "暂时无法读取" })).toBeVisible({ timeout: 15000 });
  await expect(failedVisit.locator(".data-origin-badge--demo")).toHaveCount(0);
});

test("获客来源、支付结构、签到和留存使用真实切片，混合模块标明来源",async({page})=>{
  await fixtures(page,{export:true});
  await page.goto(url("5.7"));
  await expect(card(page,"新增用户数").locator(".dashboard-metric-card__value")).toContainText("28");
  const sources=page.locator(".dashboard-panel").filter({has:page.getByRole("heading",{name:"新增来源比较",exact:true})});
  await expect(sources).toContainText("84 人");await expect(sources).toContainText("112 人");
  const typeDetail=page.locator('[data-acquisition-section="type"]');
  await expect(typeDetail).toContainText("待验数");
  await expect(typeDetail.locator("tbody")).toContainText("84");
  await expect(page.locator('[data-acquisition-section="channel"]')).toContainText("演示数据");
  await expect(page.locator('[data-acquisition-section="target"]')).toContainText("演示数据");
  await page.goto(url("5.10","&compare=previous"));
  const product=page.locator(".dashboard-panel").filter({has:page.getByRole("heading",{name:"商品与分端收入",exact:true})});
  await expect(product).toContainText("元");
  await product.getByRole("radio",{name:"按客户端",exact:true}).check();
  await expect(product.locator(".payment-breakdown__tools h3")).toContainText("演示数据");
  await expect.poll(()=>product.locator(".chart").evaluateAll(async elements=>{const path="/node_modules/.vite/deps/echarts_core.js",{getInstanceByDom}=await import(path);return elements.every(el=>getInstanceByDom(el)?.getZr().animation.isFinished());})).toBe(true);
  await page.screenshot({path:"/private/tmp/ypbi-connected-payment.png"});
  await page.goto(url("5.14"));
  await expect(card(page,"签到成功用户数").locator(".dashboard-metric-card__value")).toContainText("20");
  await page.goto(url("5.8","&compare=previous"));
  await expect(card(page,"注册用户D1留存率").locator(".dashboard-metric-card__value")).toContainText("40.00");
  const retention=page.locator(".dashboard-panel").filter({has:page.getByRole("heading",{name:"注册留存明细",exact:true})});
  await retention.scrollIntoViewIfNeeded();
  await page.screenshot({path:"/private/tmp/ypbi-connected-retention.png"});
});

test("增长三块同屏时真实获客类型的详情与局部导出保持来源隔离", async ({page}) => {
  await fixtures(page, {export:true});
  await page.goto(url("5.7", "&compare=previous"));
  const types = page.locator('[data-acquisition-section="type"]');
  await expect(types.locator(".data-origin-badge--pending")).toHaveText("待验数");
  await page.getByRole("tab", {name:"渠道结算",exact:true}).click();
  await page.getByRole("button", {name:"查看来源明细",exact:true}).click();
  await expect(types).toBeFocused();
  await expect(page.locator("[data-acquisition-section]")).toHaveCount(3);
  await expect(types.getByRole("textbox")).toHaveCount(0);
  const nature = types.getByRole("button", {name:"自然新增 · 新增用户数详情",exact:true});
  await expect(nature).toHaveText("84");
  await expect(types.getByRole("button", {name:"内部导量 · 新增用户数详情",exact:true})).toHaveText("112");
  await nature.click();
  const detail = page.getByRole("dialog", {name:"自然新增 · 新增用户数",exact:true});
  await expect(detail).toContainText("84 人"); await expect(detail).toContainText("2026-08-26 至 2026-09-01");
  await page.keyboard.press("Escape");
  await types.getByRole("button", {name:"导出获客类型",exact:true}).click();
  const exporter = page.getByRole("dialog", {name:"导出获客类型",exact:true});
  await expect(exporter).toContainText("将下载真实后台结果，标记待验数");
  const downloading = page.waitForEvent("download"); await exporter.getByRole("button", {name:"下载 XLSX",exact:true}).click();
  const download = await downloading; expect(download.suggestedFilename()).toBe("获客类型-待验数.xlsx");
  const path = "/private/tmp/ypbi-acquisition-type-live.xlsx"; await download.saveAs(path);
  const raw = readFileSync(path).toString();
  expect(raw).toContain("2026-09-02"); expect(raw).toContain("2026-08-26"); expect(raw).toContain("待验数"); expect(raw).toContain("PH"); expect(raw).not.toContain("演示数据"); expect(raw).not.toContain("来源渠道"); expect(raw).not.toContain("下载目标");
  for (const key of ["channel", "target"]) await expect(page.locator(`[data-acquisition-section="${key}"] .data-origin-badge--demo`)).toHaveText("演示数据");
});

for (const missing of [false, true]) test(`增长同屏真实类型${missing ? "缺失不补演示值" : "零值保留0"}`, async ({page}) => {
  await fixtures(page, {zeroTypes:!missing,emptyEnd:missing});
  await page.goto(url("5.7"));
  const types = page.locator('[data-acquisition-section="type"]');
  await expect(types.getByRole("button", {name:"自然新增 · 新增用户数详情",exact:true})).toHaveText(missing ? "—" : "0");
  await expect(types.getByRole("button", {name:"内部导量 · 新增用户数详情",exact:true})).toHaveText(missing ? "—" : "0");
  await expect(types).toContainText(missing ? "本期部分日期未返回" : "待验数");
  await types.getByRole("button", {name:"导出获客类型",exact:true}).click();
  await expect(page.getByRole("dialog", {name:"导出获客类型",exact:true}).getByRole("button", {name:"下载 XLSX",exact:true})).toBeDisabled();
});

test("独立注册日期读取相应批次与对比期，不覆盖主指标日期", async({page})=>{
  const control=await fixtures(page,{export:true});
  const active={start:"2026-09-02",end:"2026-09-08"},cohort={start:"2026-08-01",end:"2026-08-03"};
  await page.goto(url("5.8","&compare=previous&view="+encodeURIComponent(JSON.stringify({v:1,active,cohort,failure:active,compared:true,mixed:false}))));
  await expect(card(page,"日活跃用户数").locator(".dashboard-metric-card__value")).toContainText("108");
  const retention=page.locator(".dashboard-panel").filter({has:page.getByRole("heading",{name:"注册留存明细",exact:true})});
  await expect(retention).toContainText("注册日期 2026-08-01 至 2026-08-03");
  await expect(card(page,"注册用户D1留存率").locator(".dashboard-metric-card__value")).toContainText("40.00");
  await expect.poll(()=>control.calls.some(query=>query.dateRange.join() === "2026-08-01,2026-08-03")).toBe(true);
  await expect.poll(()=>control.calls.some(query=>query.dateRange.join() === "2026-07-29,2026-07-31")).toBe(true);
  await retention.getByRole("radio",{name:"表格",exact:true}).check();
  await expect(retention).toContainText("共 3 条");
  await expect(retention.locator("tbody")).not.toContainText("2026-09-08");
});

test("真实经营明细不混入演示来源，下载保留全部计算输入", async({page})=>{
  await fixtures(page,{export:true});
  await page.goto(url());
  const local=page.locator(".core-review__detail");
  await expect(local.getByRole("button",{name:"经营明细平台：Pornhub",exact:true})).toBeVisible();
  await expect(local.locator(".dashboard-metric-card").first().locator(".dashboard-metric-card__value")).toContainText("108");
  await expect(local.locator(".data-origin-badge--demo")).toHaveCount(0);
  await local.getByRole("button",{name:"经营明细平台：Pornhub",exact:true}).click();
  await page.getByRole("option",{name:"全部平台",exact:true}).click();
  await expect(local).toContainText("暂不支持全部平台汇总");
  await expect(local.locator(".data-origin-badge--demo")).toHaveCount(0);
  await local.getByRole("button",{name:"经营明细平台：全部平台",exact:true}).click();
  await page.getByRole("option",{name:"Pornhub",exact:true}).click();
  await local.getByRole("button",{name:"导出经营明细",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"导出经营明细",exact:true});
  await expect(dialog).toContainText("真实后台结果，标记待验数");
  const event=page.waitForEvent("download");
  await dialog.getByRole("button",{name:"下载 XLSX",exact:true}).click();
  const file=await event;
  expect(file.suggestedFilename()).toBe("经营明细-待验数.xlsx");
  const xml=readFileSync((await file.path())!,"utf8");
  for(const text of ["04_计算输入","输入指标","输入值","M081:overall","当日","昨日","上周同日","2026-09-01","108","88"])expect(xml).toContain(text);
  expect(xml).toContain("待接口支持");
  expect(xml).not.toContain("演示数据");
  expect(xml).not.toContain("小红书");
  await page.getByRole("button",{name:"导出核心经营总览",exact:true}).click();
  const realEvent=page.waitForEvent("download");
  await page.getByRole("dialog").getByRole("button",{name:"下载真实 XLSX",exact:true}).click();
  expect((await realEvent).suggestedFilename()).toBe("核心经营总览-待验数.xlsx");
});
