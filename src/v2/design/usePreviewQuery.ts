import { useEffect } from "react";
import type { DateRangeValue } from "../../components/ui/date-range-model";
import { savePreviewQuery } from "./preview-query";

export function usePreviewQuery(range: DateRangeValue, compared: boolean, supported = true) {
  useEffect(() => { if (supported) savePreviewQuery(range, compared); }, [range.start, range.end, compared, supported]);
}
