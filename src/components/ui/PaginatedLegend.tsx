import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { FloatingHint } from "./FloatingHint";
import "./paginated-legend.css";

export type LegendItem = { id: string; label: string; color: string; selected: boolean };

/** Legend paging changes only the reading window; selection stays with the chart. */
export function PaginatedLegend({ items, label, onToggle }: { items: LegendItem[]; label: string; onToggle: (id: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(1);
  const key = items.map(item => item.id).join("|");
  const [paging, setPaging] = useState({ key, capacity, page: 0 });
  if (paging.key !== key || paging.capacity !== capacity) setPaging({ key, capacity, page: 0 });
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const fullCapacity = Math.max(1, Math.floor(width / 152));
      setCapacity(items.length <= fullCapacity ? fullCapacity : Math.max(1, Math.floor((width - 84) / 152)));
    });
    observer.observe(root.current); return () => observer.disconnect();
  }, [items.length]);
  const count = Math.max(1, Math.ceil(items.length / capacity));
  const page = paging.key === key && paging.capacity === capacity ? Math.min(paging.page, count - 1) : 0;
  return <div className="ui-paginated-legend" ref={root}>
    <div className="ui-paginated-legend__items" role="group" aria-label={label}>
      {items.slice(page * capacity, (page + 1) * capacity).map(item => <FloatingHint key={item.id} content={item.label}>
        <button type="button" aria-label={item.label} aria-pressed={item.selected} onClick={() => onToggle(item.id)}><i style={{ backgroundColor: item.color }} aria-hidden="true" /><span>{item.label}</span></button>
      </FloatingHint>)}
      {!items.length && <span role="status">没有匹配的图例</span>}
    </div>
    {count > 1 && <div className="ui-paginated-legend__pages" role="group" aria-label={`${label}翻页`}>
      <button type="button" aria-label="上一页图例" disabled={page === 0} onClick={() => setPaging({ key, capacity, page: page - 1 })}><ChevronUp aria-hidden="true" /></button>
      <span aria-live="polite">{page + 1}/{count}</span>
      <button type="button" aria-label="下一页图例" disabled={page === count - 1} onClick={() => setPaging({ key, capacity, page: page + 1 })}><ChevronDown aria-hidden="true" /></button>
    </div>}
  </div>;
}
