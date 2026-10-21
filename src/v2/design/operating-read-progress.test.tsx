import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { recordDailyDashboardEnvironment } from "../api/daily-dashboard-environment";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import type { OperatingResources } from "./operating-live-model";
import { completeOperatingPlatformQuery, operatingReadNotice } from "./operating-read-progress";
import { OperatingReadProgress } from "./OperatingReadProgress";

const live: LiveDashboardReading = {
  query: { boardId: "5.2", pid: "PH", dateRange: ["2020-01-01", "2020-01-01"] }, dataEnvironment: "test",
  metricIds: [], state: { status: "loading" }, platformName: "PH", platforms: [{ pid: "PH", name: "PH" }, { pid: "TT", name: "TT" }],
  canExport: true, retry() {}, controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} }
};
function retained(pid: string, fetchedAt: string, options: { refreshing?: boolean; failed?: boolean; environment?: "test" | "production"; date?: string } = {}): OperatingResources[string] {
  const date = options.date ?? "2020-01-01";
  const data: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v2", query: { boardId: "5.2", pid, dateRange: ["2019-12-25", date] },
    queryId: pid, fetchedAt, timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: [], series: [] } };
  recordDailyDashboardEnvironment(data, options.environment ?? "test");
  return { status: "success", data, refreshing: options.refreshing ?? true, refreshError: options.failed ? { code: "TIMEOUT", message: "读取失败" } : null };
}

describe("经营平台查询进度", () => {
  test("只计同轮结算，完成后收起，空范围和演示不显示", () => {
    const start = { scopeKey: "first", total: 2, completed: 0 };
    expect(completeOperatingPlatformQuery(start, "old")).toBe(start);
    const first = completeOperatingPlatformQuery(start, "first")!;
    expect(operatingReadNotice(live, {}, first, "first").progress).toEqual({ completed: 1, total: 2 });
    const done = completeOperatingPlatformQuery(first, "first")!;
    expect(completeOperatingPlatformQuery(done, "first")).toBe(done);
    expect(operatingReadNotice(live, {}, done, "first").progress).toBeNull();
    expect(operatingReadNotice(live, {}, first, "new").progress).toBeNull();
    expect(operatingReadNotice(live, {}, { ...start, total: 0 }, "first").progress).toBeNull();
    expect(operatingReadNotice(null, {}, first, "first")).toEqual({ progress: null, retained: null });
  });

  test("上次结果只取当前范围和环境，局部筛选不混用别的平台时间", () => {
    const resources = { PH: retained("PH", "2026-10-21T02:00:00Z"), TT: retained("TT", "2026-10-21T02:01:00Z", { refreshing: false, failed: true }) };
    expect(operatingReadNotice(live, resources, null, "x").retained).toEqual({ count: 2, firstReadAt: "2026-10-21T02:00:00Z", lastReadAt: "2026-10-21T02:01:00Z", unknownTimes: 0 });
    expect(operatingReadNotice(live, resources, null, "x", "TT").retained?.count).toBe(1);
    expect(operatingReadNotice(live, resources, null, "x", "TT").retained?.firstReadAt).toBe("2026-10-21T02:01:00Z");
    for (const resource of [retained("PH", "2026-10-21T02:00:00Z", { date: "2020-01-02" }), retained("PH", "2026-10-21T02:00:00Z", { environment: "production" }), retained("OTHER", "2026-10-21T02:00:00Z"), retained("PH", "2026-10-21T02:00:00Z", { refreshing: false })]) {
      expect(operatingReadNotice(live, { PH: resource }, null, "x").retained).toBeNull();
    }
  });

  test("轻量文本区分平台查询与指标状态，保留真实读取时间及未知时间", () => {
    const notice = operatingReadNotice(live, { PH: retained("PH", "2026-10-21T02:00:00Z"), TT: retained("TT", "") }, { scopeKey: "x", completed: 1, total: 2 }, "x");
    const html = renderToStaticMarkup(<OperatingReadProgress notice={notice} />);
    expect(html).toContain("平台查询已结束 1/2");
    expect(html).toContain("2 个平台保留上次结果");
    expect(html).toContain('dateTime="2026-10-21T02:00:00Z"');
    expect(html).toContain("10:00:00");
    expect(html).toContain("另 1 个平台读取时间未提供");
    expect(html).toContain('role="status"');
    for (const forbidden of ["生成时间", "%", "READY", "排队", "指标通过"]) expect(html).not.toContain(forbidden);
    expect(renderToStaticMarkup(<OperatingReadProgress notice={{ progress: null, retained: null }} />)).toBe("");
  });

  test("刷新失败后的旧结果提示不随进度结束消失，不把时间范围当单次生成时间", () => {
    const resources = { PH: retained("PH", "2026-10-21T02:00:00Z", { refreshing: false, failed: true }), TT: retained("TT", "2026-10-21T02:01:00Z", { refreshing: false, failed: true }) };
    const notice = operatingReadNotice(live, resources, { scopeKey: "x", completed: 2, total: 2 }, "x");
    const html = renderToStaticMarkup(<OperatingReadProgress notice={notice} />);
    expect(html).not.toContain("平台查询已结束");
    expect(html).toContain("读取时间范围");
    expect(html).toContain("10:00:00");
    expect(html).toContain("10:01:00");
    const missing = renderToStaticMarkup(<OperatingReadProgress notice={operatingReadNotice(live, { PH: retained("PH", "") }, null, "x")} />);
    expect(missing).toContain("读取时间：未提供");
  });
});
