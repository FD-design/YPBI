import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { BarChart3, Boxes, CalendarDays, Database, GripVertical, LayoutDashboard, Plus, RefreshCw, Save, Settings2 } from "lucide-react";
import "./styles.css";

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

type DatasetId = "overview" | "operations" | "intraday" | "period" | "daily" | "pvTrend" | "aggregate" | "registrationSources" | "renewal" | "adStats" | "channelDaily" | "channelQuality";
type ViewId = "dashboard" | "cards" | "templates" | "sources";
type ChartKind = "kpi" | "line" | "bar" | "table";
type Row = Record<string, string | number | null>;

interface Dataset { id: DatasetId; name: string; description: string; grain: string; path: string; }
interface Product { id: string; name: string; description: string; status: string; datasets: Dataset[]; }
interface Card { id: string; title: string; datasetId: DatasetId; chart: ChartKind; size: "half" | "full"; metric?: string; }
interface Template { id: string; name: string; description: string; cards: Card[]; }
interface QueryResult { definition: Dataset; rows: Row[]; summary: Record<string, number | null>; warnings: string[]; }

const today = new Date();
const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(today.getDate() - 6);
const iso = (date: Date) => date.toISOString().slice(0, 10);

const defaultTemplates: Template[] = [
  { id: "executive", name: "经营总览", description: "先看增长规模，再定位渠道贡献和转化。", cards: [
    { id: "growth-kpi", title: "核心增长指标", datasetId: "channelDaily", chart: "kpi", size: "full" },
    { id: "active-trend", title: "活跃与观影趋势", datasetId: "channelDaily", chart: "line", size: "half", metric: "activeUsers" },
    { id: "channel-growth", title: "渠道新增贡献", datasetId: "channelDaily", chart: "bar", size: "half", metric: "newUsers" },
    { id: "channel-detail", title: "渠道每日明细", datasetId: "channelDaily", chart: "table", size: "full" }
  ]},
  { id: "channel", name: "渠道增长", description: "观察获客、活跃、观影、付费和留存质量。", cards: [
    { id: "channel-quality", title: "渠道质量矩阵", datasetId: "channelQuality", chart: "table", size: "full" },
    { id: "channel-visitors", title: "渠道访客趋势", datasetId: "channelDaily", chart: "line", size: "half", metric: "visitors" },
    { id: "channel-revenue", title: "渠道新增收入", datasetId: "channelDaily", chart: "bar", size: "half", metric: "newRevenue" }
  ]},
  { id: "monetization", name: "收入与续费", description: "聚合充值、VIP 购买与续费表现。", cards: [
    { id: "revenue-kpi", title: "新增收入与 VIP 购买", datasetId: "channelDaily", chart: "kpi", size: "full" },
    { id: "renewal", title: "续费分析", datasetId: "renewal", chart: "table", size: "half" },
    { id: "revenue-trend", title: "新增收入趋势", datasetId: "channelDaily", chart: "line", size: "half", metric: "newRevenue" }
  ]},
  { id: "ads", name: "广告表现", description: "关注广告触达、点击和渠道差异。", cards: [
    { id: "ad-overview", title: "广告统计", datasetId: "adStats", chart: "table", size: "half" },
    { id: "ad-channel", title: "渠道广告点击", datasetId: "channelDaily", chart: "bar", size: "half", metric: "adClicks" },
    { id: "ad-trend", title: "广告点击趋势", datasetId: "channelDaily", chart: "line", size: "full", metric: "adClicks" }
  ]}
];

const metricLabels: Record<string, string> = {
  visitors: "访客数", newUsers: "新增用户", averageActiveUsers: "日均活跃", activeUserDays: "累计活跃人天",
  viewerUserDays: "累计观影人天", adClicks: "广告点击", newRevenue: "新增收入", vipBuyers: "VIP 购买",
  registrationRate: "注册转化率", activeUsers: "活跃用户", viewers: "观影人数", channelName: "渠道", date: "日期"
};

