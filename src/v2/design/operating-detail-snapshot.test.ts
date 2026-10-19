import { describe, expect, test } from "bun:test";
import { DETAIL_COLUMNS, detailColumnKey, operatingDetailRows, operatingSummaryModels, selectOperatingRows, resolveOperatingDetail, operatingDetailExportRows, operatingValueLabel, operatingDetailBreakdown, type DetailRow, type DetailValue } from "./operating-detail-snapshot";
import { OPERATING_BREAKDOWNS, galleryBreakdown } from "./operating-breakdown-preview";
import { operatingColumnDocumentation, OPERATING_SUMMARY_IDS } from "./operating-detail-columns";
import { retentionTargetDate } from "./operating-detail-snapshot";
import { OPERATING_LIVE_IDS, operatingLiveColumns, operatingLiveExportRows, operatingLiveRows, type OperatingResources } from "./operating-live-model";
import { DailyDashboardService } from "../../../server/v2/daily-dashboard.service";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { recordDailyDashboardEnvironment } from "../api/daily-dashboard-environment";

describe("经营明细详情绑定当前查询单元格", () => {
  const scopeKey = "same-query";
  const columns = DETAIL_COLUMNS.slice(0, 2);
  const selection = { scopeKey, pid: "PH", columnKey: detailColumnKey(columns[0]) };
  const row = (values: DetailValue[], pid = "PH"): DetailRow => ({ pid, name: pid, state: "部分", productMode: null, promotionStatus: null, values });
  const cell = (current: number | null): DetailValue => ({ current, previousDay: null, previousWeek: null });

  test("读取完成后解析最新数值、三期计算输入和元数据，不保存打开时快照", () => {
    const loading = row([cell(null), cell(null)]);
    expect(resolveOperatingDetail(selection, scopeKey, [loading], columns)?.row).toBe(loading);
    const evidence = { state: "available", label: "READY", date: "2020-01-01", fetchedAt: "2026-10-16T03:00:00Z", stale: false,
      inputs: [{ name: "当前输入", value: 6, unit: "人" }], formula: null };
    const value = { ...cell(6), previousDay: 5, previousWeek: 4, evidence: { current: evidence, previousDay: { ...evidence, date: "2019-12-31" }, previousWeek: { ...evidence, date: "2019-12-25" } } };
    const latest = row([value, cell(2)]);
    const latestColumns = columns.map(column => ({ ...column, unit: "来源返回单位", metric: { ...column.metric, definition: "来源返回定义" } }));
    const detail = resolveOperatingDetail(selection, scopeKey, [latest], latestColumns)!;
    expect(detail.row).toBe(latest);
    expect(detail.row.values[detail.columnIndex]).toBe(value);
    expect(detail.column).toBe(latestColumns[0]);
    expect(loading.values[0].current).toBeNull();
    expect(selection).toEqual({ scopeKey, pid: "PH", columnKey: detailColumnKey(columns[0]) });
  });

  test("按PID与稳定列键定位，不受平台顺序或列顺序变化影响", () => {
    const other = row([cell(99), cell(98)], "TT");
    const current = row([cell(2), cell(6)]);
    const detail = resolveOperatingDetail(selection, scopeKey, [other, current], [columns[1], columns[0]])!;
    expect(detail.row).toBe(current);
    expect(detail.columnIndex).toBe(1);
    expect(detail.row.values[detail.columnIndex].current).toBe(6);
  });

  test("保留真实零值、空值、来源处理中/不完整、失败、未成熟和参考输入", () => {
    for (const state of ["available", "source_processing", "source_incomplete", "source_failure", "immature", "no_record"]) {
      const evidence = { state, label: state, date: "2020-01-01", fetchedAt: null, stale: false, formula: null,
        inputs: [{ name: "有效分母", unit: "人", value: 6 }] };
      const value = { ...cell(state === "available" ? 0 : null), evidence: { current: evidence, previousDay: evidence, previousWeek: evidence } };
      const detail = resolveOperatingDetail(selection, scopeKey, [row([value, cell(null)])], columns)!;
      expect(detail.row.values[detail.columnIndex]).toBe(value);
      expect(value.current).toBe(state === "available" ? 0 : null);
      expect(value.evidence.current.inputs[0].value).toBe(6);
    }
  });

  test("新的查询范围立即屏蔽旧详情", () => {
    expect(resolveOperatingDetail(selection, "another-query", [row([cell(6)])], columns)).toBeNull();
  });

  test("未选择、平台移除、列移除或单元格缺失时关闭，不读取相邻值", () => {
    const current = row([cell(6), cell(2)]);
    expect(resolveOperatingDetail(null, scopeKey, [current], columns)).toBeNull();
    expect(resolveOperatingDetail(selection, scopeKey, [row([cell(99)], "TT")], columns)).toBeNull();
    expect(resolveOperatingDetail(selection, scopeKey, [current], [columns[1]])).toBeNull();
    expect(resolveOperatingDetail(selection, scopeKey, [row([])], columns)).toBeNull();
  });

  test("93列中每个分维和留存周期都解析对应当前单元格，保持原数组不变", () => {
    const rows = operatingDetailRows("2026-09-08");
    for (const sourceRow of rows) for (const [columnIndex, column] of DETAIL_COLUMNS.entries()) {
      const detail = resolveOperatingDetail({ scopeKey, pid: sourceRow.pid, columnKey: detailColumnKey(column) }, scopeKey, rows, DETAIL_COLUMNS)!;
      expect(detail).toEqual({ row: sourceRow, column, columnIndex });
      expect(detail.row.values[columnIndex]).toBe(sourceRow.values[columnIndex]);
    }
    expect(DETAIL_COLUMNS).toHaveLength(93);
    expect(rows).toHaveLength(4);
  });
});

