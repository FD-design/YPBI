import type { ReactNode } from "react";
import { DashboardHeader } from "../dashboards/DashboardPresentation";
import "./catalog-layout.css";
export function CatalogHeader({ title, description, actions }: { title: string; description: string; actions: ReactNode }) { return <DashboardHeader title={title} breadcrumb={`数据中心 / ${title}`} summary={description}>{actions}</DashboardHeader>; }
export function CatalogLayout({ navigation, children }: { navigation: ReactNode; children: ReactNode }) { return <div className="v2-catalog-layout">{navigation}<div className="v2-catalog-results">{children}</div></div>; }
