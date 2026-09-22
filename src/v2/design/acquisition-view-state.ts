import { preserveAuthenticatedReadingRoute } from "./reading-route";
import { DEFAULT_ACQUISITION_FILTERS } from "./acquisition-preview-model";
import { rangeError } from "../../components/ui/date-range-model.ts";
import { CHANNEL_QUALITY_IDS, CHANNEL_QUALITY_GROUPS } from "./acquisition-channel-quality";
export const ACQUISITION_DETAIL_KEYS = ["channel", "target", "type", "settlement"] as const;
export type AcquisitionDetailKey = typeof ACQUISITION_DETAIL_KEYS[number];
export interface AcquisitionDetailReading {
  qualityGroup?: string;
  search: string;
  showChange: string;
  page: number;
  sort: { id: string; descending: boolean };
}
export interface AcquisitionViewState {
  v: 2;
  filters: { start: string; end: string; scope: string; channel: string; comparison: string };
  detail: { tab: "growth" | "settlement"; sections: Record<AcquisitionDetailKey, AcquisitionDetailReading> };
  mixed: boolean;
}
const defaultReading = (id = "M008"): AcquisitionDetailReading => ({ search: "", showChange: "none", page: 0, sort: { id, descending: true } });
export const DEFAULT_ACQUISITION_VIEW: AcquisitionViewState = { v: 2, filters: DEFAULT_ACQUISITION_FILTERS, detail: { tab: "growth", sections: { channel: defaultReading(), target: defaultReading(), type: defaultReading(), settlement: defaultReading("M011") } }, mixed: false };
function parseReading(value: unknown): AcquisitionDetailReading | null {
  if (!value || typeof value !== "object") return null;
  const d = value as AcquisitionDetailReading;
  if ((d.qualityGroup !== undefined && !CHANNEL_QUALITY_GROUPS.some(group => group.value === d.qualityGroup)) || typeof d.search !== "string" || d.search.length > 120 || !["none", "previous"].includes(d.showChange) || !Number.isInteger(d.page) || d.page < 0 || d.page > 100 || !d.sort || ![...CHANNEL_QUALITY_IDS, "M011"].includes(d.sort.id) || typeof d.sort.descending !== "boolean") return null;
  return { ...(d.qualityGroup === undefined ? {} : { qualityGroup: d.qualityGroup }), search: d.search, showChange: d.showChange, page: d.page, sort: { id: d.sort.id, descending: d.sort.descending } };
}
export function parseAcquisitionView(value: string): AcquisitionViewState | null {
  if (value.length > 3000) return null;
  try {
    const item = JSON.parse(value), f = item.filters, d = item.detail;
    if (![1, 2].includes(item.v) || !f || !d || typeof item.mixed !== "boolean" || typeof f.start !== "string" || typeof f.end !== "string" || rangeError(f, { today: "2026-09-10", maxDate: "2026-09-08", maxDays: 366 }) || !["all", "single"].includes(f.scope) || !["all", "a"].includes(f.channel) || !["previous", "month", "year", "none"].includes(f.comparison) || !["growth", "settlement"].includes(d.tab)) return null;
    const sections = { ...DEFAULT_ACQUISITION_VIEW.detail.sections };
    if (item.v === 1) {
      if (!["channel", "target", "type"].includes(d.dimension)) return null;
      const reading = parseReading(d);
      if (!reading) return null;
      sections[(d.tab === "settlement" ? "settlement" : d.dimension) as AcquisitionDetailKey] = reading;
    } else {
      for (const key of ACQUISITION_DETAIL_KEYS) {
        const reading = parseReading(d.sections?.[key]);
        if (!reading) return null;
        sections[key] = reading;
      }
    }
    return { v: 2, filters: { start: f.start, end: f.end, scope: f.scope, channel: f.channel, comparison: f.comparison }, detail: { tab: d.tab, sections }, mixed: item.mixed };
  } catch { return null; }
}
export function resetAcquisitionPages(detail: AcquisitionViewState["detail"]): AcquisitionViewState["detail"] {
  return { ...detail, sections: Object.fromEntries(ACQUISITION_DETAIL_KEYS.map(key => [key, { ...detail.sections[key], page: 0 }])) as AcquisitionViewState["detail"]["sections"] };
}
export function readAcquisitionView(search: string) { return parseAcquisitionView(new URLSearchParams(search).get("view") ?? "") ?? DEFAULT_ACQUISITION_VIEW; }
export function acquisitionViewHref(view: AcquisitionViewState) { return preserveAuthenticatedReadingRoute("/dashboards/public?design=dashboard-center&board=5.7&view=" + encodeURIComponent(JSON.stringify(view))); }