describe("经营明细请求诊断跟随平台资源", () => {
  const date = "2020-01-01", range: [string, string] = ["2019-12-25", date];
  const periods = ["current", "previousDay", "previousWeek"] as const;
  const amountIndex = DETAIL_COLUMNS.findIndex(column => column.metric.id === "M058" && !column.slice);
  const failure = (code = "IDENTITY_PROVIDER_UNAVAILABLE", requestId?: string) => ({
    status: "failure" as const, kind: "error" as const, code, requestId, message: "未用于详情的服务端消息"
  });
  function reading(environment: "production" | "test" = "production"): LiveDashboardReading {
    return { query: { boardId: "5.2", pid: "PH", dateRange: [date, date] }, metricIds: Object.values(OPERATING_LIVE_IDS),
      dataEnvironment: environment, state: { status: "loading" }, platformName: "主平台",
      platforms: [{ pid: "PH", name: "主平台" }, { pid: "TT", name: "其他平台" }], retry() {}, canExport: true,
      controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
  }
  function success(pid = "TT", environment: "production" | "test" = "production"): Extract<OperatingResources[string], { status: "success" }> {
    const data: DailyDashboardSuccess = { success: true, data: {
      schemaVersion: "day-dashboard/v2", query: { boardId: "5.2", pid, dateRange: [...range], projection: "operating_snapshot" },
      queryId: `diagnostic-${pid}`, fetchedAt: "2026-10-19T13:33:17Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation",
      completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"], series: [{
        metric: { id: "M058", referenceMetricId: "M058", name: "总充值金额", unit: "元", definition: "同平台真实金额", authorityVersion: "qa-v1",
          sourceNote: null, formula: null, inputs: [{ key: "amount", name: "总充值金额", unit: "元" }] },
        points: [range[0], "2019-12-31", date].map(day => ({ date: day, state: "available" as const, sourceStatus: "READY" as const, value: 24, inputs: [{ key: "amount", value: 24 }] })),
        periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: [...range], dayCount: 8, state: "unsupported", values: [], reason: "经营快照" }
      }]
    } };
    recordDailyDashboardEnvironment(data, environment);
    return { status: "success", data, refreshing: false, refreshError: null };
  }
  const row = (resources: OperatingResources, environment: "production" | "test" = "production") => operatingLiveRows(reading(environment), resources)[1];

  test("非主平台93列失败保留自身三期请求诊断，月活不适用比较不借编号", () => {
    const resources = { PH: failure("PRIMARY_FAILURE", "req-primary"), TT: failure(undefined, "req-secondary") };
    const rows = operatingLiveRows(reading(), resources);
    expect(rows[1].values).toHaveLength(93);
    for (const [index, value] of rows[1].values.entries()) for (const period of periods) {
      const evidence = value.evidence![period];
      if (DETAIL_COLUMNS[index].metric.id === "M018" && period !== "current") {
        expect(evidence.state).toBe("not_applicable");
        expect(evidence).not.toHaveProperty("requestFailure");
      } else {
        expect(evidence).toMatchObject({ state: "failed", label: "读取失败", stale: false,
          requestFailure: { code: "IDENTITY_PROVIDER_UNAVAILABLE", requestId: "req-secondary" } });
        expect(evidence.requestFailure).not.toHaveProperty("message");
      }
    }
    expect(rows[0].values[amountIndex].evidence!.current.requestFailure).toEqual({ code: "PRIMARY_FAILURE", requestId: "req-primary" });
  });

  test("刷新失败保留旧值、原状态及真实请求诊断，成功恢复清空诊断", () => {
    const prior = success(), refresh = { ...prior, refreshError: { code: "UPSTREAM_TIMEOUT", requestId: "req-refresh", message: "未用于详情的刷新消息" } };
    const stale = row({ TT: refresh }).values[amountIndex];
    expect([stale.current, stale.previousDay, stale.previousWeek]).toEqual([24, 24, 24]);
    for (const period of periods) expect(stale.evidence![period]).toMatchObject({ state: "available", stale: true,
      requestFailure: { code: "UPSTREAM_TIMEOUT", requestId: "req-refresh" } });
    const failed = row({ TT: failure(undefined, "req-failed") });
    expect(failed.values[amountIndex].evidence!.current.requestFailure?.requestId).toBe("req-failed");
    const recovered = row({ TT: prior }).values[amountIndex];
    for (const period of periods) {
      expect(recovered[period]).toBe(24);
      expect(recovered.evidence![period]).toMatchObject({ state: "available", stale: false });
      expect(recovered.evidence![period]).not.toHaveProperty("requestFailure");
    }
    expect(prior.refreshError).toBeNull();
  });

  test("仅透传实际存在的错误字段，加载和无错误字段不生成诊断", () => {
    for (const [resource, expected] of [
      [failure("CODE_ONLY"), { code: "CODE_ONLY" }],
      [failure("", "req-only"), { requestId: "req-only" }]
    ] as const) expect(row({ TT: resource }).values[amountIndex].evidence!.current.requestFailure).toEqual(expected);
    for (const resource of [undefined, { status: "loading" as const }, failure("")]) {
      const values = row(resource ? { TT: resource } : {}).values;
      for (const value of values) for (const period of periods) expect(value.evidence![period]).not.toHaveProperty("requestFailure");
    }
    const refreshing = { ...success(), refreshing: true };
    expect(row({ TT: refreshing }).values[amountIndex].evidence!.current).toMatchObject({ state: "available", stale: true });
    expect(row({ TT: refreshing }).values[amountIndex].evidence!.current).not.toHaveProperty("requestFailure");
  });

  test("异环境、异PID和旧日期资源的刷新错误不进入当前平台详情", () => {
    for (const environment of ["production", "test"] as const) {
      const wrongEnvironment = success("TT", environment === "production" ? "test" : "production");
      const wrongPid = success("PH", environment), wrongDate = success("TT", environment);
      wrongDate.data.data.query.dateRange = ["2019-12-24", "2019-12-31"];
      for (const source of [wrongEnvironment, wrongPid, wrongDate]) {
        const resource = { ...source, refreshError: { code: "STALE_SCOPE_FAILURE", requestId: "req-other-scope", message: "旧查询失败" } };
        const current = row({ PH: failure("PRIMARY_FAILURE", "req-primary"), TT: resource }, environment);
        for (const value of current.values) for (const period of periods) expect(value.evidence![period]).not.toHaveProperty("requestFailure");
        expect(current.values[amountIndex].current).toBeNull();
      }
    }
  });
});

