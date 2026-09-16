import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useBodyScrollLock } from "../../../components/layout/useBodyScrollLock";
import { restoreReadingFocus } from "../../../components/ui/FloatingHint";
import { useDialogBackdrop } from "../../../components/ui/useDialogBackdrop";
import { LiveDashboardContext } from "./LiveDashboardContext";

export function MetricReadingDialog({ title, content, onClose, dismissOnBackdrop = true }: { title: string; content: ReactNode; onClose: () => void; dismissOnBackdrop?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdrop = useDialogBackdrop(ref, onClose, dismissOnBackdrop);
  const anchor = useRef(document.activeElement as HTMLElement | null);
  useBodyScrollLock(true);
  useEffect(() => { ref.current?.showModal(); const dialog = ref.current, trigger = anchor.current; return () => { dialog?.close(); restoreReadingFocus(trigger); }; }, []);
  return <dialog {...backdrop} ref={ref} className="v2-metric-detail" aria-label={title} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <header className="v2-metric-detail__head"><div><h2>{title}</h2></div><button type="button" className="ui-icon-button" aria-label="关闭详情" onClick={onClose} autoFocus><X aria-hidden="true" /></button></header>
    <div className="v2-metric-detail__body" tabIndex={0} role="region" aria-label="详情内容"><LiveDashboardContext.Provider value={null}>{content}</LiveDashboardContext.Provider></div>
  </dialog>;
}
