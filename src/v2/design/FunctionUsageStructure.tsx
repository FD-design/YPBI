import { useMemo, type ReactElement } from "react";
import { PivotTable } from "../../components/ui/PivotTable";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import type { DateRangeValue } from "../../components/ui/date-range-model";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { demoPrevious, demoRangeLabel } from "./extended-board-model";
import { functionBasis, functionObservations, functionResult, percentage } from "./function-preview-model";
import { CalculationEvidence } from "../features/dashboards/CalculationEvidence";
import { USAGE_CLIENTS, USAGE_AUDIENCES, usageScopeLabel, type UsageScope } from "./usage-observation-fixtures";
import type { WorkbookSheet } from "./preview-workbook";

export function functionTrendSheet(items: { id: string; name: string; zeroSample: boolean }[], range: DateRangeValue, compared: boolean, scope: UsageScope): WorkbookSheet {
  return { name: "02_功能趋势", rows: [["周期", "功能", "记录类型", "日期 / 范围", "客户端与人群", "渗透率（%）", "使用用户数", "同范围活跃用户数", "状态"], ...items.flatMap(item => [{ label: "当前期", range, zero: item.zeroSample }, ...(compared ? [{ label: "对比期", range: demoPrevious(range), zero: false }] : [])].flatMap(period => {
    const observations = functionObservations(item.id, period.range, period.zero);
    return [
      { date: demoRangeLabel(period.range), type: "摘要", ...functionResult(item.id, period.range, scope, period.zero) },
      ...observations.daily.filter(row => row.scope.client === scope.client && row.scope.audience === scope.audience).map(row => ({ ...row, type: "趋势", rate: row.active ? row.users / row.active : null })),
    ].map(row => [period.label, item.name, row.type, row.date, usageScopeLabel(scope), row.rate === null ? null : row.rate * 100, row.users, row.active, row.rate === null ? "活跃用户基数为0" : "完整"]);
  }))] };
}

export function functionStructureSheet(id: string, name: string, range: DateRangeValue, compared: boolean, zero: boolean): WorkbookSheet {
  const periods = [{ label: "当前期", range, zero }, ...(compared ? [{ label: "对比期", range: demoPrevious(range), zero: false }] : [])];
  return { name: "03_功能结构", rows: [["周期", "开始日期", "结束日期", "功能", "分组", "渗透率（%）", "使用用户数", "同范围活跃用户数", "状态"], ...periods.flatMap(period => {
    const observations = functionObservations(id, period.range, period.zero);
    return [...observations.summary.map(row => [period.label, period.range.start, period.range.end, name, usageScopeLabel(row.scope), row.active ? row.users / row.active * 100 : null, row.users, row.active, row.active ? "完整" : "活跃用户基数为0"]), ...observations.acquisition.map(row => [period.label, period.range.start, period.range.end, name, `获客类型 · ${row.name}`, row.active ? row.users / row.active * 100 : null, row.users, row.active, row.active ? "完整" : "活跃用户基数为0"])];
  })] };
}

export function FunctionUsageStructure({ id, name, range, compared, zero, scope, focused, onScope, exportAction, acquisitionOpen }: {
  id: string; name: string; range: DateRangeValue; compared: boolean; zero: boolean; scope: UsageScope; focused: boolean; onScope: (scope: UsageScope) => void; exportAction: ReactElement; acquisitionOpen: boolean;
}) {
  const observations = useMemo(() => functionObservations(id, range, zero), [id, range.start, range.end, zero]);
  const sheet = useMemo(() => functionStructureSheet(id, name, range, compared, zero), [id, name, range.start, range.end, compared, zero]);
  const result = (client: UsageScope["client"], audience: UsageScope["audience"]) => functionResult(id, range, { client, audience }, zero);
  return <DashboardPanel title={`${name}使用结构`} guidanceKey="function.structure" note={`${demoRangeLabel(range)} · 当前聚焦 ${usageScopeLabel(scope)} · 单功能范围不改变上方50项总体列表`} tools={exportAction}>
    <PivotTable label="功能使用二维交叉表" rowHeading="客户端" columns={USAGE_AUDIENCES.map(item => item.label)} rows={USAGE_CLIENTS.map(client => ({ key: client.value, label: client.label, values: USAGE_AUDIENCES.map(audience => percentage(result(client.value, audience.value).rate)) }))} selectedCell={focused ? { rowKey: scope.client, columnIndex: USAGE_AUDIENCES.findIndex(item => item.value === scope.audience) } : null} onSelectCell={({ rowKey, columnIndex }) => onScope({ client: rowKey as UsageScope["client"], audience: USAGE_AUDIENCES[columnIndex].value })} canSelectCell={({ rowKey, columnIndex }) => result(rowKey as UsageScope["client"], USAGE_AUDIENCES[columnIndex].value).rate !== null} />
    <p className="dashboard-table-context">格内只显示渗透率结果；总体独立去重，新老用户跨日可重叠，不相加回推总体。点击格子聚焦同一范围。</p>
    <details className="function-preview__calculation"><summary>查看当前格计算依据</summary><CalculationEvidence basis={functionBasis(result(scope.client, scope.audience), `${demoRangeLabel(range)} · ${usageScopeLabel(scope)}`)} /></details>
    <details className="function-preview__acquisition" open={acquisitionOpen || undefined}><summary>获客类型结构 · 总体范围</summary><PaginatedTable label="功能获客类型结构" columnCount={5} head={<tr><th>获客类型</th><th>使用用户数</th><th>同范围活跃用户数</th><th>渗透率</th><th>状态</th></tr>} rows={observations.acquisition.map(row => <tr key={row.name}><td>{row.name}</td><td>{row.users.toLocaleString()}</td><td>{row.active.toLocaleString()}</td><td>{percentage(row.active ? row.users / row.active : null)}</td><td>{row.active ? "完整" : "活跃用户基数为0"}</td></tr>)} /><p className="dashboard-table-context">获客类型保留独立总体结构；不与客户端／人群筛选拼接。未归因样本单列。</p></details>
    <ChartDataTable title="功能结构同口径数据表" exportAction={exportAction}><PaginatedTable label="功能结构结果" columnCount={9} head={<tr>{sheet.rows[0].map((cell, index) => <th key={index}>{cell}</th>)}</tr>} rows={sheet.rows.slice(1).map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell ?? "—"}</td>)}</tr>)} /></ChartDataTable>
  </DashboardPanel>;
}
