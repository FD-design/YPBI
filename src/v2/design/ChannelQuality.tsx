import { useMemo, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Info, Table2 } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Pagination } from "../../components/ui/Pagination";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { FloatingHint } from "../../components/ui/FloatingHint";
import { ChangeValue } from "../../components/ui/ChangeValue";
import { changeDirection } from "../../components/ui/change-presentation";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { CalculationEvidence } from "../features/dashboards/CalculationEvidence";
import { acquisitionMetric, acquisitionRangeLabel, type AcquisitionFilters } from "./acquisition-preview-model";
import type { AcquisitionDetailReading } from "./acquisition-view-state";
import { downloadPreviewWorkbook } from "./preview-workbook";
import { CHANNEL_QUALITY_GROUPS, CHANNEL_QUALITY_IDS, CHANNEL_QUALITY_WATERMARK, channelQualityChange, channelQualityGroup, channelQualityRows, channelQualitySheets, channelQualityValue, filterChannelQualityRows, readChannelQuality, type ChannelQualityReading, type ChannelQualityRow } from "./acquisition-channel-quality";
import "./acquisition-channel-quality.css";

type Props = { filters: AcquisitionFilters; mixed: boolean; pending: boolean; detail: AcquisitionDetailReading; update: (patch: Partial<AcquisitionDetailReading>) => void; open: (title: string, content: ReactNode) => void };
const input = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
export function exportChannelQuality(filters: AcquisitionFilters, mixed: boolean) {
  downloadPreviewWorkbook("渠道质量", [{ name: "00_导出说明", rows: [["项目", "内容"], ["数据来源", "演示数据；独立渠道观察事实，不代表已接入真实渠道用户关联"], ["日期", acquisitionRangeLabel(filters)], ["范围", "全部渠道、四个指标组和全部逐日依据，不受搜索、排序、分页和指标组选择裁剪"], ["币种", "USD（演示币种）"], ["数据至", CHANNEL_QUALITY_WATERMARK]] }, ...channelQualitySheets(filters, mixed)]);
}

