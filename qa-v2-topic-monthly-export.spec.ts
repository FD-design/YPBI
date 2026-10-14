import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { DailyDashboardCatalog, DailyDashboardQuery, DailyDashboardSuccess } from "./contracts/daily-dashboard";

test.use({ channel: "chrome", viewport: { width: 1440, height: 1000 } });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("月活导出回归只允许本地隔离地址");
const subjectId = "00000000-0000-4000-8000-000000000001";
const historicalRange: [string, string] = ["2019-12-29", "2020-03-03"];
const currentRange: [string, string] = ["2026-10-03", "2026-10-06"];

// The actual service supplies the mapping and monthly anchors from memory only.
const generated = JSON.parse(execFileSync(process.env.YPBI_BUN ?? "bun", ["--no-env-file", "-e", `
  import { DailyDashboardService, dailyDashboardCatalog } from './server/v2/daily-dashboard.service';
  const fetchedAt = '2026-10-12T00:00:00Z';
  const values = {'2019-12':0,'2020-01':42,'2020-02':null,'2020-03':7,'2026-10':12};
  const results = {};
  for (const dateRange of [['2019-12-29','2020-03-03'],['2026-10-03','2026-10-06']]) {
    const service = new DailyDashboardService({get:async(path,params)=>{
      if(path !== '/api/admin/bi/v1/metrics') return {code:200,msg:{pageData:[],totalData:[],totalCount:0},data:[]};
      const dimensions = JSON.parse(params.dimensionFilters ?? '{}');
      const monthly = params.metricCodes === 'M018';
      let rows = [];
      if(monthly) {
        const value = values[params.startDate.slice(0,7)];
        if(value !== null && value !== undefined) rows = [{metricCode:'M018',dimensions:{pid:'PH'},value,numerator:value,denominator:0,unit:'count',dataStatus:'READY',metricVersion:'bi-v1',ruleVersion:'qa-monthly-v1'}];
      } else if(!Object.keys(dimensions).length && params.metricCodes.split(',').includes('M016')) {
        for(let date = params.startDate, index = 0; date < params.endDate; index++) {
          const value = 100 + index;
          rows.push({metricCode:'M016',businessDate:date,dimensions:{pid:'PH'},value,numerator:value,denominator:0,unit:'count',dataStatus:'READY',metricVersion:'bi-v1',ruleVersion:'qa-daily-v1'});
          date = new Date(Date.parse(date) + 86400000).toISOString().slice(0,10);
        }
      }
      return {code:200,msg:{metricVersion:'bi-v1',generatedAt:fetchedAt,watermark:null,rows}};
    }},()=>new Date(fetchedAt));
    results[dateRange.join(',')] = await service.execute({boardId:'5.8',pid:'PH',dateRange});
  }
  process.stdout.write(JSON.stringify({catalog:dailyDashboardCatalog(true),results}));
`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })) as {
  catalog: { success: true; data: DailyDashboardCatalog };
  results: Record<string, DailyDashboardSuccess>;
};

async function fixtures(page: Page, environment: "test" | "production") {
  const calls: { query: DailyDashboardQuery; environment?: string }[] = [];
  await page.addInitScript(({ subjectId, environment }) => {
    if (environment === "test") sessionStorage.setItem(`ypbi.data-environment.v1:${subjectId}`, "test");
  }, { subjectId, environment });
  await page.route("**/*", async route => {
    const address = new URL(route.request().url());
    if (address.origin !== new URL(base).origin) return route.abort("blockedbyclient");
    const path = address.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/auth/session")) return route.fulfill({ json: { success: true, data: {
      user: { subjectId, username: "qa.reader", displayName: "隔离验收账号", role: "reader", permissions: ["bi:read", "bi:export"], pidScope: "all" },
      expiresAt: "2099-01-01T00:00:00.000Z", csrfToken: "a".repeat(43), mustChangePassword: false
    } } });
    if (path.endsWith("/catalog/readable-dashboards")) return route.fulfill({ json: generated.catalog });
    if (path.endsWith("/catalog/platforms")) return route.fulfill({ json: { success: true, data: { items: [{ id: "HX-001", pid: "PH", name: "Pornhub", order: 1 }] } } });
    if (path.endsWith("/queries/dashboards/daily-reading")) {
      const query = route.request().postDataJSON() as DailyDashboardQuery;
      calls.push({ query, environment: route.request().headers()["x-ypbi-data-environment"] });
      const result = generated.results[query.dateRange.join(",")];
      expect(query.boardId).toBe("5.8");
      expect(query.pid).toBe("PH");
      expect(result).toBeDefined();
      return route.fulfill({ json: result });
    }
    return route.fulfill({ status: 404, json: { success: false, error: { code: "NOT_FOUND", message: "隔离夹具未配置接口", requestId: "qa-monthly-export" } } });
  });
  return calls;
}

function workbookTextFiles(bytes: Uint8Array) {
  const files: Record<string, string> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let cursor = 0;
  while (view.getUint32(cursor, true) === 0x04034b50) {
    expect(view.getUint16(cursor + 8, true)).toBe(0);
    const dataSize = view.getUint32(cursor + 18, true), nameSize = view.getUint16(cursor + 26, true), extraSize = view.getUint16(cursor + 28, true);
    const name = decoder.decode(bytes.subarray(cursor + 30, cursor + 30 + nameSize));
    const dataStart = cursor + 30 + nameSize + extraSize;
    files[name] = decoder.decode(bytes.subarray(dataStart, dataStart + dataSize));
    cursor = dataStart + dataSize;
  }
  expect(view.getUint32(cursor, true)).toBe(0x02014b50);
  return files;
}

