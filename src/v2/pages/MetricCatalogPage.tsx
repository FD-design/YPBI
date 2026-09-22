import { useDialogBackdrop } from "../../components/ui/useDialogBackdrop";
import { ArrowRight, BookOpenText, CheckCircle2, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MetricDefinitionItem } from "../../../contracts/bi-v2";
import { useBodyScrollLock } from "../../components/layout/useBodyScrollLock";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { fetchMetricDefinitions } from "../api/client";
import { useV2Resource } from "../api/useV2Resource";
import { ProductLink } from "../app/router";
import { RefreshNotice, ResourceFailurePanel, StatePanel } from "../components/StatePanel";
import { formatMetricAuthorityText, hideInternalReferenceCodes, metricBusinessExplanation } from "../features/metrics/metric-presentation";
import { CatalogHeader, CatalogLayout } from "../features/catalog/CatalogLayout";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import type { V2MetricDefinitionsData } from "../../../contracts/bi-v2";

type ReadinessFilter = "all" | "available" | "pending_validation" | "not_connected" | "attention";

const SOURCE_STATUS_TONES: Record<MetricDefinitionItem["authority"]["sourceBuildStatus"]["code"], string> = {
  tech_claimed_pending_validation: "warning",
  definition_pending_confirmation: "warning",
  tracking_draft: "neutral",
  platform_processing_required: "warning",
  capability_missing: "neutral"
};

const VALIDATION_LABELS: Record<MetricDefinitionItem["validation"]["status"], string> = {
  not_started: "未验数",
  running: "验数中",
  passed: "验数通过",
  failed: "验数失败",
  expired: "验数已过期"
};

const MAPPING_LABELS: Record<MetricDefinitionItem["ypbiMapping"]["status"], string> = {
  not_configured: "未接入",
  configured: "已映射",
  stale: "映射待更新",
  disabled: "接入已停用"
};

const REASON_LABELS: Record<MetricDefinitionItem["analysis"]["reasonCodes"][number], string> = {
  mapping_not_configured: "尚未配置 YPBI 查询映射",
  mapping_stale: "指标版本变化后映射尚未更新",
  mapping_disabled: "当前查询映射已停用",
  validation_not_passed: "真实数据验数尚未通过",
  validation_mapping_mismatch: "验数证据与当前指标或映射版本不一致"
};

function readiness(metric: MetricDefinitionItem): Exclude<ReadinessFilter, "all"> {
  if (metric.analysis.status === "available") return "available";
  if (metric.ypbiMapping.status === "configured" && metric.validation.status !== "passed") return "pending_validation";
  if (metric.ypbiMapping.status === "not_configured") return "not_connected";
  return "attention";
}

function readinessCopy(metric: MetricDefinitionItem) {
  const state = readiness(metric);
  if (state === "available") return { label: "可分析", tone: "success", reason: "已完成查询映射并通过当前版本验数" };
  if (state === "pending_validation") return { label: "待验数", tone: "warning", reason: "已经接入查询，但真实数据验数尚未通过" };
  if (state === "not_connected") return { label: "待接入", tone: "neutral", reason: "指标定义已同步，尚未配置 YPBI 查询映射" };
  return { label: "需处理", tone: "warning", reason: metric.analysis.reasonCodes.map((code) => REASON_LABELS[code]).join("；") };
}

function categoryKey(primary: string, secondary?: string) {
  return secondary ? `secondary:${primary}:${secondary}` : `primary:${primary}`;
}

function metricMatchesCategory(metric: MetricDefinitionItem, selected: string) {
  if (selected === "all") return true;
  if (selected === "derived") return metric.kind === "period_derived";
  if (!metric.classification) return false;
  return selected === categoryKey(metric.classification.primary)
    || selected === categoryKey(metric.classification.primary, metric.classification.secondary);
}

function compactList(values: readonly string[]) {
  const labels: Record<string, string> = {
    "/api/admin/statistics/pDaySum": "后台每日经营统计",
    day: "按日", week: "按周", month: "按月",
    single_pid: "单个业务平台", multi_pid: "多个业务平台", official_overall: "大盘整体",
    previous_period: "上一等长周期", previous_week: "上周同期", previous_year: "去年同期"
  };
  return values.length ? values.map((value) => labels[value] ?? (/^[\u3400-\u9fff、·\s]+$/.test(value) ? value : "展示名称待补充")).join("、") : "暂未登记";
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children || "—"}</dd></div>;
}

