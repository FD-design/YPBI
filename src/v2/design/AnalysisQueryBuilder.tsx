import { FUNNEL_SAMPLE_EVENTS } from "./analysis-sample-capabilities";
import { Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { MenuSelect, MultiMenuSelect } from "../../components/ui/MenuSelect";
import { DateRangePicker } from "../../components/ui/DateRangePicker";
import { commonFields, eventFields, fieldOptions, groupFields, numericField, operators, fieldLabel, retargetEventItem } from "./event-analysis-preview";
import { configurationError, PREVIEW_EVENTS, PREVIEW_METRICS, previewDateLimits, workspaceEvents, workspaceMetrics, workspacePlatforms } from "./personal-query-preview";
import { localId, type AnalysisConfig, type AnalysisFilter, type AnalysisItem } from "./personal-workspace-model";

export function QuerySelect({ label, value, options, onChange, disabled = false, searchable = false }: {
  label: string; value: string; options: { value: string; label: string; meta?: string; disabled?: boolean }[];
  onChange: (value: string) => void; disabled?: boolean; searchable?: boolean;
}) {
  return <MenuSelect label={label} value={value} groups={[{ label, options }]} onChange={onChange} disabled={disabled} searchable={searchable} density="compact" />;
}
export function DefinitionSelect({ kind, item, disabled, onChange }: { kind: AnalysisConfig["kind"]; item: AnalysisItem; disabled: boolean; onChange: (item: AnalysisItem) => void }) {
  const options = kind === "metrics"
    ? workspaceMetrics.map(m => ({ value: m.id, label: m.name, category: m.classification?.primary ?? "跨分类派生", version: m.authority.version, sample: PREVIEW_METRICS.has(m.id) }))
    : workspaceEvents.map(e => ({ value: e.id, label: e.name, category: e.module, version: e.version, sample: (kind==="funnels"?FUNNEL_SAMPLE_EVENTS:PREVIEW_EVENTS).has(e.id) }));
  return <MenuSelect label={kind === "metrics" ? "选择指标" : "选择事件"} value={item.ref} disabled={disabled} searchable density="compact"
    groups={[...new Set(options.map(o => o.category))].map(category => ({ label: category, options: options.filter(o => o.category === category).map(o => ({ ...o, disabled: !o.sample, meta: `${o.value} · ${o.version} · ${o.sample ? "合成样例" : "查询待接入"}` })) }))}
    onChange={ref => {
      const version = options.find(o => o.value === ref)!.version;
      if (kind === "metrics") { onChange({ ...item, ref, version }); return; }
      const change = retargetEventItem(item, ref, version);
      if (change.removed.length && !window.confirm(`新事件不支持以下配置：${change.removed.join("、")}。确认后移除这些配置，其他条件保留，继续吗？`)) return;
      onChange(change.next);
    }} />;
}
export function FilterEditor({ label, event, fields, filters, onChange, disabled = false }: { label: string; event: string; fields: ReturnType<typeof eventFields>; filters: AnalysisFilter[]; onChange: (filters: AnalysisFilter[]) => void; disabled?: boolean }) {
  const patch = (index: number, next: Partial<AnalysisFilter>) => onChange(filters.map((filter, i) => i === index ? { ...filter, ...next } : filter));
  return <div className="analysis-filters">
    {filters.map((filter, index) => {
      const field = fields.find(f => f.id === filter.field), choices = fieldOptions(event, filter.field);
      return <div className="analysis-filter-row" key={filter.key}>
        <span className="personal-note">{index ? "且" : label}</span>
        <QuerySelect label={`${label}属性${index + 1}`} value={filter.field} disabled={disabled} searchable options={fields.map(f => ({ value: f.id, label: f.name, meta: `${f.id} · ${f.type}` }))} onChange={field => patch(index, { field, operator: "in", values: [] })} />
        <QuerySelect label={`${label}运算符${index + 1}`} value={filter.operator} disabled={disabled} options={operators(field?.type ?? "string")} onChange={operator => patch(index, { operator: operator as AnalysisFilter["operator"], values: [] })} />
        {!["exists", "missing"].includes(filter.operator) && (choices.length && ["in", "not_in"].includes(filter.operator)
          ? <fieldset disabled={disabled} className="analysis-fieldset"><MultiMenuSelect label={`${label}筛选值${index + 1}`} values={filter.values} options={choices} onChange={values => patch(index, { values })} /></fieldset>
          : <input aria-label={`${label}筛选值${index + 1}`} disabled={disabled} value={filter.values.join(",")} placeholder={filter.operator === "between" ? "最小值,最大值" : "填写值；多个值用逗号分隔"} onChange={e => patch(index, { values: e.target.value.split(/[,，]/).map(v => v.trim()) })} />)}
        <Button variant="ghost" size="sm" icon={Trash2} aria-label={`删除${label}条件${index + 1}`} disabled={disabled} onClick={() => onChange(filters.filter((_, i) => i !== index))} />
      </div>;
    })}
    <Button variant="ghost" size="sm" icon={Plus} disabled={disabled || !fields.length || filters.length >= 5} onClick={() => onChange([...filters, { key: localId(), field: fields[0].id, operator: "in", values: [] }])} aria-label={`${label}：添加筛选`}>{label === "全局" ? "添加全局筛选" : "添加局部筛选"}</Button>
    {filters.length > 0 && <small>条件之间为“且”；同一条件的多个值为“或”。无值需单独选择。</small>}
  </div>;
}
export function analysisSummary(config: AnalysisConfig) {
  const names = config.items.map(i => {
    const name = i.alias || (config.kind !== "metrics" ? workspaceEvents.find(e => e.id === i.ref)?.name : workspaceMetrics.find(m => m.id === i.ref)?.name);
    const statistic = config.kind === "metrics" ? "" : config.kind === "funnels" ? "步骤" : i.measure === "property" ? `${fieldLabel(i.ref,i.property??"")} · ${{sum:"求和",avg:"平均值",min:"最小值",max:"最大值"}[i.aggregation??"sum"]}` : {count:"总次数",users:"触发用户数",average:"人均触发次数"}[i.measure];
    const filters = (i.filters??[]).map(f=>`${fieldLabel(i.ref,f.field)} ${operators("number").find(o=>o.value===f.operator)?.label??f.operator} ${f.values.map(v=>fieldLabel(i.ref,f.field,v)).join("/")}`).join(" 且 ");
    return name ? `${name}${statistic?"（"+statistic+"）":""}${filters?"［"+filters+"］":""}` : "";
  }).filter(Boolean);
  const dimensions = [config.group, config.secondaryGroup].filter(v => v && v !== "none").map(id => fieldLabel(config.items[0]?.ref, id!));
  const conditions = (config.filters ?? []).map(f => `${fieldLabel(config.items[0]?.ref, f.field)} ${operators("number").find(o => o.value === f.operator)?.label ?? f.operator} ${f.values.map(v => fieldLabel(config.items[0]?.ref, f.field, v)).join(" / ")}`);
  return `${names.join("、")} · ${config.range.start} 至 ${config.range.end} · ${{hour:"按小时",day:"按日",week:"按周",month:"按月",total:"区间合计"}[config.grain ?? "day"]} · ${dimensions.length ? dimensions.join(" × ") : "总体"} · ${config.comparison ? "上一等长周期对比" : "不对比"}${conditions.length ? " · " + conditions.join(" 且 ") : ""}`;
}
export function AnalysisQueryBuilder({ config, onChange, desktop, onQuery }: { config: AnalysisConfig; onChange: (config: AnalysisConfig) => void; desktop: boolean; onQuery: () => void }) {
  const patch = (next: Partial<AnalysisConfig>) => onChange({ ...config, ...next });
  const updateItem = (index: number, item: AnalysisItem) => patch({ items: config.items.map((v, i) => i === index ? item : v) });
  const events = config.kind === "events", dimensions = groupFields(config), error = configurationError(config);
  return <details className="personal-config-shell personal-surface" open={desktop}>
    <summary>分析条件配置 · {config.items.length} 项</summary>
    <div className="personal-config" aria-label="分析项配置">
      <header><h2>分析条件配置</h2><span className="personal-note">UTC+08:00 · {events ? "统一用户身份 · 合成样例" : "权威业务指标"}</span></header>
      {config.items.map((item, index) => <section className="personal-analysis-item" key={item.key}>
        <div className="analysis-item-controls"><b className="analysis-item-letter">{String.fromCharCode(65 + index)}</b>
          <DefinitionSelect kind={config.kind} item={item} disabled={!desktop} onChange={item => updateItem(index, item)} />
          {events && <QuerySelect label={`分析项${index + 1}统计方式`} value={item.measure} disabled={!desktop} onChange={measure => updateItem(index, { ...item, measure: measure as AnalysisItem["measure"] })} options={[{ value: "count", label: "总次数" }, { value: "users", label: "触发用户数" }, { value: "average", label: "人均触发次数" }, { value: "property", label: "属性统计", disabled: !eventFields(item.ref).some(numericField), meta: eventFields(item.ref).some(numericField) ? undefined : "该事件无可用数值属性" }]} />}
          {events && item.measure === "property" && <><QuerySelect label="数值属性" value={item.property ?? ""} disabled={!desktop} onChange={property => updateItem(index, { ...item, property })} options={eventFields(item.ref).filter(numericField).map(f => ({ value: f.id, label: f.name }))} /><QuerySelect label="聚合方式" value={item.aggregation ?? ""} disabled={!desktop} onChange={aggregation => updateItem(index, { ...item, aggregation: aggregation as AnalysisItem["aggregation"] })} options={[{ value:"sum",label:"求和" },{ value:"avg",label:"平均值" },{ value:"min",label:"最小值" },{ value:"max",label:"最大值" }]} /></>}
          <input aria-label={`分析项${index + 1}别名`} placeholder="别名（选填）" value={item.alias ?? ""} maxLength={40} disabled={!desktop} onChange={e => updateItem(index, { ...item, alias: e.target.value })} />
          <Button variant="ghost" size="sm" icon={Copy} aria-label={`复制分析项${index + 1}`} disabled={!desktop || config.items.length >= 5} onClick={() => patch({ items: [...config.items, { ...structuredClone(item), key: localId() }] })} />
          <Button variant="ghost" size="sm" icon={Trash2} aria-label={`移除分析项${index + 1}`} disabled={!desktop || config.items.length <= 1} onClick={() => patch({ items: config.items.filter((_, i) => i !== index) })} />
        </div>
        {events && <FilterEditor label={`分析项${String.fromCharCode(65 + index)}局部`} event={item.ref} fields={eventFields(item.ref)} filters={item.filters ?? []} disabled={!desktop} onChange={filters => updateItem(index, { ...item, filters })} />}
      </section>)}
      <Button variant="ghost" icon={Plus} disabled={!desktop || config.items.length >= 5} onClick={() => patch({ items: [...config.items, { key: localId(), ref: "", version: "", measure: "count" }] })}>添加分析项（{config.items.length}/5）</Button>
      {events ? <section className="analysis-config-row"><h3>全局筛选</h3><FilterEditor label="全局" event={config.items[0].ref} fields={commonFields(config)} filters={config.filters ?? []} disabled={!desktop} onChange={filters => patch({ filters })} /></section> : <p className="personal-note">指标口径沿用权威目录；维度筛选待指标查询能力接入，不使用事件自由统计替代。</p>}
      <section className="analysis-config-row"><h3>分组选择</h3><div className="personal-tools">
        <QuerySelect label="分组维度" value={config.group} disabled={!desktop} searchable options={[{ value: "none", label: "不分组" }, ...dimensions.map(f => ({ value: f.id, label: f.name }))]} onChange={group => patch({ group, secondaryGroup: "none" })} />
        {config.group !== "none" && <QuerySelect label="第二分组维度" value={config.secondaryGroup ?? "none"} disabled={!desktop} searchable options={[{ value: "none", label: "不添加" }, ...dimensions.filter(f => f.id !== config.group).map(f => ({ value: f.id, label: f.name }))]} onChange={secondaryGroup => patch({ secondaryGroup })} />}
        <small>{events ? "只列出全部分析项共同支持的属性；二维分组使用实际交叉事件计算。" : "当前指标样例仅提供总体结果。"}</small>
      </div></section>
      <section className="analysis-config-row"><h3>时间与范围</h3><div className="personal-tools">
        <fieldset className="analysis-fieldset" disabled={!desktop}><DateRangePicker value={config.range} onChange={range => patch({ range })} {...previewDateLimits} /></fieldset>
        <QuerySelect label="时间粒度" value={config.grain ?? "day"} disabled={!desktop} onChange={grain => patch({ grain: grain as AnalysisConfig["grain"] })} options={Object.entries({hour:"按小时",day:"按日",week:"按周",month:"按月",total:"区间合计"}).map(([value,label]) => ({ value,label,disabled:!events && value !== "day" }))} />
        <QuerySelect label="业务平台" value={config.scope} disabled={!desktop} onChange={scope => patch({ scope })} options={[{ value:"overall",label:"大盘整体" },...workspacePlatforms.map(p => ({value:p.pid,label:p.name,disabled:true,meta:"独立结果待接入"}))]} />
        <QuerySelect label="对比周期" value={config.comparison ? "previous":"none"} disabled={!desktop} onChange={value => patch({comparison:value==="previous"})} options={[{value:"none",label:"不对比"},{value:"previous",label:"上一等长周期"}]} />
      </div></section>
      <footer className="personal-tools"><Button variant="primary" disabled={!!error} onClick={onQuery}>查询样例</Button><p className="personal-note">{error ?? "条件已就绪；查询后更新结果、完整表格与导出。"}</p></footer>
    </div>
  </details>;
}
