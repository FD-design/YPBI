import { ChevronLeft, ChevronRight } from "lucide-react";
import { pageBounds, pageItems } from "./pagination-model";
import "./pagination.css";

export function Pagination({ total, page, pageSize, onPage, onPageSize, compact = false, label = "数据分页" }: {
  total: number; page: number; pageSize: number; onPage: (page: number) => void;
  onPageSize?: (size: number) => void; compact?: boolean; label?: string;
}) {
  const { current, count, start, end } = pageBounds(total, pageSize, page);
  return <nav className={`ui-pagination${compact ? " is-compact" : ""}`} aria-label={label}>
    <span className="ui-pagination__range" aria-live="polite">{total ? `${start + 1}–${end}` : "0"} / 共 {total} 条</span>
    {total > 20 && onPageSize && !compact && <label>每页 <select aria-label="每页条数" value={pageSize} onChange={event => onPageSize(Number(event.target.value))}>{[20, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select> 条</label>}
    {count > 1 && <div className="ui-pagination__pages">
      <button type="button" aria-label="上一页" disabled={current === 0} onClick={() => onPage(current - 1)}><ChevronLeft /></button>
      {pageItems(count, current).map((item, index) => item === "gap" ? <span aria-hidden="true" key={`gap-${index}`}>…</span> : <button type="button" key={item} aria-label={`第 ${item + 1} 页`} aria-current={current === item ? "page" : undefined} onClick={() => onPage(item)}>{item + 1}</button>)}
      <button type="button" aria-label="下一页" disabled={current === count - 1} onClick={() => onPage(current + 1)}><ChevronRight /></button>
    </div>}
    {!compact && count > 5 && <form onSubmit={event => { event.preventDefault(); const value = Number(new FormData(event.currentTarget).get("page")); if (Number.isInteger(value) && value >= 1 && value <= count) onPage(value - 1); }}><label>到 <input key={current} name="page" aria-label="跳转页码" type="number" min={1} max={count} defaultValue={current + 1} /> 页</label><button type="submit">跳转</button></form>}
  </nav>;
}
