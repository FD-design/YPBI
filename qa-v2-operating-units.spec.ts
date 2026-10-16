import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dailyDashboardMatchesQuery, dailyDashboardV2SuccessSchema, type DailyDashboardQuery, type DailyDashboardV2Success } from "./contracts/daily-dashboard";
import { OPERATING_METRIC_IDS } from "./contracts/operating-detail-projection";

test.use({ channel: "chrome", viewport: { width: 1440, height: 1000 } });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("经营单位回归只允许本地隔离地址");
const bun = process.env.YPBI_BUN ?? fileURLToPath(new URL("./data/local-runtime/node_modules/.bin/bun", import.meta.url));
const date = "2026-09-08";
const generated = JSON.parse(execFileSync(bun, ["--no-env-file", "-e", `
  import { DailyDashboardService, dailyDashboardCatalog } from './server/v2/daily-dashboard.service';
  const service = new DailyDashboardService({ get: async () => ({ code: 200, msg: { pageData: [], totalCount: 0, totalData: [] } }) }, () => new Date('2026-10-14T00:00:00Z'));
  const results = {};
  for (const pid of ['PH', 'TT']) for (const start of ['2026-09-01', '2026-09-02']) {
    for (const projection of start === '2026-09-01' ? [undefined, 'operating_snapshot'] : [undefined]) {
      const query = { boardId: '5.2', pid, dateRange: [start, '2026-09-08'], ...(projection ? {projection} : {}) };
      results[JSON.stringify(query)] = await service.execute(query);
    }
  }
  process.stdout.write(JSON.stringify({ catalog: dailyDashboardCatalog(true), results }));
`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) as { catalog: { success: true; data: { items: { id: string; metricIds: string[] }[] } }; results: Record<string, DailyDashboardV2Success> };
const metricIds = generated.catalog.data.items.find(board => board.id === "5.2")!.metricIds;

async function fixtures(page: Page, conflicting = false, sliceOnly = false, statusSuite = false) {
  const calls: DailyDashboardQuery[] = [];
  await page.route("**/*", async route => {
    const address = new URL(route.request().url());
    if (address.origin !== new URL(base).origin) return route.abort("blockedbyclient");
    const path = address.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/auth/session")) return route.fulfill({ status: 200, json: { success: true, data: {
      user: { subjectId: "00000000-0000-4000-8000-000000000001", username: "qa.operating.units", displayName: "经营单位验收账号", role: "reader", permissions: ["bi:read", "bi:export"], pidScope: "all" },
      expiresAt: "2099-01-01T00:00:00Z", csrfToken: "a".repeat(43), mustChangePassword: false
    } } });
    if (path.endsWith("/data-environment")) return route.fulfill({ status: 200, json: { success: true, data: { mode: "production", testAvailable: false, expiresAt: null, userName: null } } });
    if (path.endsWith("/catalog/readable-dashboards")) return route.fulfill({ status: 200, json: generated.catalog });
    if (path.endsWith("/catalog/platforms")) return route.fulfill({ status: 200, json: { success: true, data: { items: [
      { id: "HX-001", pid: "PH", name: "Pornhub", order: 1 }, { id: "HX-002", pid: "TT", name: "TikTok", order: 2 }
    ] } } });
    if (!path.endsWith("/queries/dashboards/daily-reading")) return route.fulfill({ status: 404, json: { success: false, error: { code: "NOT_FOUND", message: "隔离验收未配置此读取", requestId: "qa-operating-units" } } });
    const query = route.request().postDataJSON() as DailyDashboardQuery;
    calls.push(query);
    if (!conflicting && !sliceOnly && query.pid === "PH") return route.fulfill({ status: 504, json: { success: false, error: { code: "V2_UPSTREAM_TIMEOUT", message: "隔离验收来源读取失败", requestId: "qa-primary-failed" } } });
    const result = structuredClone(generated.results[JSON.stringify(query)]);
    if (!result) throw new Error(`隔离验收未登记查询范围：${JSON.stringify(query)}`);
    const amount = result.data.series.find(series => series.metric.id === "M058")!;
    const amountValue = conflicting ? query.pid === "TT" ? 5 : 0 : 24;
    const unit = conflicting && query.pid === "TT" ? "USD" : "元";
    amount.metric.unit = unit;
    amount.metric.inputs.forEach(input => { input.unit = unit; });
    amount.points.forEach(point => Object.assign(point, { state: "available", sourceStatus: "READY", value: amountValue, inputs: amount.metric.inputs.map(input => ({ key: input.key, value: amountValue })) }));
    if (!query.projection) amount.periodStatistics = { ...amount.periodStatistics, state: "available", reason: null, values: [{ kind: "period_sum", value: amountValue * amount.points.length }, { kind: "daily_average", value: amountValue }] };
    const people = result.data.series.find(series => series.metric.id === "M059")!;
    people.points.forEach(point => Object.assign(point, { state: "available", sourceStatus: "READY", value: 0, inputs: people.metric.inputs.map(input => ({ key: input.key, value: 0 })) }));
    if (!query.projection) people.periodStatistics = { ...people.periodStatistics, state: "available", reason: null, values: [{ kind: "daily_average", value: 0 }] };
    const processing = result.data.series.find(series => series.metric.id === "M058.new")!;
    processing.points.forEach(point => Object.assign(point, { state: "no_value", sourceStatus: "PROCESSING", value: null, inputs: processing.metric.inputs.map(input => ({ key: input.key, value: null })) }));
    if (sliceOnly) {
      amount.metric.unit = "币种未确认";
      amount.points.forEach(point => Object.assign(point, { state: "no_value", sourceStatus: "PROCESSING", value: null,
        inputs: amount.metric.inputs.map(input => ({ key: input.key, value: null })) }));
      if (!query.projection) amount.periodStatistics = { ...amount.periodStatistics, state: "incomplete", values: [], reason: "隔离验收总体尚未就绪" };
      processing.metric.unit = "元";
      processing.metric.inputs.forEach(input => { input.unit = "元"; });
      processing.points.forEach(point => Object.assign(point, { state: "available", sourceStatus: "READY", value: 24,
        inputs: processing.metric.inputs.map(input => ({ key: input.key, value: 24 })) }));
    }
    const retention = result.data.series.find(series => series.metric.id === "M020.natural")!;
    retention.points.forEach(point => Object.assign(point, { state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: retention.metric.inputs.map((input, i) => ({ key: input.key, value: i === 0 ? 1 : 2 })) }));
    if (statusSuite) {
      for (const [id, state, sourceStatus] of [
        ["M058.nature", "no_value", "SOURCE_INCOMPLETE"], ["M058.internal", "source_failure", "FAILED"],
        ["M086", "no_record", undefined], ["M067", "zero_denominator", "READY"]
      ] as const) {
        const target = result.data.series.find(series => series.metric.id === id)!;
        target.points.forEach(point => {
          delete point.sourceStatus;
          Object.assign(point, { state, ...(sourceStatus ? { sourceStatus } : {}), value: null,
            inputs: target.metric.inputs.map(input => ({ key: input.key, value: state === "zero_denominator" ? 0 : null })) });
        });
      }
      const monthly = result.data.series.find(series => series.metric.id === "M018")!;
      const point = monthly.points.find(point => point.date === date)!;
      Object.assign(point, { state: "available", sourceStatus: "READY", value: 0,
        inputs: monthly.metric.inputs.map(input => ({ key: input.key, value: 0 })),
        monthlyMetadata: { month: "2026-09", cutoffDate: "2026-09-30", isComplete: true } });
    }
    dailyDashboardV2SuccessSchema.parse(result);
    expect(dailyDashboardMatchesQuery(result, query, query.projection ? OPERATING_METRIC_IDS : metricIds)).toBe(true);
    return route.fulfill({ status: 200, json: result });
  });
  return calls;
}