async function downloadWorkbook(page: Page, environment: "test" | "production") {
  await page.getByRole("button", { name: "导出活跃与留存", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出活跃与留存", exact: true });
  await expect(dialog).toContainText(`${environment === "test" ? "测试数据" : "正式数据"} · Pornhub`);
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载真实 XLSX", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("活跃与留存-待验数.xlsx");
  const files = workbookTextFiles(readFileSync((await download.path())!));
  return page.evaluate(files => {
    const parse = (source: string) => new DOMParser().parseFromString(source, "application/xml");
    const relationships = new Map([...parse(files["xl/_rels/workbook.xml.rels"]).querySelectorAll("Relationship")].map(item => [item.getAttribute("Id"), item.getAttribute("Target")]));
    return Object.fromEntries([...parse(files["xl/workbook.xml"]).querySelectorAll("sheet")].map(sheet => {
      const target = relationships.get(sheet.getAttribute("r:id"));
      if (!target) throw new Error("工作表缺少关系");
      const rows = [...parse(files[`xl/${target}`]).querySelectorAll("sheetData row")].map(row => [...row.querySelectorAll("c")].map(cell =>
        cell.getAttribute("t") === "inlineStr" ? cell.querySelector("t")?.textContent ?? "" : cell.querySelector("v") ? Number(cell.querySelector("v")!.textContent) : null));
      return [sheet.getAttribute("name")!, rows];
    }));
  }, files);
}

for (const environment of ["test", "production"] as const) {
  test(`5.8实际跨月XLSX在${environment}环境按自然月导出，普通日行完整保留`, async ({ page }, testInfo) => {
    const calls = await fixtures(page, environment);
    await page.goto(`${base}/dashboards/public?board=5.8&pid=PH&start=${historicalRange[0]}&end=${historicalRange[1]}`);
    const monthlyCard = page.locator(".dashboard-metric-card").filter({ has: page.getByRole("link", { name: "月活跃用户数", exact: true }) }).first();
    await expect(monthlyCard.locator(".dashboard-metric-card__value strong")).toHaveText("7");
    await expect(monthlyCard).toContainText("2020-03-01 至 2020-03-31");
    await monthlyCard.screenshot({ path: testInfo.outputPath(`monthly-${environment}.png`) });
    const workbook = await downloadWorkbook(page, environment);
    const monthly = workbook["当前期-月活跃用户数"];
    expect(monthly).toHaveLength(5);
    expect(monthly[0][0]).toBe("自然月与实际查询范围");
    expect(monthly.slice(1).map(row => row.slice(0, 4))).toEqual([
      ["2019-12 自然月 · 2019-12-01 至 2019-12-31", 0, 0, "已返回"],
      ["2020-01 自然月 · 2020-01-01 至 2020-01-31", 42, 42, "已返回"],
      ["2020-02 自然月 · 2020-02-01 至 2020-02-29", null, null, "本月未返回记录"],
      ["2020-03 自然月 · 2020-03-01 至 2020-03-31", 7, 7, "已返回"]
    ]);
    expect(monthly.slice(1).every(row => row[6] === "实际查询截止不是来源数据水位")).toBe(true);
    expect(workbook["读取说明"]).toContainEqual(["数据环境", environment === "test" ? "测试数据" : "正式数据"]);
    const daily = workbook["当前期-日活跃用户数"], dayCount = (Date.parse(historicalRange[1]) - Date.parse(historicalRange[0])) / 86400000 + 1;
    expect(daily).toHaveLength(dayCount + 1);
    expect(daily[0][0]).toBe("日期");
    expect(daily[1].slice(0, 4)).toEqual([historicalRange[0], 100, 100, "已返回"]);
    expect(daily.at(-1)!.slice(0, 4)).toEqual([historicalRange[1], 100 + dayCount - 1, 100 + dayCount - 1, "已返回"]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.environment === environment)).toBe(true);
  });
}

test("5.8实际当前月XLSX使用执行快照的实际截止与未知水位", async ({ page }) => {
  await fixtures(page, "test");
  await page.goto(`${base}/dashboards/public?board=5.8&pid=PH&start=${currentRange[0]}&end=${currentRange[1]}`);
  const monthlyCard = page.locator(".dashboard-metric-card").filter({ has: page.getByRole("link", { name: "月活跃用户数", exact: true }) }).first();
  await expect(monthlyCard.locator(".dashboard-metric-card__value strong")).toHaveText("12");
  await expect(monthlyCard).toContainText("2026-10-01 至 2026-10-11");
  const workbook = await downloadWorkbook(page, "test");
  expect(workbook["当前期-月活跃用户数"]).toHaveLength(2);
  expect(workbook["当前期-月活跃用户数"][1]).toEqual([
    "2026-10 自然月 · 2026-10-01 至 2026-10-11", 12, 12, "已返回", "2026-10-12T00:00:00.000Z", "本次查询结果", "实际查询截止不是来源数据水位"
  ]);
  expect(workbook["读取说明"]).toContainEqual(["数据水位", "未返回"]);
  expect(workbook["当前期-日活跃用户数"]).toHaveLength(5);
});
