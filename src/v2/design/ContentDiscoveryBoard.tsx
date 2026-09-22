import type { ReactElement, ReactNode } from "react";
import { DashboardSectionHeading } from "../features/dashboards/DashboardPresentation";
import { ContentDiscoveryAnalysis, SearchDemandAnalysis, VideoClickSourceAnalysis } from "./ContentDiscoveryAnalysis";
import type { BoardSortOrder } from "./content-discovery-analysis-model";
import type { ExtendedView } from "./extended-board-view";
import type { OpenPreviewReading } from "./PreviewMetricCard";
import type { WorkbookSheet } from "./preview-workbook";

type AnalysisKey = "内容发现结构" | "视频点击来源" | "搜索需求";
type AnalysisSelection = { id: string; group: string; order: BoardSortOrder };

export function ContentDiscoveryBoard({
  view,
  pending,
  open,
  renderCard,
  exportAction,
  categoryNavigation,
  videoHomeCategories,
  videoInteraction,
  communityDetails,
  onSelectionChange
}: {
  view: ExtendedView;
  pending: boolean;
  open: OpenPreviewReading;
  renderCard: (id: string) => ReactNode;
  exportAction: (title: string, sheets: WorkbookSheet[]) => ReactElement;
  categoryNavigation: ReactNode;
  videoHomeCategories: ReactNode;
  videoInteraction: ReactNode;
  communityDetails: ReactNode;
  onSelectionChange: (key: AnalysisKey, selection: AnalysisSelection) => void;
}) {
  const analysisProps = { view, pending, open, exportAction };

  return <>
    <section aria-labelledby="content-video-heading" data-content-section="video">
      <DashboardSectionHeading id="content-video-heading" title="视频发现与互动" guidanceKey="discovery.core" />
      <div className="board-preview__section-flow">
        <ContentDiscoveryAnalysis {...analysisProps} onSelectionChange={selection => onSelectionChange("内容发现结构", selection)} />
        <section aria-label="视频点击来源" className="board-preview__section-flow">
          <VideoClickSourceAnalysis {...analysisProps} onSelectionChange={selection => onSelectionChange("视频点击来源", selection)} />
          {videoHomeCategories}
        </section>
        <section aria-label="视频首页顶部频道Tab" className="board-preview__section-flow">
          <p className="topic-preview__description">仅统计用户主动切换顶部频道</p>
          <div className="topic-preview__grid is-three">{["M106", "M107", "M108"].map(id => renderCard(id))}</div>
          {categoryNavigation}
        </section>
        <section aria-label="视频互动" className="board-preview__section-flow">
          <div className="topic-preview__grid is-two">{["M047", "M048"].map(id => renderCard(id))}</div>
          {videoInteraction}
        </section>
      </div>
    </section>

    <section aria-labelledby="content-search-heading" data-content-section="search">
      <DashboardSectionHeading id="content-search-heading" title="搜索需求与承接" guidanceKey="discovery.search" />
      <div className="board-preview__section-flow">
        <div className="topic-preview__grid is-three">{["M092", "M093", "M046"].map(id => renderCard(id))}</div>
        <SearchDemandAnalysis {...analysisProps} onSelectionChange={selection => onSelectionChange("搜索需求", selection)} />
      </div>
    </section>

    <section aria-labelledby="content-community-heading" data-content-section="community">
      <DashboardSectionHeading id="content-community-heading" title="作者与社区" guidanceKey="discovery.community" />
      <div className="board-preview__section-flow">
        <div className="topic-preview__grid is-three">{["M049", "M050", "M051"].map(id => renderCard(id))}</div>
        {communityDetails}
      </div>
    </section>
  </>;
}
