import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import "./toast.css";

export interface ToastNotice { id: number; message: string; persistent: boolean }
export function useToast() {
  const [notice, setNotice] = useState<ToastNotice | null>(null);
  const sequence = useRef(0);
  return { notice, notify: (message: string | null, persistent = false) => setNotice(message ? { id: ++sequence.current, message, persistent } : null) };
}

export function Toast({ notice, onClose }: { notice: ToastNotice; onClose: () => void }) {
  return <ToastMessage key={notice.id} notice={notice} onClose={onClose} />;
}
function ToastMessage({ notice, onClose }: { notice: ToastNotice; onClose: () => void }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const remaining = useRef(3000), close = useRef(onClose);
  close.current = onClose;
  useEffect(() => { const update = () => setHidden(document.hidden); document.addEventListener("visibilitychange", update); return () => document.removeEventListener("visibilitychange", update); }, []);
  useEffect(() => {
    if (notice.persistent || hovered || focused || hidden) return;
    const started = performance.now();
    const timer = setTimeout(() => close.current(), remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (performance.now() - started)); };
  }, [notice.persistent, hovered, focused, hidden]);
  return createPortal(<div className="ui-toast" role="status" aria-live="polite" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(false); }}>
    <span>{notice.message}</span><button type="button" aria-label="关闭提示" onClick={onClose}><X aria-hidden="true" /></button>
  </div>, document.body);
}