export function ChannelQuality({ filters, mixed, pending, detail, update, open }: Props) {
  const source = useMemo(() => channelQualityRows(filters, mixed), [filters, mixed]);
  const group = channelQualityGroup(detail.qualityGroup), ids: readonly string[] = group.ids;
  const sortId = CHANNEL_QUALITY_IDS.includes(detail.sort.id) ? detail.sort.id : "M008";
  const rows = filterChannelQualityRows(source, detail.search, sortId, detail.sort.descending);
  const page = Math.min(detail.page, Math.max(0, Math.ceil(rows.length / 50) - 1));
  const exportAction = <PreviewExportControl name="渠道质量完整明细" scope="全部渠道、四个指标组、实际计算输入及逐日状态，不受搜索、分页和指标组选择限制。" context={`${acquisitionRangeLabel(filters)} · 演示数据 · 付费价值为注册当日 USD`} pending={pending} onDownloadPreview={() => exportChannelQuality(filters, mixed)} />;
  const openMetric = (row: ChannelQualityRow, id: string) => open(`${row.name} · ${acquisitionMetric(id).name}`, <ChannelMetricDetails row={row} id={id} exportAction={exportAction} />);
  return <div className="channel-quality" data-data-origin="demo">
    <div className="channel-quality__toolbar"><SegmentedControl label="渠道质量指标组" value={group.value} options={CHANNEL_QUALITY_GROUPS.map(item => ({ value: item.value, label: item.label }))} onChange={qualityGroup => update({ qualityGroup })} /><span className="channel-quality__sort">按{acquisitionMetric(sortId).name}{detail.sort.descending ? "降序" : "升序"}</span><Button size="sm" icon={Table2} onClick={() => open("渠道质量完整明细", <ChannelQualityAll rows={source} exportAction={exportAction} />)}>完整明细</Button></div>
    <p className="channel-quality__scope">{group.scope}{filters.comparison !== "none" && " 对比按相同可观察批次对齐。"}</p>
    <div className="v2-table-scroll ui-result-table__viewport" tabIndex={0} role="region" aria-label="渠道质量结果"><table className="acquisition-preview__table"><thead><tr><th>来源渠道</th>{ids.map(id => <th key={id} className="is-number" aria-sort={sortId === id ? detail.sort.descending ? "descending" : "ascending" : "none"}><div className="acquisition-preview__column"><FloatingHint content={acquisitionMetric(id).definition}><button type="button" aria-label={`查看${acquisitionMetric(id).name}说明`} onClick={() => open(acquisitionMetric(id).name, <><p>{acquisitionMetric(id).definition}</p><p>{group.scope}</p></>)}>{acquisitionMetric(id).name}<Info aria-hidden="true" /></button></FloatingHint><button type="button" aria-label={`排序${acquisitionMetric(id).name}`} onClick={() => update({ sort: { id, descending: sortId === id ? !detail.sort.descending : true }, page: 0 })}>{sortId === id ? detail.sort.descending ? <ArrowDown /> : <ArrowUp /> : <ArrowUpDown />}</button></div></th>)}</tr></thead>
      <tbody>{rows.slice(page * 50, page * 50 + 50).map(row => <tr key={row.name}><td><button type="button" className="acquisition-preview__value" onClick={() => open(`${row.name} · 渠道质量`, <ChannelQualityAll rows={[row]} exportAction={exportAction} />)}>{row.name}</button></td>{ids.map(id => {
        const { current, previous } = row.metrics[id], change = channelQualityChange(id, current.value, previous?.value);
        return <td key={id} className="is-number"><FloatingHint content={<><p>当前：{channelQualityValue(id, current.value)} · {current.status}</p>{previous && <p>对比：{channelQualityValue(id, previous.value)} · {previous.status}</p>}{current.basis && <p>{current.basis.numerator.name} {input(current.basis.numerator.value)} / {current.basis.denominator.name} {input(current.basis.denominator.value)}</p>}<p>成熟 {current.mature}/{current.batches} 批 · 点击查看逐日依据</p></>}><button type="button" className="acquisition-preview__value" aria-label={`${row.name} · ${acquisitionMetric(id).name}详情`} onClick={() => openMetric(row, id)}>{channelQualityValue(id, current.value)}</button></FloatingHint>{current.status !== "完整" && <small className="channel-quality__status">{current.status === "部分" ? `成熟 ${current.mature}/${current.batches} 批` : current.status}</small>}{previous && detail.showChange !== "none" && <div className="ui-metric-comparison"><ChangeValue direction={change ? changeDirection(change.value) : null}>{change?.label ?? "不可比"}</ChangeValue></div>}</td>;
      })}</tr>)}{!rows.length && <tr><td colSpan={ids.length + 1}>没有匹配的渠道结果</td></tr>}</tbody></table></div>
    <Pagination label="获客明细分页" total={rows.length} page={page} pageSize={50} onPage={page => update({ page })} />
  </div>;
}
function ChannelMetricDetails({ row, id, exportAction }: { row: ChannelQualityRow; id: string; exportAction: ReactNode }) {
  const { current, previous } = row.metrics[id];
  const periods = [{ label: "当前", reading: current, facts: row.facts }, ...(previous ? [{ label: "对比", reading: previous, facts: row.previousFacts }] : [])];
  return <div className="channel-quality__reading"><p>{acquisitionMetric(id).definition}</p><div className="channel-quality__reading-summary">{periods.map(period => <section key={period.label}><span>{period.label}</span><strong>{channelQualityValue(id, period.reading.value)}</strong><small>{period.reading.scope}</small><span>{period.reading.status}</span>{period.reading.basis && <CalculationEvidence compact basis={period.reading.basis} />}</section>)}</div><p className="channel-quality__scope">逐日结果保留各自状态；汇总对比只使用当前与对比均可观察的相同批次位置，不包含尚未成熟批次。</p>
    <PaginatedTable label="渠道指标逐日依据" columnCount={7} head={<tr><th>周期</th><th>业务/注册日期</th><th>结果</th><th>{current.basis?.numerator.name ?? previous?.basis?.numerator.name ?? "分子"}</th><th>{current.basis?.denominator.name ?? previous?.basis?.denominator.name ?? "分母"}</th><th>状态</th><th>观察截止日</th></tr>} rows={periods.flatMap(period => period.facts.map(fact => { const reading = readChannelQuality(id, [fact]); return <tr key={`${period.label}-${fact.date}`}><td>{period.label}</td><td>{fact.date}</td><td>{channelQualityValue(id, reading.value)}</td><td>{input(reading.basis?.numerator.value)}</td><td>{input(reading.basis?.denominator.value)}</td><td>{reading.status}</td><td>{CHANNEL_QUALITY_WATERMARK}</td></tr>; }))} />{exportAction}</div>;
}
function ChannelQualityAll({ rows, exportAction }: { rows: ChannelQualityRow[]; exportAction: ReactNode }) {
  const resultRow = (row: ChannelQualityRow, id: string, label: string, reading: ChannelQualityReading) => <tr key={`${row.name}-${id}-${label}`}><td>{row.name}</td><td>{acquisitionMetric(id).name}</td><td>{label}</td><td>{channelQualityValue(id, reading.value)}</td><td>{reading.basis?.numerator.name ?? "—"}</td><td>{input(reading.basis?.numerator.value)}</td><td>{reading.basis?.denominator.name ?? "—"}</td><td>{input(reading.basis?.denominator.value)}</td><td>{reading.mature}/{reading.batches}</td><td>{reading.status}</td></tr>;
  return <div className="channel-quality__reading"><p>演示数据 · 同一渠道注册批次，首次体验、留存与注册当日付费分别使用自身观察窗口；金额为 USD。</p><details><summary>查看各指标口径</summary>{CHANNEL_QUALITY_GROUPS.map(group => <section key={group.value}><h3>{group.label}</h3><p>{group.scope}</p><ul>{group.ids.map(id => <li key={id}>{acquisitionMetric(id).name}：{acquisitionMetric(id).definition}</li>)}</ul></section>)}</details>
    <PaginatedTable label="渠道质量全部结果" columnCount={10} head={<tr><th>渠道</th><th>指标</th><th>周期</th><th>结果</th><th>分子名称</th><th>分子值</th><th>分母名称</th><th>分母值</th><th>成熟批次</th><th>状态</th></tr>} rows={rows.flatMap(row => CHANNEL_QUALITY_IDS.flatMap(id => { const { current, previous } = row.metrics[id]; return [resultRow(row, id, "当前", current), ...(previous ? [resultRow(row, id, "对比", previous)] : [])]; }))} />{exportAction}</div>;
}
