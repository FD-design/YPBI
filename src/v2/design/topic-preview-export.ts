import { calculationExport } from "./calculation-export";
import { missingCalculation } from "../features/dashboards/CalculationEvidence";
import { topicLabels } from "./topic-preview-labels";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { authorityVersion, rangeLabel, topicMetric, topicUnit, contentValue, contentBaseline, structureDaily, topicScopeLabel, type CohortRow, type ContentRow, type StructureRow } from "./topic-preview-fixtures";
import { DEFAULT_TOPIC_SCOPE, type TopicView } from "./topic-preview-view";
import type { WorkbookCell, WorkbookSheet } from "./preview-workbook";
export function topicMetadata(view: TopicView, registered = true): WorkbookSheet {
  return { name: "00_导出说明", rows: [["项目", "内容"], ["数据性质", "DEV 合成演示数据，仅用于布局与交互核对；不是业务查询结果"], ["指标权威版本", authorityVersion], ["统计日期", rangeLabel(view.active)], [topicLabels(registered).date, rangeLabel(view.cohort)], ...(registered ? [["首次体验失败日期", rangeLabel(view.failure)]] : []), ["对比", view.compared ? "上一等长周期；成熟批次按对应位置配对" : "不对比"], ["业务范围", "大盘演示样例；正式 PID 适用范围待逐项准入"], ["结构当前分析范围", topicScopeLabel(view.reading?.scope ?? DEFAULT_TOPIC_SCOPE)], ["导出范围", "全部聚合行，不受分页、搜索或图表 Top10 限制；不包含用户 ID"], ["单位", "百分数列按 0–100 导出；时长单位见各指标"], ["生成时间", new Date().toISOString()]] };
}
export function metricRows(models: DashboardMetricCardModel[], unavailableUnit: (id: string) => string = topicUnit): WorkbookCell[][] {
  const compared = models.some(model => Boolean(model.result.reading?.comparisons.length) || (model.result.status === "available" ? Boolean(model.result.comparison || model.result.trend.comparison) : Boolean(model.result.history?.trend.comparison)));
  const singleMetric = new Set(models.map(model => model.metric.id)).size === 1 ? models[0] : undefined;
  const inputs = calculationExport(singleMetric ? models.flatMap(model => {
    const result = model.result.status === "available" ? model.result : model.result.history;
    return [result?.calculation, ...(result?.trend.current.map(point => point.calculation) ?? [])].filter(basis => basis !== undefined);
  }) : [], singleMetric ? missingCalculation(singleMetric.metric.definitionLabel, singleMetric.metric.aggregationLabel, "", false) : undefined);
  return [["指标", "记录类型", "日期 / 范围", "当前值", "单位", ...(compared ? ["对比日期 / 范围", "对比值"] : []), "状态", ...inputs.headers], ...models.flatMap(model => {
    const current = model.result.status === "available" ? model.result : null;
    const history = model.result.status === "available" ? undefined : model.result.history;
    const result = current ?? history, reading = model.result.reading;
    const unit = result?.value.unit ?? unavailableUnit(model.metric.id), scale = unit === "%" ? 100 : 1;
    const c = reading ? null : current?.comparison;
    const summary: WorkbookCell[] = [model.metric.name, "摘要", reading?.primaryLabel ?? model.metric.aggregationLabel, current ? current.value.raw * scale : null, unit, ...(compared ? [c?.status === "available" ? c.rows?.[1]?.date ?? null : null, c?.status === "available" ? c.rows?.[1]?.value ?? null : null] : []), current ? current.completeness === "complete" ? "完整" : current.completeness === "unknown" ? "待验数" : "部分" : model.result.status === "available" ? "完整" : model.result.label ?? model.result.status, ...inputs.cells(current?.calculation)];
    const comparisons: WorkbookCell[][] = reading?.comparisons.map(comparison => [model.metric.name, comparison.label, reading.primaryLabel, current ? current.value.raw * scale : null, unit, ...(compared ? [comparison.status === "available" ? comparison.rows?.[1]?.date ?? null : null, comparison.status === "available" ? comparison.rows?.[1]?.value ?? null : null] : []), comparison.status === "available" ? comparison.notice ?? comparison.display : comparison.detail, ...inputs.cells(current?.calculation)]) ?? [];
    const statistics: WorkbookCell[][] = reading?.statistics.map(statistic => [model.metric.name, statistic.label, model.metric.aggregationLabel, statistic.display, statistic.unit ?? unit, ...(compared ? [null, null] : []), statistic.detail, ...inputs.cells()]) ?? [];
    return [summary, ...comparisons, ...statistics, ...(result?.trend.current.map(p => [model.metric.name, "趋势", p.actualDate, p.value === null ? null : p.value.raw * scale, unit, ...(compared ? [p.counterpart?.actualDate ?? null, p.counterpart ? p.counterpart.raw * scale : null] : []), p.stateLabel,...inputs.cells(p.calculation)]) ?? [])];
  })];
}
export function cohortExport(rows: CohortRow[], dateLabel = topicLabels(rows[0]?.cells.some(cell => cell.id === "M020") ?? true).date, peopleLabel = topicLabels(rows[0]?.cells.some(cell => cell.id === "M020") ?? true).people): WorkbookCell[][] { return [[dateLabel, peopleLabel, "指标", "观察窗口结束日", "人数", "留存率（%）", "状态"], ...rows.flatMap(row => row.cells.map(cell => [row.date, row.base, topicMetric(cell.id).name, cell.availableAt, cell.count, cell.rate === null ? null : cell.rate * 100, cell.status]))]; }
export function structureExport(rows: StructureRow[], id: string, compared: boolean): WorkbookCell[][] { return [["维度值", "指标", "当前值", "单位", ...(compared ? ["对比值", "差值"] : [])], ...rows.map(row => [row.label, topicMetric(id).name, row.current * (topicUnit(id) === "%" ? 100 : 1), topicUnit(id), ...(compared ? [row.previous * (topicUnit(id) === "%" ? 100 : 1), (row.current - row.previous) * (topicUnit(id) === "%" ? 100 : 1)] : [])])]; }
export function structureDetailExport(dimension:string,id:string,view:TopicView):WorkbookCell[][] {
  const scale=topicUnit(id)==="%"?100:1;
  const rows=structureDaily(dimension,id,view.active,view.compared).flatMap(point=>Object.entries(point.values).map(([group,value])=>({point,group,value,basis:point.basis?.[group]})));
  const inputs=calculationExport(rows.map(row=>row.basis));
  return [["日期","分组",topicMetric(id).name,"单位","对比日期","对比值","状态",...inputs.headers],...rows.map(({point,group,value,basis})=>[point.date,group,value*scale,topicUnit(id),point.comparison?.date??null,point.comparison?point.comparison.values[group]*scale:null,"合成演示数据",...inputs.cells(basis)])];
}
export function rankingExport(rows: ContentRow[], id: string, compared = false): WorkbookCell[][] { const scale = topicUnit(id) === "%" ? 100 : 1; return [["名次", "内容标识（演示）", "内容标题", "类型", "排序指标", "当前值", "单位", ...(compared ? ["对比值", id === "M036" ? "差值（百分点）" : "差值"] : []), "有效观看次数", "起播次数", "状态"], ...[...rows].sort((a,b) => contentValue(b,id)-contentValue(a,id)).map((row,i) => [i+1, row.id, row.title, row.kind, topicMetric(id).name, contentValue(row, id) * scale, topicUnit(id), ...(compared ? [contentBaseline(row,id)*scale, (contentValue(row,id)-contentBaseline(row,id))*scale] : []), row.effective, row.starts, "完整"])]; }
export const topicLimits = (): WorkbookSheet => ({ name: "99_数据状态与限制", rows: [["对象", "说明"], ["正式服务", "未接入真实查询、去重、成熟判定与正式导出；演示数值不可用于业务决策"], ["数据截至", "2026-09-08，固定演示场景"], ["未成熟", "保留空值、成熟状态与观察窗口；不补 0"], ["整体活跃次日回访", "待权威指标登记及同批用户加工，未生成数值；不使用注册留存和存量复访拼算"], ["观影后用户去向", "三类去向仅为隔离演示，真实数据须由首次有效观看用户的跨日行为关联生成"], ["注册来源渠道", "权威维度待确认，未生成对应业务列"], ["内容分析跳转", "稳定正式内容标识与分析路由待映射"], ["规则版本", authorityVersion]] });
