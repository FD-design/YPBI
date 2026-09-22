import { calculationHeaders, calculationCells, calculationExport } from "./calculation-export";
import { sourceDaily, downloadTargetDaily, acquisitionCards, acquisitionDailyCards, acquisitionMetric, DETAIL_METRICS, acquisitionRows, acquisitionBaseline, acquisitionRangeLabel, metricUnit, fixtureSupports, type AcquisitionFilters, type AcquisitionDimension } from "./acquisition-preview-model";
import { downloadPreviewWorkbook, type WorkbookSheet, type WorkbookCell } from "./preview-workbook";
import definitions from "../generated/metric-definitions-ui.json";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { channelQualitySheets } from "./acquisition-channel-quality";
import { metricRows } from "./topic-preview-export";
import { missingCalculation } from "../features/dashboards/CalculationEvidence";

function metricTrendRows(model: DashboardMetricCardModel, includeComparison = true, inputCells = calculationCells): WorkbookCell[][] {
  const result = model.result.status === "available" ? model.result : model.result.history;
  if (!result) return [];
  const unit = result.value.unit, scale = unit === "%" ? 100 : 1;
  return result.trend.current.map(point => [model.metric.name, point.actualDate, point.value ? point.value.raw * scale : null, unit,
    ...(includeComparison ? [point.counterpart?.actualDate ?? null, point.counterpart ? point.counterpart.raw * scale : null, point.value && point.counterpart ? (point.value.raw - point.counterpart.raw) * scale : null] : []), point.stateLabel,...inputCells(point.calculation)]);
}

export function acquisitionTrendWorkbook(model: DashboardMetricCardModel, filters: AcquisitionFilters): WorkbookSheet[] {
  if (!fixtureSupports(filters)) throw new Error("当前条件没有可导出的演示结果");
  const result = model.result.status === "available" ? model.result : model.result.history;
  if (!result?.trend.current.length) throw new Error("当前没有可导出的逐日结果");
  if (result.trend.current[0].actualDate !== filters.start || result.trend.current.at(-1)?.actualDate !== filters.end) throw new Error("查询条件与演示结果不一致，请先应用条件");
  const compared = Boolean(result.trend.comparison), unit = result.value.unit;
  const inputs = calculationExport(result.trend.current.map(point => point.calculation), missingCalculation(model.metric.definitionLabel, model.metric.aggregationLabel, result.value.display, unit === "%"));
  const rows = metricTrendRows(model, compared, inputs.cells);
  return [
    { name: "00_导出说明", rows: [["项目", "内容"], ["数据性质", "固定演示数据，不是正式业务结果，不用于经营决策或结算"], ["指标", model.metric.name], ["指标定义", model.metric.definitionLabel], ["指标权威版本", definitions.authorityVersion], ["查询区间", `${filters.start} 至 ${filters.end}`], ["业务范围", "大盘整体"], ["来源渠道", "全部来源渠道"], ["对比", compared ? "保留每行实际对比日期" : "不对比"], ["范围", "当前指标同口径数据表的全部逐日结果，不受分页或临时显隐限制"], ["单位", unit === "%" ? "当前值、对比值为百分数；差值为百分点" : unit], ["生成时间", new Date().toISOString()]] },
    { name: "01_同口径数据表", rows: [["指标", "当前日期", "当前值", "单位", ...(compared ? ["对比日期", "对比值", unit === "%" ? "差值（百分点）" : `差值（${unit}）`] : []), "状态",...inputs.headers], ...rows] },
    ...(model.result.reading ? [{ name: "02_日值与周期辅助", rows: metricRows([model], metricUnit).filter(row => row[1] !== "趋势") }] : []),
    { name: "99_数据状态与限制", rows: [["对象", "说明"], ["查询状态", result.completeness === "partial" ? "部分" : "完整"], ["数据截至", result.watermarkLabel], ["空值", "空白单元格结合逐日状态读取，真实 0 保留为数值 0"], ["正式服务", "未接入正式查询与导出服务；本文件仅供界面核对"]] }
  ];
}