function MetricDetailDialog({ metric, metricNames, onClose }: { metric: MetricDefinitionItem; metricNames: ReadonlyMap<string, string>; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const backdrop = useDialogBackdrop(dialogRef, onClose);
  useBodyScrollLock(true);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const result = readinessCopy(metric);
  const sourceTone = SOURCE_STATUS_TONES[metric.authority.sourceBuildStatus.code];
  return <dialog
    {...backdrop}
    ref={dialogRef}
    className="v2-metric-detail"
    aria-labelledby="metric-detail-title"
    aria-describedby="metric-detail-summary"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
  >
    <header className="v2-metric-detail__head">
      <div>
        <span className="v2-eyebrow">{metric.kind === "period_derived" ? "周期派生指标" : `${metric.classification?.primary ?? "未分类"} / ${metric.classification?.secondary ?? "未分类"}`}</span>
        <h2 id="metric-detail-title">{metric.name}</h2>
        <p id="metric-detail-summary">{metric.authority.unit ? `单位：${metric.authority.unit}` : "查看指标定义与数据接入状态"}</p>
      </div>
      <button type="button" className="v2-icon-button" aria-label="关闭指标详情" onClick={onClose} autoFocus><X aria-hidden="true" /></button>
    </header>

    <div className="v2-metric-detail__body" role="region" aria-label="指标详情内容" tabIndex={0}>
      {metric.id === "M016" && <div className="v2-pilot-note"><BookOpenText aria-hidden="true" /><span><b>首个接入样板</b><small>先用这一项核对目录、详情、接口映射和验数状态；样板确认后再按同一结构批量接入。</small></span></div>}

      <section className="v2-status-grid" aria-label="指标接入状态">
        <div><small>数据源状态</small><span className={`ui-status ui-status--${sourceTone}`}>{metric.authority.sourceBuildStatus.label}</span></div>
        <div><small>YPBI 接入</small><b>{MAPPING_LABELS[metric.ypbiMapping.status]}</b></div>
        <div><small>验数 / 可用性</small><span className={`ui-status ui-status--${result.tone}`}>{result.label}</span></div>
      </section>

      <section className="v2-detail-section">
        <h3>权威定义</h3>
        <dl className="v2-detail-list">
          <DetailField label="业务域">{metric.authority.businessDomain}</DetailField>
          <DetailField label="指标类型 / 层级">{[metric.authority.metricType, metric.authority.metricLevel].filter(Boolean).join(" / ")}</DetailField>
          <DetailField label="单位">{metric.authority.unit ?? "权威源未登记"}</DetailField>
          <DetailField label="指标说明">{metricBusinessExplanation(metric, metricNames).description}</DetailField>
          <DetailField label="计算与统计规则">{metricBusinessExplanation(metric, metricNames).calculation}</DetailField>
          <DetailField label="现有数据口径">{formatMetricAuthorityText(metric.authority.definition, metricNames)}</DetailField>
          {metric.authority.developmentFormula && <DetailField label="现有数据计算方式">{formatMetricAuthorityText(metric.authority.developmentFormula, metricNames)}</DetailField>}
          <DetailField label="去重口径">{formatMetricAuthorityText(metric.authority.deduplication, metricNames)}</DetailField>
          <DetailField label="窗口与粒度">{formatMetricAuthorityText(metric.authority.windowAndGrain, metricNames)}</DetailField>
          <DetailField label="数据来源">{formatMetricAuthorityText(metric.authority.dataSource, metricNames)}</DetailField>
          <DetailField label="排除条件">{formatMetricAuthorityText(metric.authority.exclusions, metricNames)}</DetailField>
          <DetailField label="已知问题">{formatMetricAuthorityText(metric.authority.knownIssues, metricNames)}</DetailField>
          {metric.authority.boundary && <DetailField label="口径边界">{formatMetricAuthorityText(metric.authority.boundary, metricNames)}</DetailField>}
          {metric.authority.baseMetricIds.length > 0 && <DetailField label="基础指标">{metric.authority.baseMetricIds.map((id) => metricNames.get(id) ?? "相关指标").join("、")}</DetailField>}
        </dl>
        <p className="v2-authority-source">权威来源：全站指标体系.md · {metric.authority.version}</p>
      </section>

      <section className="v2-detail-section">
        <h3>YPBI 查询能力</h3>
        <dl className="v2-detail-list v2-detail-list--compact">
          <DetailField label="来源接口">{compactList(metric.ypbiMapping.sourceApiIds)}</DetailField>
          <DetailField label="时间粒度">{compactList(metric.ypbiMapping.capabilities.grains)}</DetailField>
          <DetailField label="平台范围">{compactList(metric.ypbiMapping.capabilities.platformModes)}</DetailField>
          <DetailField label="可用维度">{compactList(metric.ypbiMapping.capabilities.dimensions)}</DetailField>
          <DetailField label="可用筛选">{compactList(metric.ypbiMapping.capabilities.filters)}</DetailField>
          <DetailField label="周期比较">{compactList(metric.ypbiMapping.capabilities.comparisons)}</DetailField>
        </dl>
      </section>

      <section className="v2-detail-section">
        <h3>验数与开放条件</h3>
        <p>{VALIDATION_LABELS[metric.validation.status]}。{result.reason}</p>
        {metric.analysis.reasonCodes.length > 0 && <ul>{metric.analysis.reasonCodes.map((code) => <li key={code}>{REASON_LABELS[code]}</li>)}</ul>}
      </section>
    </div>

    <footer className="v2-metric-detail__foot">
      {metric.analysis.status === "available"
        ? <ProductLink className="ui-button ui-button--primary ui-button--lg" href={`/analysis/metrics/${encodeURIComponent(metric.id)}`}>进入指标分析<ArrowRight aria-hidden="true" /></ProductLink>
        : <span className="v2-disabled-action" title={result.reason}><button type="button" className="ui-button ui-button--primary ui-button--lg" disabled>暂不可分析</button></span>}
    </footer>
  </dialog>;
}

export function MetricCatalogPage({ loadDefinitions = fetchMetricDefinitions }: { loadDefinitions?: (signal: AbortSignal) => Promise<V2MetricDefinitionsData> } = {}) {
  const load = useCallback((signal: AbortSignal) => loadDefinitions(signal), [loadDefinitions]);
  const { state, retry } = useV2Resource("metric-definitions", load);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [selectedReadiness, setSelectedReadiness] = useState<ReadinessFilter>("all");
  const [selectedMetric, setSelectedMetric] = useState<MetricDefinitionItem | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);

  const metricNames = useMemo<ReadonlyMap<string, string>>(() => state.status === "success"
    ? new Map(state.data.items.map((metric) => [metric.id, metric.name]))
    : new Map(), [state]);

  const counts = useMemo(() => {
    const result = new Map<ReadinessFilter, number>();
    if (state.status !== "success") return result;
    result.set("all", state.data.items.length);
    state.data.items.forEach((metric) => {
      const key = readiness(metric);
      result.set(key, (result.get(key) ?? 0) + 1);
    });
    return result;
  }, [state]);

  const visibleItems = useMemo(() => {
    if (state.status !== "success") return [];
    const query = search.trim().toLocaleLowerCase("zh-CN");
    return state.data.items.filter((metric) => {
      if (!metricMatchesCategory(metric, selectedCategory)) return false;
      if (selectedReadiness !== "all" && readiness(metric) !== selectedReadiness) return false;
      if (!query) return true;
      return [metric.id, metric.code, metric.name, metric.authority.definition, metric.classification?.primary ?? "", metric.classification?.secondary ?? ""]
        .some((value) => value.toLocaleLowerCase("zh-CN").includes(query));
    });
  }, [search, selectedCategory, selectedReadiness, state]);

  const categoryGroups = useMemo(() => {
    if (state.status !== "success") return [];
    const groups = state.data.categories.map((category) => ({
      label: category.name,
      options: [
        {
          value: categoryKey(category.name),
          label: `${category.name}（全部）`,
          meta: `${state.data.items.filter((metric) => metric.classification?.primary === category.name).length} 项`
        },
        ...category.children.map((child) => ({
          value: categoryKey(category.name, child.name),
          label: child.name,
          meta: `${state.data.items.filter((metric) => metric.classification?.primary === category.name && metric.classification?.secondary === child.name).length} 项`
        }))
      ]
    }));
    return [
      { label: "全部范围", options: [{ value: "all", label: "全部指标", meta: `${state.data.items.length} 项` }] },
      ...groups,
      ...(state.data.snapshot.counts.periodDerived > 0
        ? [{ label: "其他", options: [{ value: "derived", label: "周期派生指标", meta: `${state.data.snapshot.counts.periodDerived} 项` }] }]
        : [])
    ];
  }, [state]);

  const openDetail = (metric: MetricDefinitionItem, trigger: HTMLButtonElement) => {
    detailTriggerRef.current = trigger;
    setSelectedMetric(metric);
  };

  const closeDetail = () => {
    const trigger = detailTriggerRef.current;
    setSelectedMetric(null);
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
      detailTriggerRef.current = null;
    });
  };

  const filterOptions: Array<{ key: ReadinessFilter; label: string }> = [
    { key: "all", label: "全部" },
    { key: "available", label: "可分析" },
    { key: "pending_validation", label: "待验数" },
    { key: "not_connected", label: "待接入" },
    { key: "attention", label: "需处理" }
  ];

  return <div className="v2-page catalog-page" data-page="metric-catalog">
    <CatalogHeader title="指标中心" description="查看权威定义、适用维度、查询接入与验数状态。" actions={<>      <button type="button" className="ui-button ui-button--secondary ui-button--lg v2-page-refresh" aria-label={state.status === "success" && state.refreshing ? "正在刷新指标目录" : "刷新指标目录"} onClick={retry} disabled={state.status === "loading" || (state.status === "success" && state.refreshing)}>
        <RefreshCw className={state.status === "success" && state.refreshing ? "is-spinning" : ""} aria-hidden="true" />
        <span>{state.status === "success" && state.refreshing ? "刷新中" : "刷新目录"}</span>
      </button>
</>} />

    {state.status === "loading" && <StatePanel kind="loading" title="正在读取指标目录" description="正在校验身份并请求权威指标快照。" />}
    {state.status === "failure" && <ResourceFailurePanel state={state} onRetry={retry} />}
    {state.status === "success" && <>
      {state.refreshError && <RefreshNotice onRetry={retry}>目录刷新失败，当前仍显示上次成功结果：{hideInternalReferenceCodes(state.refreshError.message)}{state.refreshError.requestId ? `（请求 ID：${state.refreshError.requestId}）` : ""}</RefreshNotice>}
      <section className="v2-catalog-snapshot" aria-label="指标目录同步信息">
        <span><CheckCircle2 aria-hidden="true" /><b>权威目录已同步</b></span>
        <dl>
          <div><dt>指标版本</dt><dd>{state.data.snapshot.authorityVersion}</dd></div>
          <div><dt>接入登记版本</dt><dd>{state.data.snapshot.mappingRegistryVersion}</dd></div>
          <div><dt>源文件日期</dt><dd>{state.data.snapshot.sourceUpdatedOn}</dd></div>
          <div><dt>目录规模</dt><dd>{state.data.snapshot.counts.standard} 标准 + {state.data.snapshot.counts.periodDerived} 派生</dd></div>
        </dl>
      </section>

      {state.data.items.length === 0 ? <StatePanel kind="empty" title="指标目录为空" description="服务端当前没有返回可展示的指标，页面不会使用本地固定数组补齐。" action={{ label: "重新检查", onClick: retry }} /> : <CatalogLayout navigation={
        <nav className="v2-category-rail" aria-label="指标业务分类">
          <div className="v2-category-rail__head"><b>业务分类</b><small>随权威源同步</small></div>
          <div className="v2-category-mobile">
            <MenuSelect label="业务分类" ariaLabel="指标业务分类" value={selectedCategory} groups={categoryGroups} onChange={setSelectedCategory} />
          </div>
          <div className="v2-category-list">
            <button type="button" className={selectedCategory === "all" ? "is-selected" : ""} aria-pressed={selectedCategory === "all"} onClick={() => setSelectedCategory("all")}><span>全部指标</span><small>{state.data.items.length}</small></button>
            {state.data.categories.map((category) => <section key={category.name}>
              <button type="button" className={selectedCategory === categoryKey(category.name) ? "is-selected" : ""} aria-pressed={selectedCategory === categoryKey(category.name)} onClick={() => setSelectedCategory(categoryKey(category.name))}><span>{category.name}</span><small>{state.data.items.filter((metric) => metric.classification?.primary === category.name).length}</small></button>
              <div>{category.children.map((child) => <button key={child.name} type="button" className={selectedCategory === categoryKey(category.name, child.name) ? "is-selected" : ""} aria-pressed={selectedCategory === categoryKey(category.name, child.name)} onClick={() => setSelectedCategory(categoryKey(category.name, child.name))}><span>{child.name}</span><small>{state.data.items.filter((metric) => metric.classification?.secondary === child.name).length}</small></button>)}</div>
            </section>)}
            {state.data.snapshot.counts.periodDerived > 0 && <button type="button" className={selectedCategory === "derived" ? "is-selected" : ""} aria-pressed={selectedCategory === "derived"} onClick={() => setSelectedCategory("derived")}><span>周期派生指标</span><small>{state.data.snapshot.counts.periodDerived}</small></button>}
          </div>
        </nav>}>

          <section className="v2-catalog-tools" aria-label="指标目录工具">
            <label className="v2-search ui-search">
              <Search aria-hidden="true" />
              <span className="sr-only">搜索指标</span>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索指标名称、定义或分类" />
            </label>
            <div className="v2-readiness-filters" aria-label="按接入状态筛选">
              {filterOptions.filter((option) => option.key === "all" || (counts.get(option.key) ?? 0) > 0).map((option) => <button key={option.key} type="button" className={selectedReadiness === option.key ? "is-selected" : ""} aria-pressed={selectedReadiness === option.key} onClick={() => setSelectedReadiness(option.key)}>{option.label}<small>{counts.get(option.key) ?? 0}</small></button>)}
            </div>
            <span>当前 {visibleItems.length} / {state.data.items.length} 项</span>
          </section>

          {visibleItems.length === 0 ? <StatePanel compact kind="empty" title="没有匹配的指标" description="请调整搜索词、业务分类或接入状态筛选；原始目录仍保持不变。" /> : <section className="v2-table-surface" aria-label="指标目录结果">
            <PaginatedTable label="指标目录" resetKey={[search, selectedCategory, selectedReadiness].join("|")} columnCount={6} head={<tr><th>指标</th><th>业务分类</th><th>定义摘要</th><th>数据源状态</th><th>YPBI 状态</th><th><span className="sr-only">操作</span></th></tr>} rows={visibleItems.map((metric) => {
                  const result = readinessCopy(metric);
                  const sourceTone = SOURCE_STATUS_TONES[metric.authority.sourceBuildStatus.code];
                  return <tr key={metric.id}>
                    <td data-label="指标"><button id={`metric-open-${metric.id}`} type="button" className="v2-metric-open" onClick={(event) => openDetail(metric, event.currentTarget)}><b>{metric.name}</b><span>{metric.authority.unit ? `单位：${metric.authority.unit}` : "查看定义与接入状态"}</span>{metric.id === "M016" && <small>首个接入样板</small>}</button></td>
                    <td data-label="业务分类"><span className="v2-category-copy">{metric.kind === "period_derived" ? "周期派生指标" : <>{metric.classification?.primary}<small>{metric.classification?.secondary}</small></>}</span></td>
                    <td data-label="定义摘要"><span className="v2-definition">{metricBusinessExplanation(metric, metricNames).description}</span></td>
                    <td data-label="数据源状态"><div className="v2-status-copy"><span className={`ui-status ui-status--${sourceTone}`}>{metric.authority.sourceBuildStatus.label}</span><small>{metric.authority.version}</small></div></td>
                    <td data-label="YPBI 状态"><div className="v2-status-copy"><span className={`ui-status ui-status--${result.tone}`}>{result.label}</span><small>{MAPPING_LABELS[metric.ypbiMapping.status]} · {VALIDATION_LABELS[metric.validation.status]}</small></div></td>
                    <td data-label="操作"><button type="button" className="v2-text-button" onClick={(event) => openDetail(metric, event.currentTarget)}>查看详情<ArrowRight aria-hidden="true" /></button></td>
                  </tr>;
                })} />
          </section>}
      </CatalogLayout>}
      {selectedMetric && <MetricDetailDialog metric={selectedMetric} metricNames={metricNames} onClose={closeDetail} />}
    </>}
  </div>;
}
