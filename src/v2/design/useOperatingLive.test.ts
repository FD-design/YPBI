import { expect, test } from "bun:test";
import * as React from "react";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess, DailyPoint } from "../../../contracts/daily-dashboard";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import type { OperatingResources } from "./operating-live-model";
import { useOperatingLive } from "./useOperatingLive";

test("经营列在同一查询的读取完成和刷新后采用最新单位与定义", () => {
  const query = { boardId: "5.2", pid: "PH", dateRange: ["2020-01-01", "2020-01-01"] as [string, string] };
  const loading: LiveDashboardReading = { query, metricIds: ["M058", "M067"], state: { status: "loading" }, platformName: "PH", canExport: true,
    retry() {}, controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
  const success = (revision: string, currency: string): LiveDashboardReading => {
    const data: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v2", query, queryId: "same-query",
      fetchedAt: "2026-10-09T12:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null,
      sourceApiIds: ["bi-v1.metrics"], series: ["M058", "M067"].map(id => ({
        metric: { id, name: id, unit: id === "M058" ? currency : currency + "/人", definition: revision + "定义", sourceNote: revision + "来源",
          referenceMetricId: id, authorityVersion: "v1", formula: null, inputs: [] }, points: [],
        periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: query.dateRange, dayCount: 1, state: "unsupported", values: [], reason: null }
      })) } };
    return { ...loading, state: { status: "success", data, refreshing: false, refreshError: null } };
  };
  const stages = [loading, success("初次", "元"), success("刷新", "人民币元")];
  const captured: { unit: string; definition: string }[][] = [];
  function Reading() {
    const [stage, setStage] = useState(0);
    const { columns } = useOperatingLive(stages[stage]);
    captured.push(["M058", "M067"].map(id => {
      const column = columns.find(column => column.metric.id === id && !column.slice)!;
      return { unit: column.unit, definition: column.metric.definition };
    }));
    if (stage < stages.length - 1) setStage(stage + 1);
    return createElement("span", null, columns.find(column => column.metric.id === "M058")!.unit);
  }
  renderToStaticMarkup(createElement(Reading));
  expect(captured).toHaveLength(3);
  expect(captured[0].map(column => column.unit)).toEqual(["", ""]);
  expect(captured[1]).toEqual([{ unit: "元", definition: "初次定义 初次来源" }, { unit: "元/人", definition: "初次定义 初次来源" }]);
  expect(captured[2]).toEqual([{ unit: "人民币元", definition: "刷新定义 刷新来源" }, { unit: "人民币元/人", definition: "刷新定义 刷新来源" }]);
});

function loadingReading(): LiveDashboardReading {
  return { query: { boardId: "5.2", pid: "PH", dateRange: ["2020-01-01", "2020-01-01"] },
    metricIds: ["M058"], state: { status: "loading" }, platformName: "PH", platforms: [{ pid: "PH", name: "PH" }], canExport: true,
    retry() {}, controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}

test("稳定读取输入的局部重复渲染复用经营列与行引用", () => {
  const live = loadingReading(), captured: ReturnType<typeof useOperatingLive>[] = [];
  function Reading() {
    const [render, setRender] = useState(0);
    captured.push(useOperatingLive(live));
    if (render < 3) setRender(render + 1);
    return createElement("span");
  }
  renderToStaticMarkup(createElement(Reading));
  expect(captured).toHaveLength(4);
  for (const result of captured.slice(1)) {
    expect(result.resources).toBe(captured[0].resources);
    expect(result.columns).toBe(captured[0].columns);
    expect(result.rows).toBe(captured[0].rows);
  }
});

test("null到真实读取再到null保持钩子顺序并立即移除真实行", () => {
  const stages = [null, loadingReading(), null], captured: ReturnType<typeof useOperatingLive>[] = [];
  function Reading() {
    const [stage, setStage] = useState(0);
    captured.push(useOperatingLive(stages[stage]));
    if (stage < stages.length - 1) setStage(stage + 1);
    return createElement("span");
  }
  renderToStaticMarkup(createElement(Reading));
  expect(captured).toHaveLength(3);
  expect(captured[0].rows).toBeNull();
  expect(captured[1].rows?.map(row => row.pid)).toEqual(["PH"]);
  expect(captured[2].rows).toBeNull();
  expect(captured[2].columns).toEqual(captured[0].columns);
});

// Controlled immutable resource snapshots isolate render derivation. The
// lifecycle suite separately runs real effects, requests, refresh and cleanup.
function derivationRenderer() {
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const memos: { deps: readonly unknown[]; value: unknown }[] = [];
  return (live: LiveDashboardReading | null, resources: OperatingResources) => {
    let index = 0;
    const prior = internals.H;
    internals.H = {
      useState: () => [resources, () => { throw new Error("Render derivation cannot update resources"); }],
      useEffect() {},
      useMemo(calculate: () => unknown, deps: readonly unknown[]) {
        const i = index++, previous = memos[i];
        if (!previous || previous.deps.length !== deps.length || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
          memos[i] = { deps, value: calculate() };
        }
        return memos[i].value;
      }
    };
    try { return useOperatingLive(live); } finally { internals.H = prior; }
  };
}

function source(value: number | null, unit: string, definition: string, state: DailyPoint["state"] = value === null ? "no_value" : "available") {
  const query = { boardId: "5.2", pid: "PH", dateRange: ["2019-12-25", "2020-01-01"] as [string, string] };
  const data: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v2", query, queryId: "same-query",
    fetchedAt: "2026-10-13T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null,
    sourceApiIds: ["bi-v1.metrics"], series: [{
      metric: { id: "M058", name: "总充值金额", unit, definition, sourceNote: definition + "来源", referenceMetricId: "M058", authorityVersion: "test-v1",
        formula: definition + "公式", inputs: [{ key: "amount", name: "测试金额", unit }] },
      points: ["2019-12-25", "2019-12-31", "2020-01-01"].map(date => ({ date, state, sourceStatus: "READY", value, inputs: [{ key: "amount", value }] }))
    }] } };
  return { status: "success" as const, data, refreshing: false, refreshError: null };
}