type Cell = string | number | null;
function readSheet(buffer: Buffer, name: string): Cell[][] {
  const entries = new Map<string, string>();
  for (let offset = 0; offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50;) {
    expect(buffer.readUInt16LE(offset + 8)).toBe(0);
    const length = buffer.readUInt32LE(offset + 18), nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    entries.set(buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"), buffer.subarray(start, start + length).toString("utf8"));
    offset = start + length;
  }
  const workbook = entries.get("xl/workbook.xml")!;
  const id = [...workbook.matchAll(/<sheet name="([^"]+)" sheetId="(\d+)"/g)].find(match => match[1] === name)?.[2];
  expect(id, `缺少工作表 ${name}`).toBeTruthy();
  const xml = entries.get(`xl/worksheets/sheet${id}.xml`)!;
  return [...xml.matchAll(/<row r="\d+">(.*?)<\/row>/gs)].map(match => [...match[1].matchAll(/<c r="[A-Z]+\d+"(?: t="[^"]+")?(?:\/>|>(.*?)<\/c>)/gs)].map(cell => {
    const numeric = cell[1]?.match(/<v>(.*?)<\/v>/s);
    if (numeric) return Number(numeric[1]);
    const text = cell[1]?.match(/<t(?: [^>]*)?>(.*?)<\/t>/s)?.[1];
    return text === undefined ? null : text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }));
}

const local = (page: Page) => page.locator(".core-review__detail");
const row = (page: Page, name: string) => local(page).locator(".core-review__comparison-table tbody tr").filter({ hasText: name });
const cell = (page: Page, name: string, key: string) => row(page, name).locator(`td[data-column-key="${key}"] .core-review__detail-trigger > b`);
async function choosePlatform(page: Page, name: string) {
  await local(page).getByRole("button", { name: /^经营明细平台：/ }).click();
  await page.getByRole("option", { name, exact: true }).click();
}
async function download(page: Page) {
  await local(page).getByRole("button", { name: "导出经营明细", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出经营明细", exact: true });
  const completed = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载 XLSX", exact: true }).click();
  const file = await completed;
  expect(file.suggestedFilename()).toBe("经营明细-待验数.xlsx");
  return readSheet(readFileSync((await file.path())!), "01_经营明细");
}
const url = `${base}/dashboards/public?board=5.2&pid=PH&start=2026-09-02&end=${date}`;

test("主PID与独立资源失败时，成功平台页面和真实XLSX保留金额单位、0和非READY状态", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const calls = await fixtures(page);
  await page.goto(url);
  await expect(local(page).locator(".core-review__comparison-table tbody tr")).toHaveCount(2);
  await expect(cell(page, "Pornhub", "M058:overall")).toHaveText("读取失败");
  await expect(cell(page, "TikTok", "M058:overall")).toHaveText("24");
  await expect(local(page).locator('th[data-column-key="M058:overall"] .metric-heading-unit')).toHaveText("（元）");
  await expect(cell(page, "TikTok", "M059:overall")).toHaveText("0");
  await expect(cell(page, "TikTok", "M058:新用户")).toHaveText("计算中");
  await expect(cell(page, "TikTok", "M020:自然新增")).toHaveText("50.00%");
  await expect(row(page, "TikTok").locator('td[data-column-key="M020:自然新增"]')).toContainText("部分数据，仅供参考");
  const sheet = await download(page), amount = sheet[0].indexOf("总充值金额｜当日（元）"), tt = sheet.find(values => values[2] === "TT")!, ph = sheet.find(values => values[2] === "PH")!;
  expect(amount).toBeGreaterThan(2);
  expect(tt[amount]).toBe(24); expect(typeof tt[amount]).toBe("number"); expect(ph[amount]).toBeNull();
  const names = generated.results[JSON.stringify({ boardId: "5.2", pid: "TT", dateRange: ["2026-09-01", date] })].data.series;
  expect(tt[sheet[0].indexOf(`${names.find(series => series.metric.id === "M059")!.metric.name}｜当日（人）`)]).toBe(0);
  const processing = sheet[0].indexOf("总充值金额（新用户）｜当日（元）");
  expect(processing).toBeGreaterThan(2); expect(tt[processing]).toBeNull(); expect(tt[processing + 1]).toContain("计算中");
  const retention = sheet[0].indexOf("注册用户D1留存率（自然新增）｜当日（%）");
  expect(retention).toBeGreaterThan(2); expect(tt[retention]).toBeNull();
  expect(tt[sheet[0].indexOf("注册用户D1留存率（自然新增）｜当日参考比率（%）")]).toBe(50);
  expect(calls.filter(query => query.pid === "PH").map(query => query.dateRange[0])).toEqual(expect.arrayContaining(["2026-09-01", "2026-09-02"]));
  await cell(page, "TikTok", "M058:overall").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("primary-failed-success-unit.png") });
  expect(errors).toEqual([]);
});

