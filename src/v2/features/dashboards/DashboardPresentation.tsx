import { useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { FloatingHint } from "../../../components/ui/FloatingHint";
import "./dashboard-presentation.css";
import { MetricReadingDialog } from "./MetricReadingDialog";
import { DataOriginBadge } from "../../components/DataOrigin";
import { useLiveDashboard } from "./LiveDashboardContext";
import { dashboardGuidance } from "./dashboard-guidance";

export function DashboardGuidance({ title, guidanceKey }: { title: string; guidanceKey?: string }) {
  const description = dashboardGuidance(title, guidanceKey);
  return description ? <span className="dashboard-guidance">{description}</span> : null;
}

export function DashboardSectionHeading({ title, id, guidanceKey, badge }: { title: string; id?: string; guidanceKey?: string; badge?: ReactNode }) {
  return <div className="dashboard-section-heading"><h2 id={id} className="dashboard-section-title">{title}</h2>{badge}<DashboardGuidance title={title} guidanceKey={guidanceKey} /></div>;
}

/** Shared page hierarchy; query capabilities remain owned by each dashboard. */
export function DashboardHeader({ title, breadcrumb, description, summary, children, className = "" }: {
  title: string; breadcrumb: string; description?: string; summary?: ReactNode; children: ReactNode; className?: string;
}) {
  const live = useLiveDashboard();
  return <header className={`dashboard-header ${className}`}>
    <div className="dashboard-header__heading">
      <span className="dashboard-header__breadcrumb">{breadcrumb}</span>
      <div className="dashboard-header__title-row"><h1>{title}</h1>{!live?.metricIds.length && <DataOriginBadge />}{description && <DashboardDescription description={description} />}</div>
    </div>
    <div className="dashboard-header__tools">{children}</div>
    {(summary || Boolean(live?.metricIds.length)) && <div className="dashboard-header__summary">{live?.metricIds.length ? `${live.platformName} · 真实主值 ${live.query.dateRange[1]} · 趋势 ${live.query.dateRange.join(" 至 ")}` : summary}</div>}
  </header>;
}

function DashboardDescription({ description }: { description: string }) {
  const trigger=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false);
  const [inventory,setInventory]=useState<{label:string;element:HTMLElement}[]>([]);
  const inspect=()=>{
    const page=trigger.current?.closest(".v2-page");
    const elements=page?.querySelectorAll<HTMLElement>(".dashboard-section-title,.dashboard-panel__title,.dashboard-metric-card > header > div:first-child button,.dashboard-metric-card > header > div:first-child a,.payment-business__summary section > button")??[];
    const seen=new Set<string>();
    const items=[...elements].flatMap(element=>{const label=element.textContent?.trim()??"";if(!label||seen.has(label))return [];seen.add(label);return [{label,element}];});
    setInventory(items);
  };
  return <div className="dashboard-description" onPointerEnter={inspect} onFocus={inspect}>
    <FloatingHint content={<>{description.split(/[。；]/)[0]}{inventory.length>0&&<p>包含：{inventory.slice(0,4).map(item=>item.label).join("、")}{inventory.length>4?"等":""}。点击查看完整说明。</p>}</>}><button ref={trigger} type="button" className="dashboard-description__trigger" aria-label="查看看板说明" aria-expanded={open} onClick={()=>{inspect();setOpen(true);}}><Info aria-hidden="true"/></button></FloatingHint>
    {open&&<MetricReadingDialog title="看板说明" onClose={()=>setOpen(false)} content={<><h3>解决什么问题</h3><p>{description}</p><h3>本页指标与分析区块</h3>{inventory.length?<ul className="dashboard-description__inventory">{inventory.map(item=><li key={item.label}><button type="button" onClick={()=>{setOpen(false);requestAnimationFrame(()=>item.element.scrollIntoView({block:"center",behavior:"smooth"}));}}>{item.label}</button></li>)}</ul>:<p>当前页面暂无已加载的指标区块。</p>}<h3>阅读与数据范围</h3><p>日期和业务范围以各区块标注为准。比例与人均指标可在同口径数据表核对计算输入；未成熟、缺失及未接入结果不记为0。</p></>}/>}
  </div>;
}

export function DashboardPanel({ id, title, note, tools, children, className = "", chartKind, guidanceKey }: {
  id?: string; title: string; note?: ReactNode; tools?: ReactNode; children: ReactNode; className?: string; chartKind?: string; guidanceKey?: string;
}) {
  return <article id={id} className={`dashboard-panel ui-chart-surface ${className}`} aria-label={title} data-chart-kind={chartKind}>
    <header className="dashboard-panel__head">
      <div className="dashboard-panel__heading"><div className="dashboard-panel__title-row"><h2 className="dashboard-panel__title">{title}</h2><DataOriginBadge /><DashboardGuidance title={title} guidanceKey={guidanceKey} /></div>{note && <p>{note}</p>}</div>
      {tools && <div className="dashboard-panel__tools">{tools}</div>}
    </header>
    {children}
  </article>;
}