test("相同查询和queryId的新结果立即更新数值、单位、定义与状态", () => {
  const render = derivationRenderer(), loading = loadingReading();
  const first = source(0, "元", "初次"), second = source(7, "人民币元", "刷新"), missing = source(null, "人民币元", "缺值");
  const readings = [first, second, missing].map(state => ({ ...loading, state }));
  const resources = [first, second, missing].map(state => ({ PH: state }));
  const index = render(loading, {}).columns.findIndex(column => column.metric.id === "M058" && !column.slice);
  const result = render(readings[0], resources[0]);
  expect(result.rows![0].values[index]).toMatchObject({ current: 0, evidence: { current: { state: "available", unit: "元", formula: "初次公式" } } });
  const repeated = render(readings[0], resources[0]);
  expect(repeated.columns).toBe(result.columns);
  expect(repeated.rows).toBe(result.rows);
  const refreshed = render(readings[1], resources[1]);
  expect(refreshed.rows).not.toBe(result.rows);
  expect(refreshed.columns[index]).toMatchObject({ unit: "人民币元", metric: { definition: "刷新 刷新来源" } });
  expect(refreshed.rows![0].values[index]).toMatchObject({ current: 7, evidence: { current: { state: "available", unit: "人民币元", formula: "刷新公式" } } });
  const unavailable = render(readings[2], resources[2]);
  expect(unavailable.rows![0].values[index]).toMatchObject({ current: null, evidence: { current: { state: "no_value", formula: "缺值公式" } } });
});

test("完整resources引用变化重算行但复用列，刷新失败与读取失败状态即时生效", () => {
  const render = derivationRenderer(), state = source(7, "元", "当前"), live = { ...loadingReading(), state };
  const result = render(live, { PH: state }), index = result.columns.findIndex(column => column.metric.id === "M058" && !column.slice);
  const stale = render(live, { PH: { ...state, refreshError: { code: "TIMEOUT", message: "刷新失败" } } });
  expect(stale.columns).toBe(result.columns);
  expect(stale.rows).not.toBe(result.rows);
  expect(stale.rows![0].values[index]).toMatchObject({ current: 7, evidence: { current: { stale: true } } });
  const failed = render(live, { PH: { status: "failure", kind: "error", code: "FAILED", message: "读取失败" } });
  expect(failed.rows![0].values[index]).toMatchObject({ current: null, evidence: { current: { state: "failed", label: "读取失败" } } });
  const pending = render(live, { PH: { status: "loading" } });
  expect(pending.rows![0].values[index]).toMatchObject({ current: null, evidence: { current: { state: "loading", label: "读取中" } } });
});