test("全部平台金额单位冲突关闭数值与XLSX，单PID选择恢复自己的单位和数值", async ({ page }, info) => {
  await fixtures(page, true); await page.goto(url);
  await expect(cell(page, "Pornhub", "M058:overall")).toHaveText("单位不一致");
  await expect(cell(page, "TikTok", "M058:overall")).toHaveText("单位不一致");
  await expect(local(page).locator('th[data-column-key="M058:overall"] .metric-heading-unit')).toHaveCount(0);
  const all = await download(page), amount = all[0].indexOf("总充值金额｜当日（）");
  expect(amount).toBeGreaterThan(2);
  expect(all.slice(1).map(values => values[amount])).toEqual([null, null]);
  expect(all.slice(1).every(values => String(values[amount + 1]).includes("单位不一致"))).toBe(true);
  await choosePlatform(page, "TikTok");
  await expect(local(page).locator(".core-review__comparison-table tbody tr")).toHaveCount(1);
  await expect(cell(page, "TikTok", "M058:overall")).toHaveText("$5");
  await expect(local(page).locator('th[data-column-key="M058:overall"] .metric-heading-unit')).toHaveText("（USD）");
  const single = await download(page), singleAmount = single[0].indexOf("总充值金额｜当日（USD）");
  expect(single).toHaveLength(2); expect(single[1][2]).toBe("TT"); expect(single[1][singleAmount]).toBe(5);
  await choosePlatform(page, "Pornhub");
  await expect(cell(page, "Pornhub", "M058:overall")).toHaveText("0");
  await expect(local(page).locator('th[data-column-key="M058:overall"] .metric-heading-unit')).toHaveText("（元）");
  await choosePlatform(page, "全部平台");
  await expect(cell(page, "TikTok", "M058:overall")).toHaveText("单位不一致");
  await cell(page, "TikTok", "M058:overall").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("mixed-units-protected.png") });
});

