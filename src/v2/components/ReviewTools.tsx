import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChartNoAxesCombined, SlidersHorizontal } from "lucide-react";
import { ProductLink } from "../app/router";
import { MetricReadingDialog } from "../features/dashboards/MetricReadingDialog";

const ReviewContext = createContext<{ host: HTMLDivElement | null; open: () => void } | null>(null);

/** Only the isolated development boundary supplies this context. */
export function ReviewToolsProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return <ReviewContext.Provider value={{ host, open: () => setOpened(true) }}>
    {children}
    {opened && <MetricReadingDialog title="体验工具" onClose={() => setOpened(false)} content={<div className="review-tools">
      <ProductLink className="review-tools__gallery" href="/dashboards/public?design=v1-chart-states" onClick={() => setOpened(false)}><ChartNoAxesCombined aria-hidden="true" />查看完整图表体验</ProductLink>
      <div className="review-tools" ref={setHost} />
    </div>} />}
  </ReviewContext.Provider>;
}

export function ReviewToolsMenuItem({ onSelect }: { onSelect: () => void }) {
  const context = useContext(ReviewContext);
  return context ? <button type="button" role="menuitem" onClick={() => { onSelect(); context.open(); }}><SlidersHorizontal aria-hidden="true" />体验工具</button> : null;
}

export function ReviewTools({ children }: { children: ReactNode }) {
  const context = useContext(ReviewContext);
  return context?.host ? createPortal(children, context.host) : null;
}
