import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { Pagination } from "./Pagination";
import { pageBounds } from "./pagination-model";

/** The viewport and footer are siblings: paging never scrolls out of reach. */
export function PaginatedTable({ label, head, rows, compact = false, tableClassName = "", resetKey = "", columnCount = 1 }: {
  label: string; head: ReactNode; rows: ReactElement[]; compact?: boolean; tableClassName?: string; resetKey?: string; columnCount?: number;
}) {
  const [state, setState] = useState({ key: resetKey, page: 0, size: 50 });
  if (state.key !== resetKey) setState({ ...state, key: resetKey, page: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const page = state.key === resetKey ? state.page : 0;
  const bounds = pageBounds(rows.length, state.size, page);
  const update = (page: number, size = state.size) => { setState({ key: resetKey, page, size }); viewport.current?.scrollTo({ top: 0 }); };
  return <div className={`ui-result-table${compact ? " is-compact" : ""}`}>
    <div ref={viewport} className="ui-result-table__viewport" tabIndex={0} role="region" aria-label={label}>
      <table className={tableClassName} aria-label={label}><thead>{head}</thead><tbody>{rows.length ? rows.slice(bounds.start, bounds.end) : <tr><td colSpan={columnCount}>没有可展示的数据</td></tr>}</tbody></table>
    </div>
    <Pagination label={`${label}分页`} total={rows.length} page={bounds.current} pageSize={state.size} onPage={next => update(next)} onPageSize={size => update(0, size)} compact={compact} />
  </div>;
}
