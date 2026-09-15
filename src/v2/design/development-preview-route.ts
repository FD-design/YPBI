import plan from "./generated/dashboard-directory-preview.json" with { type: "json" };
import { parseAcquisitionView } from "./acquisition-view-state.ts";
import { parseTopicView } from "./topic-preview-view.ts";
import { parseExtendedView } from "./extended-board-view.ts";
import { parseFunctionView } from "./function-preview-model.ts";

interface LocationParts { pathname: string; search: string; hash: string }
export function isPersonalPreviewPath(path: string) { return ["/dashboards/mine", "/dashboards/metric-overviews", "/analysis/metrics", "/analysis/events", "/analysis/funnels", "/analysis/saved"].includes(path); }
export function resolveDevelopmentPreview(location: LocationParts): "dashboard-center" | "v1-chart-states" | "catalog-center" | "personal-workspace" | null {
  if (isPersonalPreviewPath(location.pathname) && !location.hash && /^\?design=personal-workspace(?:&object=local-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/.test(location.search)) return "personal-workspace";
  if (["/data/metrics", "/data/events"].includes(location.pathname) && location.search === "?design=catalog-center" && !location.hash) return "catalog-center";
  if (location.pathname !== "/dashboards/public" || location.hash) return null;
  if (location.search === "?design=v1-chart-states") return "v1-chart-states";
  if (["?design=dashboard-center", "?design=core-overview"].includes(location.search)) return "dashboard-center";
  if (location.search.startsWith("?design=dashboard-center&board=5.5&view=")) {
    const params = new URLSearchParams(location.search);
    return [...params.keys()].join(",") === "design,board,view" && parseFunctionView(params.get("view")) ? "dashboard-center" : null;
  }
  if (location.search.startsWith("?design=dashboard-center&board=5.7&view=")) {
    const params = new URLSearchParams(location.search);
    return [...params.keys()].join(",") === "design,board,view" && parseAcquisitionView(params.get("view") ?? "") ? "dashboard-center" : null;
  }
  if (/^\?design=dashboard-center&board=5\.[89]&view=/.test(location.search)) {
    const params = new URLSearchParams(location.search);
    return [...params.keys()].join(",") === "design,board,view" && parseTopicView(params.get("view") ?? "", params.get("board") ?? undefined) ? "dashboard-center" : null;
  }
  const match = location.search.match(/^\?design=dashboard-center&board=(5\.\d+)$/);
  if (/^\?design=dashboard-center&board=5\.(?:2|1[0-5])&view=/.test(location.search)) {
    const params = new URLSearchParams(location.search);
    return [...params.keys()].join(",") === "design,board,view" && parseExtendedView(params.get("view"), params.get("board") ?? undefined) ? "dashboard-center" : null;
  }
  return match && plan.items.some((item) => item.section === match[1]) ? "dashboard-center" : null;
}
export function previewBoardId(search: string) { return new URLSearchParams(search).get("board") ?? "5.2"; }
export function previewBoardHref(id: string) {
  return id === "5.2" ? "/dashboards/public?design=dashboard-center" : `/dashboards/public?design=dashboard-center&board=${encodeURIComponent(id)}`;
}
