import { preserveAuthenticatedReadingRoute } from "./reading-route";
import { validDemoRange, DEMO_RANGE } from "./extended-board-model";
import { parseVersionPerformanceView, type VersionPerformanceView } from "./version-performance-model";
export interface ExtendedView { range: typeof DEMO_RANGE; compared: boolean; mixed: boolean; experience?: VersionPerformanceView }
export function parseExtendedView(value: string | null, board?: string): ExtendedView | null {
  if (!value || value.length > 600) return null;
  try {
    const v = JSON.parse(value);
    if (!v || typeof v !== "object") return null;
    const keys = Object.keys(v).sort().join();
    if (!["compared,mixed,range", "compared,experience,mixed,range"].includes(keys)
      || typeof v.compared !== "boolean" || typeof v.mixed !== "boolean"
      || !v.range || Object.keys(v.range).sort().join() !== "end,start" || !validDemoRange(v.range)) return null;
    if (keys === "compared,mixed,range") return v;
    const experience = board === "5.15" ? parseVersionPerformanceView(v.experience) : null;
    return experience ? { range: v.range, compared: v.compared, mixed: v.mixed, experience } : null;
  } catch { return null; }
}
export const extendedBoardHref = (board: string, view: ExtendedView) => preserveAuthenticatedReadingRoute(`/dashboards/public?design=dashboard-center&board=${board}&view=${encodeURIComponent(JSON.stringify(view))}`);
