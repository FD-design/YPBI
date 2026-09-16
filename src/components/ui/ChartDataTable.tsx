import { useEffect, useRef, useState, type ReactNode, type ReactElement } from "react";
import { TableProperties, X } from "lucide-react";
import { useBodyScrollLock } from "../layout/useBodyScrollLock";
import "./chart-data-table.css";
import { useDialogBackdrop } from "./useDialogBackdrop";

function DataDialog({ title, children, close, exportAction }: { title: string; children: ReactNode; close: () => void; exportAction: ReactElement }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const initialFocus = useRef<HTMLButtonElement>(null);
  useBodyScrollLock(true);
  useEffect(() => {
    const element = dialog.current;
    // Native dialog focusing steps must see autofocus before showModal runs.
    initialFocus.current?.setAttribute("autofocus", "");
    element?.showModal();
    return () => element?.close();
  }, []);
  const requestClose = () => { dialog.current?.close(); close(); };
  const backdrop = useDialogBackdrop(dialog, requestClose);
  return <dialog {...backdrop} className="ui-chart-data-dialog" ref={dialog} aria-label={title} onCancel={event => { event.preventDefault(); event.stopPropagation(); requestClose(); }}>
    <header><h2>{title}</h2><div className="ui-chart-data-dialog__actions">{exportAction}<button ref={initialFocus} className="ui-icon-button" type="button" aria-label="关闭数据表" onClick={requestClose}><X aria-hidden="true" /></button></div></header>
    <div className="ui-chart-data-dialog__body">{children}</div>
  </dialog>;
}

/** A table is a separate reading surface: opening it never resizes the chart grid. */
export function ChartDataTable({ title, children, label = "查看同口径数据表", exportAction }: { title: string; children: ReactNode; label?: string; exportAction: ReactElement }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  return <div className="ui-chart-data-table">
    <button ref={trigger} className="ui-chart-data-table__trigger" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}><TableProperties aria-hidden="true" />{label}</button>
    {open && <DataDialog title={title} close={close} exportAction={exportAction}>{children}</DataDialog>}
  </div>;
}
