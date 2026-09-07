import { Download, Save } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { StatusBadge } from "../../components/ui/StatusBadge";

export function DashboardReadFrame({
  title,
  description,
  modelName,
  focus,
  layoutDirty,
  onSaveLayout,
  onExport,
  toolbar,
  children,
  mobileHiddenCount = 0
}: {
  title: string;
  description: string;
  modelName?: string;
  focus: Array<[string, string]>;
  layoutDirty: boolean;
  onSaveLayout: () => void;
  onExport: () => void;
  toolbar?: ReactNode;
  children: ReactNode;
  mobileHiddenCount?: number;
}) {
  return <div className="dashboard-read-page">
    <header className="dashboard-page-head">
      <div className="dashboard-page-head__copy">
        <div className="dashboard-breadcrumb"><span>看板中心</span><i>/</i><span>系统看板</span></div>
        <div className="dashboard-title-row"><h1>{title}</h1><StatusBadge tone="success">真实数据</StatusBadge></div>
        <p>{description}</p>
      </div>
      <div className="dashboard-page-head__actions">
        {modelName && <span className="dashboard-model-label">{modelName}</span>}
        <Button icon={Save} disabled={!layoutDirty} onClick={onSaveLayout}>保存布局</Button>
        <Button icon={Download} variant="primary" onClick={onExport}>导出数据</Button>
      </div>
    </header>

    {toolbar && <section className="dashboard-command-bar" aria-label="看板范围与模板">{toolbar}</section>}

    {focus.length > 0 && <section className="dashboard-reading-guide" aria-label="阅读重点">
      <span className="dashboard-reading-guide__label">阅读重点</span>
      {focus.map(([label, value], index) => <div key={label}><i>{index + 1}</i><span><small>{label}</small><b>{value}</b></span></div>)}
    </section>}

    <section className="dashboard-card-region" aria-label="看板内容">
      {children}
    </section>

    {mobileHiddenCount > 0 && <div className="dashboard-mobile-hidden-note">还有 {mobileHiddenCount} 个分析仅在桌面端展示</div>}
  </div>;
}
