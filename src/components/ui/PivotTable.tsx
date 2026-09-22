import type { ReactNode } from "react";
import { PaginatedTable } from "./PaginatedTable";
import "./pivot-table.css";

export interface PivotRow { key: string; label: string; values: ReactNode[]; total?: ReactNode }
export interface PivotCell { rowKey: string; columnIndex: number }
/** Cells and optional totals are query results; presentation never aggregates them. */
export function PivotTable({ label, rowHeading, columns, rows, totals, resetKey = "", onSelectCell, selectedCell, canSelectCell, totalLabel = "合计" }: {
  label: string;
  rowHeading: string;
  columns: string[];
  rows: PivotRow[];
  totals?: PivotRow;
  resetKey?: string;
  onSelectCell?: (cell: PivotCell) => void;
  selectedCell?: PivotCell | null;
  canSelectCell?: (cell: PivotCell) => boolean;
  totalLabel?: string;
}) {
  const hasTotal = rows.some(row => row.total !== undefined) || totals?.total !== undefined;
  const render = (row: PivotRow, total = false) => <tr key={row.key} className={total ? "is-total" : undefined}>
    <th scope="row">{row.label}</th>{columns.map((column, columnIndex) => {
      const cell = { rowKey: row.key, columnIndex };
      const selectable = !total && Boolean(onSelectCell) && (canSelectCell?.(cell) ?? true);
      const selected = selectedCell?.rowKey === row.key && selectedCell.columnIndex === columnIndex;
      return <td key={column} className={selected ? "is-selected" : undefined}>{selectable
        ? <button type="button" className="ui-pivot-table__cell-button" aria-pressed={selected} onClick={() => onSelectCell?.(cell)}><span className="sr-only">{row.label} · {column} · </span>{row.values[columnIndex] ?? "—"}</button>
        : row.values[columnIndex] ?? "—"}</td>;
    })}{hasTotal && <td>{row.total ?? "—"}</td>}
  </tr>;
  return <PaginatedTable label={label} tableClassName="ui-pivot-table" resetKey={resetKey} columnCount={columns.length + 1 + Number(hasTotal)}
    head={<tr><th scope="col">{rowHeading}</th>{columns.map(column => <th key={column} scope="col">{column}</th>)}{hasTotal && <th scope="col">{totalLabel}</th>}</tr>}
    rows={[...rows.map(row => render(row)), ...(totals ? [render(totals, true)] : [])]} />;
}