export function exportAcquisitionTrend(model: DashboardMetricCardModel, filters: AcquisitionFilters) {
  downloadPreviewWorkbook(`${model.metric.name}同口径数据表`, acquisitionTrendWorkbook(model, filters));
}
export function acquisitionWorkbook(filters: AcquisitionFilters, mixed: boolean, recovered: string[], scope: "board" | "growth" | "settlement" = "board"): WorkbookSheet[] {
  if (!fixtureSupports(filters)) throw new Error("当前条件没有可导出的演示结果");
  const compared = filters.comparison !== "none", cards = acquisitionCards(compared, mixed, recovered, filters);
  const sheets: WorkbookSheet[] = [{ name: "00_导出说明", rows: [["项目", "内容"], ["数据性质", "固定演示数据，不是正式业务结果，不用于经营决策或结算"], ["看板", "获客与新增"], ["查询区间", `${filters.start} 至 ${filters.end}`], ["业务范围", filters.scope === "all" ? "大盘整体" : "单业务平台"], ["来源渠道", filters.channel === "all" ? "全部来源渠道" : "推广渠道 A"], ["对比周期", compared ? acquisitionRangeLabel(acquisitionBaseline(filters)) : "不对比"], ["指标权威版本", "v0.23-draft"], ["范围", "保留完整结果，不受搜索、分页、表内变化显隐限制；渠道结算独立"], ["比率单位", "单位为 % 的数值按百分数导出，变化按百分点导出"], ["生成时间", new Date().toISOString()]] }];
  if (scope === "board") {
    const summary: WorkbookCell[][] = [["指标", "区间", "当前值", "单位", "对比值", "差值", "变化率或百分点", "状态"]];
    const trend: WorkbookCell[][] = [["指标", "当前日期", "当前值", "单位", "对比日期", "对比值", "差值", "状态",...calculationHeaders]];
    for (const { model } of cards) {
      const result = model.result, id = model.metric.id, scale = metricUnit(id) === "%" ? 100 : 1;
      if (result.status !== "available") { summary.push([model.metric.name, `${filters.start} 至 ${filters.end}`, null, metricUnit(id), null, null, null, result.status === "failed" ? "加载失败" : "未产出"]); continue; }
      const c = result.comparison;
      summary.push([model.metric.name, `${filters.start} 至 ${filters.end}`, result.value.raw * scale, metricUnit(id), c?.status === "available" ? c.rows?.[1]?.value ?? null : null, c?.status === "available" ? c.difference?.display ?? null : null, c?.status === "available" ? c.display : null, result.completeness === "partial" ? "部分" : "完整"]);
      trend.push(...metricTrendRows(model));
    }
    sheets.push({ name: "01_周期摘要与首次激活", rows: summary }, { name: "02_逐日趋势", rows: trend }, { name: "03_主卡日值与周期辅助", rows: metricRows(acquisitionDailyCards(compared, mixed, recovered, filters).map(item => item.model), metricUnit).filter(row => row[1] !== "趋势") });
  }
  if (scope !== "settlement") for (const [index, dimension] of (["channel", "target", "type"] as AcquisitionDimension[]).entries()) {
    if (dimension === "channel") { sheets.push(...channelQualitySheets(filters, mixed)); continue; }
    const rows: WorkbookCell[][] = [["维度值", "指标", "当前值", "单位", "对比值", "差值", "变化率或百分点", "状态"]];
    for (const row of acquisitionRows(dimension, filters)) for (const id of DETAIL_METRICS[dimension]) {
      const value = row.values[id];
      const baseline = compared ? row.baseline[id] : null, scale = metricUnit(id) === "%" ? 100 : 1;
      const delta = value !== null && baseline !== null ? value - baseline : null;
      rows.push([row.name, acquisitionMetric(id).name, value === null ? null : value * scale, metricUnit(id), baseline === null ? null : baseline * scale, delta === null ? null : delta * scale, delta === null ? null : scale === 100 ? delta * 100 : baseline === 0 ? null : delta / baseline! * 100, value === null ? "未产出" : "完整"]);
    }
    sheets.push({ name: `${index + 3 < 10 ? "0" : ""}${index + 3}_增长效果_${["来源渠道", "下载目标", "获客类型"][index]}`, rows });
  }
  if(scope !== "settlement") for(const [dimension,daily,prior] of [["下载目标",downloadTargetDaily(filters),downloadTargetDaily(acquisitionBaseline(filters))],["新增来源",sourceDaily(filters),sourceDaily(acquisitionBaseline(filters))]] as const) {
    sheets.push({name:`07_${dimension}逐日结果`,rows:[["日期","分组","数值","单位","总体基数","占比（%）","对比日期","对比值","状态"],...daily.flatMap((point,index)=>{const total=Object.values(point.values).reduce((a,b)=>a+b,0),missing=mixed&&dimension==="下载目标";return Object.entries(point.values).map(([group,value])=>[point.date,group,missing?null:value,dimension==="下载目标"?"次":"人",dimension==="下载目标"&&!missing?total:null,dimension==="下载目标"&&!missing&&total?value/total*100:null,compared?prior[index].date:null,compared?prior[index].values[group]:null,missing?"未产出":"合成演示数据"]);})]});
  }
  if (scope !== "growth") sheets.push({ name: "06_渠道结算_扣后", rows: [["结算渠道", "指标", "当前值", "对比值", "差值", "状态"], ...acquisitionRows("settlement", filters).map(row => [row.name, acquisitionMetric("M011").name, row.values.M011, compared ? row.baseline.M011 : null, compared ? row.values.M011! - row.baseline.M011! : null, row.state])] });
  sheets.push({ name: "99_数据状态与限制", rows: [["对象", "说明"], ["正式服务", "未接入真实查询与下载服务；本文件仅供体验核对"], ["注册转化", "按权威 IP·天分母；趋势参考，非精确用户漏斗"], ["下载目标", "不支持注册转化率，不生成空列或补零"], ["获客类型", "只支持新增用户数"], ["客户端平台", "待权威确认及真实查询准入"], ["异常状态", mixed ? "访问趋势包含真实 0；下载未产出；访问下载率部分；激活失败可单卡恢复；未归类渠道去重转化缺失" : "正常演示快照"], ["已恢复指标", recovered.map(id => acquisitionMetric(id).name).join("、") || "无"], ["结算边界", "扣后新增不作为增长、转化、留存分母"]] });
  return sheets;
}
export function exportAcquisition(filters: AcquisitionFilters, mixed: boolean, recovered: string[], scope: "board" | "growth" | "settlement" = "board") { downloadPreviewWorkbook(scope === "board" ? "获客与新增" : scope === "growth" ? "增长效果" : "渠道结算-扣后", acquisitionWorkbook(filters, mixed, recovered, scope)); }

