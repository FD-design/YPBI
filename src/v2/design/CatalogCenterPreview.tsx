import { ReviewTools } from "../components/ReviewTools";
import { useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { v2MetricDefinitionsDataSchema } from "../../../contracts/bi-v2";
import metricSnapshot from "../../../server/v2/generated/metric-definitions.json";
import eventSnapshot from "./generated/event-catalog-preview.json";
import { MetricCatalogPage } from "../pages/MetricCatalogPage";
import { CatalogHeader, CatalogLayout } from "../features/catalog/CatalogLayout";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { Button } from "../../components/ui/Button";
import { MetricReadingDialog } from "../features/dashboards/MetricReadingDialog";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { downloadPreviewWorkbook } from "./preview-workbook";
import { Toast, useToast } from "../../components/ui/Toast";
import { StatePanel } from "../components/StatePanel";
import "./topic-previews.css";
import "./catalog-center-preview.css";

const loadMetricSnapshot = async () => v2MetricDefinitionsDataSchema.parse(metricSnapshot);
type EventItem = typeof eventSnapshot.items[number];
function EventFields({ fields, title }: { fields: EventItem["fields"]; title: string }) {
  return <section className="catalog-detail-field"><h3>{title}</h3><PaginatedTable label={title} columnCount={7} head={<tr><th>属性 / 标识</th><th>类型</th><th>来源</th><th>定义 / 取值</th><th>筛选</th><th>分组</th><th>聚合</th></tr>} rows={fields.map(field => <tr key={field.id}><td>{field.name}<small className="topic-preview__content-id">{field.id}</small></td><td>{field.type}</td><td>{field.layer}</td><td>{field.range}{field.enums.length > 0 && <details><summary>查看完整取值</summary><ul>{field.enums.map(item => <li key={item.value}>{item.value}：{item.label}</li>)}</ul></details>}</td><td>未接入</td><td>未接入</td><td>未接入</td></tr>)} /></section>;
}
function EventDetail({ event }: { event: EventItem }) {
  const specific = event.fields.filter(field => !["公共字段", "平台生成"].includes(field.layer));
  const common = event.fields.filter(field => ["公共字段", "平台生成"].includes(field.layer));
  return <>
    <section className="catalog-detail-field"><h3>权威定义</h3><dl className="v2-detail-list"><div><dt>事件标识</dt><dd>{event.id}</dd></div><div><dt>业务模块</dt><dd>{event.module}</dd></div><div><dt>事件版本</dt><dd>{event.version} · {event.definitionStatus}</dd></div><div><dt>定义</dt><dd>{event.definition}</dd></div><div><dt>触发时机</dt><dd>{event.trigger}</dd></div><div><dt>权威上报端</dt><dd>{event.source}</dd></div><div><dt>频次与去重</dt><dd>{event.frequency} · {event.dedupKey}</dd></div><div><dt>来源</dt><dd>{eventSnapshot.source} · {eventSnapshot.document.documentVersion} · {event.updated}</dd></div></dl>{event.notTrigger.length > 0 && <details><summary>不触发边界</summary><ul>{event.notTrigger.map((text, i) => <li key={i}>{text}</li>)}</ul></details>}</section>
    <section className="catalog-detail-field"><h3>交付与查询状态</h3><dl className="v2-detail-list"><div><dt>实施状态</dt><dd>未核对 · 尚无开发实施状态接口</dd></div><div><dt>实际数据 / 水位</dt><dd>未核对 · 尚无采集与完整性状态接口</dd></div><div><dt>最近数据时间</dt><dd>—</dd></div><div><dt>YPBI 查询</dt><dd>未接入</dd></div><div><dt>验数</dt><dd>未验数</dd></div><div><dt>真实使用位置</dt><dd>引用查询未接入，尚未核对</dd></div></dl></section>
    <EventFields title="事件专属与页面属性" fields={specific} /><details className="catalog-detail-field"><summary>公共与平台属性（{common.length} 项）</summary><EventFields title="公共与平台属性" fields={common} /></details>
    <p className="catalog-status">定义、实施、数据、查询与验数均满足后才能进入分析。当前未开放事件分析与漏斗分析。</p>
  </>;
}
function EventCatalog() {
  const [module, setModule] = useState("all"), [search, setSearch] = useState(""), [status, setStatus] = useState("all"), [event, setEvent] = useState<EventItem | null>(null), { notice, notify } = useToast();
  const rows = useMemo(() => eventSnapshot.items.filter(event => (module === "all" || event.module === module) && (status !== "available") && `${event.name} ${event.id} ${event.definition}`.toLowerCase().includes(search.toLowerCase().trim())), [module, search, status]);
  const exportAction = <PreviewExportControl name="事件目录" context="权威文档只读投影；未接入真实实施、数据和查询状态" scope="当前搜索与分类下的完整定义目录，不含原始事件和用户记录。" pending={false} onDownloadPreview={() => downloadPreviewWorkbook("事件定义目录", [{ name: "00_来源与范围", rows: [["来源", eventSnapshot.source], ["权威版本", eventSnapshot.document.documentVersion], ["源文件日期", eventSnapshot.document.updated], ["SHA256", eventSnapshot.sourceSha256], ["状态边界", "实施和数据未核对；YPBI 未接入、未验数。此文件是定义目录，不是业务结果。"]] }, { name: "01_事件目录", rows: [["模块", "事件名称", "事件标识", "版本", "定义状态", "定义", "触发时机", "上报端"], ...rows.map(event => [event.module, event.name, event.id, event.version, event.definitionStatus, event.definition, event.trigger, event.source])] }])} />;
  return <div className="v2-page catalog-page" data-page="event-catalog"><CatalogHeader title="事件中心" description="查看权威事件定义、属性与各层能力状态。文档登记不代表已有真实数据。" actions={<div className="topic-preview__controls">{exportAction}<Button icon={RefreshCw} onClick={() => notify("已重新读取本地权威投影；未请求生产采集状态")}>刷新目录</Button></div>} />
    <section className="v2-catalog-snapshot" aria-label="事件目录同步信息"><span><b>权威定义只读投影</b></span><dl><div><dt>文档版本</dt><dd>{eventSnapshot.document.documentVersion}</dd></div><div><dt>源文件日期</dt><dd>{eventSnapshot.document.updated}</dd></div><div><dt>事件数量</dt><dd>{eventSnapshot.items.length}</dd></div><div><dt>真实状态</dt><dd>实施 / 数据待核对，查询未接入</dd></div></dl></section>
    <CatalogLayout navigation={<nav className="v2-category-rail" aria-label="事件业务模块"><div className="v2-category-rail__head"><b>业务模块</b><small>随权威源同步</small></div><div className="v2-category-mobile"><MenuSelect label="业务模块" ariaLabel="事件业务模块" value={module} onChange={setModule} groups={[{ label: "业务模块", options: [{ value: "all", label: "全部事件" }, ...eventSnapshot.modules.map(value => ({ value, label: value }))] }]} /></div><div className="v2-category-list">{["all", ...eventSnapshot.modules].map(value => <button key={value} type="button" className={module === value ? "is-selected" : ""} aria-pressed={module === value} onClick={() => setModule(value)}><span>{value === "all" ? "全部事件" : value}</span><small>{value === "all" ? eventSnapshot.items.length : eventSnapshot.items.filter(event => event.module === value).length}</small></button>)}</div></nav>}>
      <section className="v2-catalog-tools" aria-label="事件目录工具"><label className="v2-search ui-search"><Search /><input aria-label="搜索事件" placeholder="搜索名称、事件标识或定义" value={search} onChange={e => setSearch(e.target.value.slice(0, 120))} /></label><MenuSelect label="事件状态" ariaLabel="事件状态" value={status} onChange={setStatus} groups={[{ label: "查询状态", options: [{ value: "all", label: "全部状态" }, { value: "not_connected", label: "查询未接入" }, { value: "available", label: "可分析" }] }]} /><span>当前 {rows.length} / {eventSnapshot.items.length} 项</span></section>
      {rows.length ? <section className="v2-table-surface" aria-label="事件目录结果"><PaginatedTable label="事件目录" columnCount={7} resetKey={[module, search, status].join("|")} head={<tr><th>事件 / 标识</th><th>业务模块</th><th>定义摘要</th><th>版本 / 定义状态</th><th>实施 / 数据</th><th>查询 / 验数</th><th>操作</th></tr>} rows={rows.map(event => <tr key={event.id}><td><button type="button" className="catalog-name" onClick={() => setEvent(event)}>{event.name}<small>{event.id}</small></button></td><td>{event.module}</td><td>{event.definition}</td><td>{event.version} · {event.definitionStatus}</td><td>未核对</td><td>未接入 · 未验数</td><td><button type="button" onClick={() => setEvent(event)}>查看详情</button></td></tr>)} /></section> : <StatePanel compact kind="empty" title="没有匹配的事件" description="请调整搜索或模块；当前没有已接入并通过验数的事件。" />}
    </CatalogLayout>
    {event && <MetricReadingDialog title={event.name} content={<EventDetail event={event} />} onClose={() => setEvent(null)} />}{notice && <Toast notice={notice} onClose={() => notify(null)} />}
  </div>;
}
export default function CatalogCenterPreview({ kind }: { kind: "metrics" | "events" }) { return <><ReviewTools><div className="catalog-preview-notice">本地目录体验 · 定义来自权威文件；正式身份、同步与业务查询保持独立准入。</div></ReviewTools>{kind === "metrics" ? <MetricCatalogPage loadDefinitions={loadMetricSnapshot} /> : <EventCatalog />}</>; }