function formatValue(key: string, value: number | null) {
  if (value === null) return "—";
  if (/Rate$/.test(key)) return `${(value * 100).toFixed(1)}%`;
  if (/Revenue|recharge/i.test(key)) return `¥${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
}

function Chart({ rows, metric, kind }: { rows: Row[]; metric: string; kind: "line" | "bar" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    const isLine = kind === "line";
    const grouped = new Map<string, number>();
    rows.forEach((row) => {
      const key = String(isLine ? row.date ?? "" : row.channelName ?? row.channelCode ?? "未知");
      grouped.set(key, (grouped.get(key) ?? 0) + Number(row[metric] ?? 0));
    });
    const items = [...grouped.entries()].sort((a, b) => isLine ? a[0].localeCompare(b[0]) : b[1] - a[1]).slice(0, isLine ? 60 : 12);
    chart.setOption({
      color: ["#2563eb"], animationDuration: 500,
      tooltip: { trigger: "axis", confine: true, valueFormatter: (value: unknown) => Number(value).toLocaleString("zh-CN") },
      grid: { left: 18, right: 14, top: 22, bottom: 12, containLabel: true },
      xAxis: { type: "category", data: items.map(([key]) => key), axisLine: { lineStyle: { color: "#dbe3ef" } }, axisLabel: { color: "#64748b", hideOverlap: true } },
      yAxis: { type: "value", axisLabel: { color: "#64748b" }, splitLine: { lineStyle: { color: "#eef2f7" } } },
      series: [{ type: kind, data: items.map(([, value]) => value), smooth: isLine, symbolSize: 6, lineStyle: { width: 3 }, areaStyle: isLine ? { color: "rgba(37,99,235,.10)" } : undefined, barMaxWidth: 34, itemStyle: { borderRadius: kind === "bar" ? [3, 3, 0, 0] : 0 } }]
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(ref.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [kind, metric, rows]);
  return <div className="chart" ref={ref} />;
}

function DataTable({ rows }: { rows: Row[] }) {
  const columns = useMemo(() => [...new Set(rows.slice(0, 20).flatMap((row) => Object.keys(row)))].slice(0, 18), [rows]);
  if (!rows.length) return <div className="empty">当前筛选范围没有返回明细数据</div>;
  return <div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column}>{metricLabels[column] ?? column}</th>)}</tr></thead><tbody>{rows.slice(0, 100).map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{typeof row[column] === "number" ? formatValue(column, row[column] as number) : String(row[column] ?? "—")}</td>)}</tr>)}</tbody></table></div>;
}

function CardView({ card, dateRange, refreshKey }: { card: Card; dateRange: [string, string]; refreshKey: number }) {
  const [data, setData] = useState<QueryResult | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setState("loading"); setError("");
    fetch("/api/query", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ productId: "newav", datasetId: card.datasetId, dateRange }) })
      .then(async (response) => { const payload = await response.json(); if (!response.ok || !payload.success) throw new Error(payload.error?.message ?? "数据读取失败"); return payload.data as QueryResult; })
      .then((result) => { setData(result); setState("ready"); }).catch((reason) => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "数据读取失败"); setState("error"); } });
    return () => controller.abort();
  }, [card.datasetId, dateRange, refreshKey]);
  const metric = card.metric ?? Object.keys(data?.summary ?? {})[0] ?? "newUsers";
  return <article className={`data-card ${card.size}`}>
    <header><div><h3>{card.title}</h3><span>{data?.definition.grain ?? "读取真实接口"}</span></div><em>{state === "ready" ? "已更新" : state === "loading" ? "读取中" : "异常"}</em></header>
    {state === "loading" && <div className="loading"><i /><span>正在读取 NewAV 数据</span></div>}
    {state === "error" && <div className="error-state"><b>暂时无法显示</b><span>{error}</span></div>}
    {state === "ready" && card.chart === "kpi" && <div className="kpi-grid">{Object.entries(data?.summary ?? {}).slice(0, 9).map(([key, value]) => <div key={key}><span>{metricLabels[key] ?? key}</span><b>{formatValue(key, value)}</b></div>)}</div>}
    {state === "ready" && (card.chart === "line" || card.chart === "bar") && <><div className="chart-caption"><b>{metricLabels[metric] ?? metric}</b><span>{data?.rows.length ?? 0} 条明细参与计算</span></div><Chart rows={data?.rows ?? []} metric={metric} kind={card.chart} /></>}
    {state === "ready" && card.chart === "table" && <DataTable rows={data?.rows ?? []} />}
    {!!data?.warnings.length && <footer>{data.warnings.join("；")}</footer>}
  </article>;
}

function App() {
  const [view, setView] = useState<ViewId>("dashboard");
  const [products, setProducts] = useState<Product[]>([]);
  const [templates, setTemplates] = useState<Template[]>(() => { try { return JSON.parse(localStorage.getItem("ypbi-new-templates") ?? "null") ?? defaultTemplates; } catch { return defaultTemplates; } });
  const [activeTemplateId, setActiveTemplateId] = useState(templates[0].id);
  const [dateRange, setDateRange] = useState<[string, string]>([iso(sevenDaysAgo), iso(today)]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [sourceStatus, setSourceStatus] = useState<{ configured: boolean; baseUrl: string; tokenHint: string } | null>(null);
  const activeTemplate = templates.find((item) => item.id === activeTemplateId) ?? templates[0];
  useEffect(() => { fetch("/api/products").then((response) => response.json()).then((payload) => setProducts(payload.data ?? [])).catch(() => setProducts([])); }, []);
  useEffect(() => { localStorage.setItem("ypbi-new-templates", JSON.stringify(templates)); }, [templates]);
  useEffect(() => { if (view === "sources") fetch("/api/products/newav/status").then((response) => response.json()).then((payload) => setSourceStatus(payload.data)); }, [view]);
  const updateActive = (next: Template) => setTemplates((items) => items.map((item) => item.id === next.id ? next : item));
  const addCard = (datasetId: DatasetId, chart: ChartKind) => updateActive({ ...activeTemplate, cards: [{ id: `card-${Date.now()}`, title: products[0]?.datasets.find((item) => item.id === datasetId)?.name ?? "新分析卡片", datasetId, chart, size: "half" }, ...activeTemplate.cards] });
  const moveCard = (from: number, to: number) => { const cards = [...activeTemplate.cards]; const [item] = cards.splice(from, 1); cards.splice(to, 0, item); updateActive({ ...activeTemplate, cards }); };

  const nav = [
    { id: "dashboard" as const, label: "看板中心", icon: LayoutDashboard }, { id: "cards" as const, label: "卡片库", icon: BarChart3 },
    { id: "templates" as const, label: "模板中心", icon: Boxes }, { id: "sources" as const, label: "数据源", icon: Database }
  ];
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><b>YPBI</b><span>产品数据平台</span></div><div className="product-switch"><span>当前产品</span><button><i>N</i><b>{products[0]?.name ?? "NewAV"}</b><small>首个接入产品</small></button><button className="icon-button" title="添加产品"><Plus size={18} /></button></div><div className="top-actions"><span className={sourceStatus?.configured === false ? "status bad" : "status"}>{sourceStatus?.configured === false ? "数据源待配置" : "独立产品空间"}</span></div></header>
    <aside className="sidebar"><nav>{nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><item.icon size={19} /><span>{item.label}</span></button>)}</nav><div className="side-note"><b>产品隔离</b><span>指标、接口和模板均属于 NewAV，不参与旧平台汇总。</span></div></aside>
    <main>
      {view === "dashboard" && <><section className="page-head"><div><span>NEWAV / ANALYTICS</span><h1>{activeTemplate.name}</h1><p>{activeTemplate.description}</p></div><div className="filters"><label><CalendarDays size={17} /><input type="date" value={dateRange[0]} onChange={(event) => setDateRange([event.target.value, dateRange[1]])} /><i>至</i><input type="date" value={dateRange[1]} onChange={(event) => setDateRange([dateRange[0], event.target.value])} /></label><button onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={17} />刷新</button><button className={editing ? "primary" : ""} onClick={() => setEditing(!editing)}><Settings2 size={17} />{editing ? "完成编辑" : "编辑看板"}</button></div></section>
        <div className="template-tabs">{templates.map((template) => <button key={template.id} className={template.id === activeTemplate.id ? "active" : ""} onClick={() => setActiveTemplateId(template.id)}><b>{template.name}</b><span>{template.cards.length} 张卡片</span></button>)}</div>
        <section className="dashboard-grid">{activeTemplate.cards.map((card, index) => <div key={card.id} className="card-wrap" draggable={editing} onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => moveCard(Number(event.dataTransfer.getData("text/plain")), index)}>{editing && <div className="edit-strip"><GripVertical size={16} /><span>拖动排序</span><button onClick={() => updateActive({ ...activeTemplate, cards: activeTemplate.cards.filter((item) => item.id !== card.id) })}>移除</button></div>}<CardView card={card} dateRange={dateRange} refreshKey={refreshKey} /></div>)}</section></>}
      {view === "cards" && <section className="workspace"><div className="workspace-head"><div><span>分析资产</span><h1>卡片库</h1><p>从产品已开放的数据集生成卡片，再加入任意模板。</p></div></div><div className="asset-grid">{products[0]?.datasets.map((dataset) => <article key={dataset.id}><div className="asset-icon"><BarChart3 size={20} /></div><h3>{dataset.name}</h3><p>{dataset.description}</p><span>{dataset.grain}</span><div>{(["kpi", "line", "bar", "table"] as ChartKind[]).map((kind) => <button key={kind} onClick={() => { addCard(dataset.id, kind); setView("dashboard"); }}>{kind === "kpi" ? "指标" : kind === "line" ? "趋势" : kind === "bar" ? "排行" : "明细"}</button>)}</div></article>)}</div></section>}
      {view === "templates" && <section className="workspace"><div className="workspace-head"><div><span>组合与复用</span><h1>模板中心</h1><p>模板属于当前产品，后续产品拥有各自独立模板。</p></div><button className="primary" onClick={() => setTemplates((items) => [{ id: `template-${Date.now()}`, name: "新建模板", description: "NewAV 自定义分析模板", cards: [] }, ...items])}><Plus size={17} />新建模板</button></div><div className="template-manager">{templates.map((template) => <article key={template.id}><label>模板名称<input value={template.name} onChange={(event) => setTemplates((items) => items.map((item) => item.id === template.id ? { ...item, name: event.target.value } : item))} /></label><p>{template.description}</p><span>{template.cards.length} 张卡片</span><div><button onClick={() => { setActiveTemplateId(template.id); setView("dashboard"); }}>打开</button><button disabled={templates.length === 1} onClick={() => setTemplates((items) => items.filter((item) => item.id !== template.id))}>删除</button></div></article>)}</div></section>}
      {view === "sources" && <section className="workspace"><div className="workspace-head"><div><span>产品连接</span><h1>数据源</h1><p>NewAV 使用独立后台地址和 Bearer Token，不复用旧 BI 凭据。</p></div></div><article className="source-panel"><div className="source-logo">N</div><div><h3>NewAV 管理后台</h3><p>{sourceStatus?.baseUrl || "https://newav0.com"}</p></div><span className={sourceStatus?.configured ? "connected" : "pending"}>{sourceStatus?.configured ? "已配置" : "等待配置"}</span><dl><div><dt>鉴权方式</dt><dd>Bearer Token</dd></div><div><dt>Token</dt><dd>{sourceStatus?.tokenHint ?? "未配置"}</dd></div><div><dt>统计接口</dt><dd>{products[0]?.datasets.length ?? 12} 个</dd></div></dl><div className="source-help"><Settings2 size={18} /><p>在服务端 `.env.local` 设置 <code>NEWAV_ACCESS_TOKEN</code>。Token 不写入浏览器、模板或 GitHub。</p></div></article></section>}
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