test("总体金额未就绪时，单PID新用户拆分详情和真实XLSX仍显示24元", async ({ page }, info) => {
  await fixtures(page, false, true); await page.goto(url);
  await expect(cell(page, "TikTok", "M058:overall")).toHaveText("计算中");
  await expect(cell(page, "TikTok", "M058:新用户")).toHaveText("24");
  await choosePlatform(page, "TikTok");
  await local(page).getByRole("button", { name: /^总充值金额，按/ }).click();
  const detail = page.getByRole("dialog", { name: "总充值金额 · 维度拆解", exact: true });
  await expect(detail.locator(".metric-breakdown__summary")).toContainText("计算中");
  const newUser = detail.locator(".metric-breakdown__row").filter({ hasText: "新用户" });
  await expect(newUser.locator("b")).toHaveText("24");
  await expect(newUser.locator("small")).toHaveText("元");
  await page.screenshot({ path: info.outputPath("partial-amount-slice-unit.png") });
  await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
  const sheet = await download(page), amount = sheet[0].indexOf("总充值金额（新用户）｜当日（元）");
  expect(amount).toBeGreaterThan(2);
  expect(sheet).toHaveLength(2);
  expect(sheet[1][2]).toBe("TT");
  expect(sheet[1][amount]).toBe(24);
});

test("新版来源状态分别展示，月活保留0与实际截至，93列和实际导出一致", async ({ page }, info) => {
  await fixtures(page, false, false, true); await page.goto(url);
  await expect(local(page).locator('thead th[data-column-key]')).toHaveCount(93);
  for (const [key, label] of Object.entries({ "M058:新用户": "计算中", "M058:自然新增": "来源不完整",
    "M058:内部导量": "加工失败", "M086:overall": "当日未返回记录", "M067:overall": "分母为0",
    "M018:overall": "0", "M059:overall": "0" })) {
    await expect(cell(page, "TikTok", key)).toHaveText(label);
  }
  await expect(cell(page, "Pornhub", "M058:overall")).toHaveText("读取失败");
  const monthly = row(page, "TikTok").locator('td[data-column-key="M018:overall"] button');
  await expect(monthly).toHaveAttribute("aria-label", /统计截至 2026-09-30（含当天）/);
  await expect(monthly).toHaveAttribute("aria-label", /月份状态：已结束/);
  const sheet = await download(page), tt = sheet.find(values => values[2] === "TT")!;
  for (const [heading, label] of Object.entries({ "总充值金额（自然新增）｜当日（元）": "来源不完整",
    "总充值金额（内部导量）｜当日（元）": "加工失败", "充值到账订单数｜当日（单）": "当日未返回记录" })) {
    const index = sheet[0].indexOf(heading); expect(index).toBeGreaterThan(2);
    expect(tt[index]).toBeNull(); expect(tt[index + 1]).toContain(label);
  }
  await monthly.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("backend-aligned-states-monthly.png") });
});
