import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dailyDashboardSuccessSchema, type DailyPoint } from "../../../contracts/daily-dashboard";
import { LiveDashboardContext, liveValue, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { NewOldPayment } from "./PaymentBreakdowns";

const date = "2020-01-01";
const range = { start: date, end: date };

function reading(arppu: number | null, sourceStatus: DailyPoint["sourceStatus"] = "READY"): LiveDashboardReading {
  const query = { boardId: "5.10", pid: "PH", dateRange: [date, date] as [string, string] };
  const series = ["M058", "M058.new", "M059", "M059.new", "M067", "M067.new"].map(id => {
    const average = id.startsWith("M067"), users = id.startsWith("M059");
    const unit = average ? "元/人" : users ? "人" : "元";
    const value = average ? arppu : users ? 10 : arppu === null ? 1234.567 : arppu * 10;
    const missing = value === null;
    const inputs = average ? [{ key: "amount", name: "充值金额", unit: "元" }, { key: "users", name: "付费用户数", unit: "人" }]
      : [{ key: "value", name: "实际结果", unit }];
    return {
      metric: { id, referenceMetricId: id.split(".")[0], name: id, unit, authorityVersion: "fixture", definition: "同范围真实候选结果", formula: average ? "同范围充值金额 ÷ 同范围付费用户数" : null, sourceNote: "隔离测试输入", inputs },
      points: [{ date, value, state: missing ? sourceStatus === "NOT_MATURE" ? "immature" : sourceStatus === "FAILED" ? "source_failure" : "no_value" : "available", sourceStatus: average ? sourceStatus : "READY",
        inputs: inputs.map((input, index) => ({ key: input.key, value: missing ? null : average ? index === 0 ? value * 10 : 10 : value })) }]
    };
  });
  const data = dailyDashboardSuccessSchema.parse({ success: true, data: { schemaVersion: "day-dashboard/v1", query, queryId: "payment-format", fetchedAt: "2026-10-10T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"], series } });
  return { query, metricIds: data.data.series.map(item => item.metric.id), state: { status: "success", data, refreshing: false, refreshError: null }, platformName: "PH", canExport: false, retry() {},
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}

function render(live: LiveDashboardReading, width = 1440) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: width } });
  try {
    return renderToStaticMarkup(createElement(LiveDashboardContext.Provider, { value: live }, createElement(NewOldPayment, { range, compared: false, onOpen() {} })));
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  }
}

const summaryRows = (html: string) => [...(html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "").matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
  .map(row => [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map(cell => cell[1]));

test("新老付费摘要的小额ARPPU与共享指标格式一致，充值金额保持原精度", () => {
  for (const value of [0.004, 0.0105317, 0, 32.404, 123.4567, 1234.567]) {
    const rows = summaryRows(render(reading(value)));
    for (const row of rows.slice(0, 2)) {
      expect(row[4]).toBe(`${liveValue(value, "元/人")} 元/人`);
      expect(row[1]).toBe(`${(value * 10).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 元`);
    }
    expect(rows[2]).toEqual(["老用户", "—", "—", "— 人", "—"]);
  }
});

test("缺失与合法非READY结果保持空值，真实零独立显示", () => {
  for (const status of ["READY", "PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"] as const) {
    const rows = summaryRows(render(reading(null, status)));
    expect(rows[0][4]).toBe("—");
    expect(rows[1][4]).toBe("—");
  }
  expect(summaryRows(render(reading(0)))[0][4]).toBe("0 元/人");
});

test("桌面与窄屏静态DOM保留原区块、五列表格及趋势操作", () => {
  const live = reading(0.004);
  const desktop = render(live, 1440), narrow = render(live, 390);
  expect(narrow).toBe(desktop);
  expect(desktop).toContain('class="payment-breakdown__overview"');
  expect(desktop).toContain('class="payment-breakdown__summary"');
  expect(desktop).toContain('aria-label="充值金额构成"');
  expect(desktop).toContain('aria-label="新老付费趋势指标"');
  expect(desktop).toContain('aria-label="新老用户付费日趋势"');
  expect(summaryRows(desktop).map(row => row.length)).toEqual([5, 5, 5]);
  expect(desktop).not.toContain("USD");
});