describe("经营明细单日快照", () => {
  const date = "2026-09-08";
  const rows = operatingDetailRows(date);
  test("充值来源覆盖新老用户，与注册当日充值分别拆解", () => {
    const groups = OPERATING_BREAKDOWNS.M058;
    expect(groups.find(group => group.id === "new-users")).toMatchObject({ slices: ["新用户"], note: "只统计注册当日充值。" });
    const acquisition = groups.find(group => group.id === "acquisition")!;
    expect(acquisition).toMatchObject({ title: "充值按获客类型", slices: ["自然新增", "内部导量"] });
    expect(acquisition.note).toContain("注册时来源");
    expect(acquisition.note).toContain("覆盖新老用户");
    expect(acquisition.note).not.toContain("新用户的来源切片");
  });
  test("正式人均广告结果进入经营明细与导出时保留次/人及2/3原值", async () => {
    const sourceRows = [{
      metricCode: "M110", businessDate: date, dimensions: { pid: "PH", userCohort: "new" },
      value: 2 / 3, numerator: 2, denominator: 3, unit: "count_per_user",
      dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "rule-v1"
    }];
    const data = await new DailyDashboardService({ get: async path => path === "/api/admin/bi/v1/metrics"
      ? { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-09T10:00:00+08:00", watermark: null, rows: sourceRows } }
      : { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] }
    }, () => new Date("2026-10-10T00:00:00Z")).execute({ boardId: "5.2", pid: "PH", dateRange: ["2026-09-01", date] });
    const live = { query: data.data.query, metricIds: data.data.series.map(series => series.metric.id),
      state: { status: "success", data, refreshing: false, refreshError: null },
      platformName: "测试", controls: { dirty: false } } as LiveDashboardReading;
    const columns = operatingLiveColumns(live);
    const liveRows = operatingLiveRows(live, { PH: live.state });
    const index = columns.findIndex(column => column.metric.id === "M110" && column.slice === "新用户");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(columns[index]).toMatchObject({ unit: "次/人" });
    expect(liveRows[0].values[index]).toMatchObject({ current: 2 / 3, evidence: { current: {
      state: "available", unit: "次/人", inputs: [{ value: 2, unit: "次" }, { value: 3, unit: "人" }]
    } } });
    const exported = operatingLiveExportRows(liveRows, columns, date);
    expect(exported[0][3 + index * 9]).toContain("次/人");
    expect(exported[1][3 + index * 9]).toBe(2 / 3);
  });

  test("93 个展示列同源引用适用维度，端别仅保留 Android 与 iOS", () => {
    expect(DETAIL_COLUMNS).toHaveLength(93);
    expect(new Set(DETAIL_COLUMNS.map(detailColumnKey)).size).toBe(93);
    expect(DETAIL_COLUMNS.filter(c => c.metric.id === "M008").map(c => c.slice)).toEqual([undefined, "Android", "iOS", "自然新增", "内部导量"]);
    expect(DETAIL_COLUMNS.some(c => c.slice === "Web")).toBe(false);
    for (const id of ["M016", "M026", "M081"]) expect(DETAIL_COLUMNS.filter(c => c.metric.id === id).map(c => c.slice)).toEqual(expect.arrayContaining(["Android老用户", "iOS老用户"]));
    for (const id of ["M112", "M113", "M060", "M114"]) expect(DETAIL_COLUMNS.filter(c => c.metric.id === id).map(c => c.slice)).toContain("USDT");
    expect(DETAIL_COLUMNS.filter(c => c.metric.id === "M020").map(c => c.slice)).toEqual([undefined, "Android", "iOS", "自然新增", "内部导量"]);
    expect(DETAIL_COLUMNS.find(c => c.metric.id === "M023")?.unit).toBe("%");
  });
  test("每个经营明细列都有唯一真实接口投影，不因前端漏映射显示待支持", () => {
    expect(DETAIL_COLUMNS.map(detailColumnKey).filter(key => !OPERATING_LIVE_IDS[key])).toEqual([]);
    expect(new Set(Object.values(OPERATING_LIVE_IDS)).size).toBe(Object.values(OPERATING_LIVE_IDS).length);
  });
  test("全部/单平台选择不修改原快照", () => {
    expect(selectOperatingRows(rows, "all")).toHaveLength(4);
    expect(selectOperatingRows(rows, "TT").map(r => r.name)).toEqual(["TikTok"]);
    expect(selectOperatingRows(rows, "unknown")).toHaveLength(0);
    expect(rows).toHaveLength(4);
  });
  test("单平台数值卡与对应表格单元格同源，保留未成熟", () => {
    for (const row of rows) for (const model of operatingSummaryModels(rows, row.pid, date)) {
      const i = DETAIL_COLUMNS.findIndex(c => c.metric.id === model.metric.id && !c.slice);
      if (model.result.status === "available") expect(model.result.value.raw).toBe(row.values[i].current);
      else expect(["immature", "unsupported"]).toContain(model.result.status);
    }
  });
  test("经营全部平台按行合计，不跨PID去重；注册日尚未成熟", () => {
    const models = operatingSummaryModels(rows, "all", date);
    const dau = models.find(m => m.metric.id === "M016")!;
    expect(dau.result.status).toBe("available");
    if (dau.result.status === "available") expect(dau.result.value.raw).toBe(rows.reduce((sum,r) => sum + r.values[0].current!, 0));
    expect(dau.metric.definitionLabel).toContain("未跨PID去重");
    expect(models.find(m => m.metric.id === "M020")!.result.status).toBe("immature");
  });
  test("经营全部平台付费率使用同日平台输入合计，不平均比率", () => {
    for (const day of ["2026-09-08", "2026-09-07", "2026-08-31"]) {
      const models = operatingSummaryModels(operatingDetailRows(day), "all", day);
      const active = models.find(m => m.metric.id === "M016")!.result;
      const payer = models.find(m => m.metric.id === "M059")!.result;
      const rate = models.find(m => m.metric.id === "M061")!.result;
      expect(active.status).toBe("available"); expect(payer.status).toBe("available"); expect(rate.status).toBe("available");
      if (active.status === "available" && payer.status === "available" && rate.status === "available") {
        expect(rate.value.raw).toBeCloseTo(payer.value.raw / active.value.raw, 10);
        expect(rate.value.display).toBe((payer.value.raw / active.value.raw * 100).toFixed(2));
      }
    }
  });
  test("未接入维度保持空值与原因，不推算端别或新老用户", () => {
    for (const row of rows) DETAIL_COLUMNS.forEach((column,i) => {
      if (!column.slice) return;
      const immature = column.metric.id === "M020";
      expect(row.values[i]).toEqual({ current: null, previousDay: null, previousWeek: null, state: immature ? "immature" : "unsupported" });
      expect(operatingValueLabel(row.values[i], column)).toBe(immature ? "未成熟" : "待接口支持");
    });
  });
  test("演示单日总览不会小于任一平台人数，原始单日比率可核对", () => {
    for(const model of operatingSummaryModels(rows,"all",date)) {
      if(model.result.status!=="available" || !["M016","M008","M026"].includes(model.metric.id))continue;
      const i=DETAIL_COLUMNS.findIndex(c=>c.metric.id===model.metric.id && !c.slice);
      expect(model.result.value.raw).toBeGreaterThanOrEqual(Math.max(...rows.map(r=>r.values[i].current!)));
    }
    const viewers=DETAIL_COLUMNS.findIndex(c=>c.metric.id==="M026");
    const rate=DETAIL_COLUMNS.findIndex(c=>c.metric.id==="M081");
    for(const row of rows) expect(row.values[rate].current).toBeCloseTo(row.values[viewers].current! / row.values[0].current!,6);
  });
  test("宽表每行一个平台；导出数值、百分比、真实0和状态均保留", () => {
    const selected = structuredClone(selectOperatingRows(rows, "TT")); selected[0].values[0].current = 0;
    const output = operatingDetailExportRows(selected, date);
    expect(output).toHaveLength(2);
    expect(output[0]).toHaveLength(385);
    expect(output[1]).toHaveLength(output[0].length);
    expect(new Set(output[0]).size).toBe(output[0].length);
    expect(output[0].slice(0, 3)).toEqual(["数据日", "业务平台", "PID"]);
    expect(output[0]).not.toEqual(expect.arrayContaining(["模式", "推广状态"]));
    expect(output[1].slice(0,9)).toEqual([date, "TikTok", "TT", 0, "完整", 60500, 59000, null, "待接口支持"]);
    const i = output[0].indexOf("活跃用户观影率（%）"); expect(output[1][i]).toBeCloseTo(78, 8);
  });
  test("十种摘要拆解使用同一日期和平台，未成熟优先且不伪造可用结果", () => {
    for (const model of operatingSummaryModels(rows, "TT", date)) {
      if (!OPERATING_BREAKDOWNS[model.metric.id]) continue;
      const detail = operatingDetailBreakdown(model, rows, "TT", date);
      expect(detail.metric).toBe(model);
      expect(detail.context).toContain("TikTok"); expect(detail.context).toContain(date);
      expect(detail.groups).toHaveLength(OPERATING_BREAKDOWNS[model.metric.id].length);
      expect(detail.groups.flatMap(g => g.rows).every(r => r.value.status === (model.metric.id === "M020" ? "immature" : "unsupported"))).toBe(true);
      const sample = galleryBreakdown(model);
      expect(sample.sampleOnly).toBe(true);
      expect(sample.groups.flatMap(g => g.rows).every(r => r.value.status === "available")).toBe(true);
    }
  });
  test("切换数据日更新所有行；历史基准保留，计数不变成人数小数", () => {
    expect(rows[0].values[0].previousDay).toBe(88000);
    for (const day of ["2026-08-01", "2026-08-31", "2026-09-07"]) {
      const changed = operatingDetailRows(day);
      expect(changed[0].values[0].current).not.toBe(rows[0].values[0].current);
      for(const row of changed) {
        const metric=(id:string)=>row.values[DETAIL_COLUMNS.findIndex(c=>c.metric.id===id && !c.slice)].current!;
        expect(metric("M081")).toBeCloseTo(metric("M026") / metric("M016"),8);
        expect(metric("M061")).toBeCloseTo(metric("M059") / metric("M016"),8);
      }
      for (const row of changed) DETAIL_COLUMNS.forEach((c,i) => {
        const value=row.values[i].current; if(value===null)return;
        if(c.kind==="count")expect(Number.isInteger(value)).toBe(true);
        if(c.kind==="ratio"){expect(value).toBeGreaterThanOrEqual(0);expect(value).toBeLessThanOrEqual(1);}
      });
      expect(operatingSummaryModels(changed,"all",day).find(m=>m.metric.id==="M020")!.result).toMatchObject({ status: "no_values", label: "计算输入异常或缺失" });
    }
  });
  test("原始日报 A:BJ 全量可追溯，58业务字段各出现一次，保留15额外列", () => {
    const headers = "日活总计|MAU|Android日活|IOS日活|比例|新增总计|自然总新增|内部导量总新增|新增Android|新增IOS|比例|广告总点击人次|广告总人次比例|广告总点击人数|广告总点击人数比例|广告新增点击人次|广告新增人次比例|广告新增点击人数|广告新增点击人数比例|总拉单次数|总拉单人数|总充值成功次数|总成功率|支付宝拉单次数|支付宝拉单人数|支付宝充值成功次数|支付宝成功率|微信拉单次数|微信拉单人数|微信充值成功次数|微信成功率|总充值人数|总充值付费率|总充值金额|自然新增总充值|内部导量总充值|总充值ARPU|总充值ARPPU|新增充值人数|新增充值付费率|新增充值金额|新增充值ARPU|新增充值ARPPU|总观影人数|总观影率|新增观影人数|新增观影率|次留|次留登陆人数|3留|3留登陆人数|7留|7留登陆人数|访问|下载|访问-下载转化|下载-注册转化|访问-注册转化".split("|");
    const letter = (n:number): string => n > 26 ? `${String.fromCharCode(64 + Math.floor((n-1)/26))}${String.fromCharCode(65+(n-1)%26)}` : String.fromCharCode(64+n);
    headers.forEach((name, i) => {
      const matches = DETAIL_COLUMNS.filter(c => c.sourceColumn === letter(i+5));
      expect(matches).toHaveLength(1); expect(matches[0].sourceLabel).toBe(name);
    });
    expect(DETAIL_COLUMNS.filter(c=>!c.sourceColumn)).toHaveLength(35);
    expect(operatingColumnDocumentation()).toHaveLength(96);
    expect(operatingColumnDocumentation().flat()).not.toEqual(expect.arrayContaining(["推广状态"]));
    expect(operatingSummaryModels(rows,"all",date).map(m=>m.metric.id)).toEqual(OPERATING_SUMMARY_IDS);
  });
  test("次数获客、广告人均与拉单口径精确绑定，不用提交或到账替代", () => {
    const field = (letter:string) => DETAIL_COLUMNS.find(c=>c.sourceColumn===letter)!;
    for (const [letter,id,unit] of [["BF","M001","次"],["BG","M003","次"],["BH","M005","%"],["Q","M110","次/人"],["X","M112","次"],["Y","M113","人"],["Z","M060","单"],["AA","M114","%"],["AP","M067","USD/人"]]) {
      expect(field(letter).metric.id).toBe(id); expect(field(letter).unit).toBe(unit);
    }
    for (const row of rows) DETAIL_COLUMNS.forEach((c,i)=>{ if(c.pendingReason) expect(row.values[i].current).toBeNull(); });
    for(const c of DETAIL_COLUMNS.filter(c=>c.periodDays)) expect(c.slice).not.toBe("老用户");
  });
  test("自然月和 D1/D3/D7 日期及未成熟状态随数据日更新", () => {
    const historical=operatingDetailRows("2026-09-07");
    for (const days of [1,3,7]) {
      const i=DETAIL_COLUMNS.findIndex(c=>c.metric.id==="M115" && c.periodDays===days);
      expect(retentionTargetDate(DETAIL_COLUMNS[i],"2026-09-07")).toBe(`2026-09-${String(7+days).padStart(2,"0")}`);
      expect(historical[0].values[i].state).toBe(days===1?"unsupported":"immature");
    }
    const output=operatingDetailExportRows(operatingDetailRows("2026-08-31"),"2026-08-31");
    expect(output[1][output[0].indexOf("MAU｜自然月")]).toBe("2026-08");
    expect(output[1][output[0].indexOf("MAU｜数据截至日")]).toBeNull();
  });
});