export function acquisitionDimensionWorkbook(filters: AcquisitionFilters, dimension: "target" | "type"): WorkbookSheet[] {
  const label = dimension === "target" ? "下载目标" : "获客类型";
  const sheetName = dimension === "target" ? "04_增长效果_下载目标" : "05_增长效果_获客类型";
  const result = acquisitionWorkbook(filters, false, [], "growth").find(sheet => sheet.name === sheetName)!;
  return [
    { name: "00_导出说明", rows: [["数据性质", "演示数据，不用于经营决策或结算"], ["结果范围", `全部${label}结果，不受搜索、分页和变化显隐限制`], ["当前日期", acquisitionRangeLabel(filters)], ["对比日期", filters.comparison === "none" ? "不对比" : acquisitionRangeLabel(acquisitionBaseline(filters))], ["指标权威版本", definitions.authorityVersion], ["比率单位", "当前值和基准值为百分数，差值为百分点"]] },
    result,
    { name: "99_数据状态与限制", rows: [["分组", label], ["边界", dimension === "target" ? "下载目标不是注册客户端，不展示落地页下载点击-注册或落地页访问-注册转化率" : "只比较新增用户数；不求和构造总体或占比"], ["空值", "未提供结果保持空白，0保留为数值"]] }
  ];
}
