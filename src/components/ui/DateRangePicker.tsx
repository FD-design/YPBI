import { Button } from "./Button";
import { CalendarRange, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useBodyScrollLock } from "../layout/useBodyScrollLock";
import { isDate, monthCells, quickDateRanges, rangeError, shiftDate, shiftMonth, type DateRangeLimits, type DateRangeValue } from "./date-range-model";
import "./date-range-picker.css";
export type { DateRangeValue } from "./date-range-model";

export function DateRangePicker({ value, onChange, boundaryLabel, ...limits }: DateRangeLimits & { value: DateRangeValue; onChange: (value: DateRangeValue) => void; boundaryLabel?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  return <div className="ui-date-range">
    <button ref={trigger} className="ui-date-range__trigger" type="button" aria-label={`日期范围：${value.start.replaceAll("-", ".")} — ${value.end.replaceAll("-", ".")}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(true)}>
      <CalendarRange aria-hidden="true" /><span>{value.start.replaceAll("-", ".")} — {value.end.replaceAll("-", ".")}</span><ChevronDown aria-hidden="true" />
    </button>
    {open && <DatePanel id={id} value={value} limits={limits} boundaryLabel={boundaryLabel} anchor={trigger.current} onCancel={close} onConfirm={(next) => { onChange(next); close(); }} />}
  </div>;
}

function DatePanel({ id, value, limits, boundaryLabel = "可查询数据截至", anchor, onCancel, onConfirm }: { id: string; value: DateRangeValue; limits: DateRangeLimits; boundaryLabel?: string; anchor: HTMLElement | null; onCancel: () => void; onConfirm: (value: DateRangeValue) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(value);
  const [month, setMonth] = useState(shiftMonth(value.end, -1));
  const [startAnchor, setStartAnchor] = useState<string | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [quickKey, setQuickKey] = useState<string | null>(() => quickDateRanges(limits).find(quick => !quick.reason && quick.start === value.start && quick.end === value.end)?.label ?? null);
  const [focused, setFocused] = useState(value.end);
  const error = rangeError(draft, limits);
  useBodyScrollLock(true);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    const position = () => {
      if (window.innerWidth < 768) { dialog.style.removeProperty("left"); dialog.style.removeProperty("top"); return; }
      const box = anchor?.getBoundingClientRect();
      const width = dialog.getBoundingClientRect().width, height = dialog.getBoundingClientRect().height;
      dialog.style.left = `${Math.max(12, Math.min((box?.right ?? window.innerWidth - 12) - width, window.innerWidth - width - 12))}px`;
      dialog.style.top = `${Math.max(12, Math.min((box?.bottom ?? 50) + 8, window.innerHeight - height - 12))}px`;
    };
    position(); window.addEventListener("resize", position);
    return () => { window.removeEventListener("resize", position); dialog.close(); };
  }, [anchor]);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>(`[data-calendar-date="${value.end}"]`)?.focus(); }, [value.end]);
  const moveMonth = (next: string) => {
    setMonth(next);
    const start = limits.minDate && limits.minDate > next ? limits.minDate : next;
    if (focused.slice(0, 7) < next.slice(0, 7) || focused.slice(0, 7) > shiftMonth(next, 1).slice(0, 7)) setFocused(start > limits.maxDate ? limits.maxDate : start);
  };
  const choose = (date: string) => {
    setQuickKey(null); setFocused(date);
    if (!startAnchor) { setStartAnchor(date); setHoverDate(null); setDraft({ start: date, end: date }); return; }
    setDraft({ start: date < startAnchor ? date : startAnchor, end: date < startAnchor ? startAnchor : date });
    setStartAnchor(null); setHoverDate(null);
  };
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, date: string) => {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -(day + 6) % 7, End: 6 - (day + 6) % 7 };
    if (!(event.key in offsets)) return;
    event.preventDefault(); const next = shiftDate(date, offsets[event.key]);
    if (next > limits.maxDate || (limits.minDate && next < limits.minDate)) return;
    if (next.slice(0, 7) < month.slice(0, 7)) setMonth(shiftMonth(next, 0));
    else if (next.slice(0, 7) > shiftMonth(month, 1).slice(0, 7)) setMonth(shiftMonth(next, -1));
    setFocused(next); requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-calendar-date="${next}"]`)?.focus());
  };
  const previewEnd = startAnchor && hoverDate ? hoverDate : draft.end;
  const rangeStart = startAnchor && previewEnd < startAnchor ? previewEnd : draft.start;
  const rangeEnd = startAnchor && previewEnd < startAnchor ? startAnchor : previewEnd;
  return createPortal(<dialog ref={ref} id={id} className="ui-date-panel" data-ui-scope={anchor?.closest(".ypbi-v2") ? "v2" : undefined} aria-label="选择日期范围" onCancel={(event) => { event.preventDefault(); onCancel(); }}
    onClick={(event) => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onCancel(); } }}>
    <header><strong>日期范围</strong><small>{boundaryLabel} {limits.maxDate}</small><button type="button" aria-label="关闭日期选择" onClick={onCancel}><X /></button></header>
    <div className="ui-date-panel__body">
      <aside aria-label="快捷日期"><strong>快捷选择</strong><div className="ui-date-panel__quick-grid">
        {quickDateRanges(limits).map((quick) => <button key={quick.label} type="button" aria-disabled={Boolean(quick.reason)} aria-pressed={quickKey === quick.label}
          title={quick.reason ?? `${quick.start} 至 ${quick.end}`} onClick={() => { if (quick.reason) return; setDraft({ start: quick.start, end: quick.end }); setMonth(shiftMonth(quick.end, -1)); setStartAnchor(null); setFocused(quick.end); setQuickKey(quick.label); }}>
          {quick.label}{quick.reason && <small>{quick.reason}</small>}
        </button>)}
      </div><small>过去 N 天以可查询截止日为准</small></aside>
      <div className="ui-date-panel__custom">
        <div className="ui-date-panel__inputs">{(["start", "end"] as const).map((key) => <label key={key}><span>{key === "start" ? "开始日期" : "结束日期"}</span><input type="date" min={limits.minDate} max={limits.maxDate} value={draft[key]} onChange={(event) => { const date = event.target.value; setDraft((previous) => ({ ...previous, [key]: date })); setQuickKey(null); setStartAnchor(null); if (isDate(date)) { setMonth(shiftMonth(date, key === "end" ? -1 : 0)); setFocused(date); } }} /></label>)}</div>
        <div className="ui-date-panel__months" onMouseLeave={() => setHoverDate(null)}>{[month, shiftMonth(month, 1)].map((visible, index) => <section key={index} aria-label={`${visible.slice(0, 7)}日历`}>
          <header>{index === 0 ? <><button type="button" aria-label="上一年" onClick={() => moveMonth(shiftMonth(month, -12))}><ChevronsLeft /></button><button type="button" aria-label="上个月" onClick={() => moveMonth(shiftMonth(month, -1))}><ChevronLeft /></button></> : <span />}
            <strong>{Number(visible.slice(0, 4))} 年 {Number(visible.slice(5, 7))} 月</strong>
            {index === 1 ? <><button type="button" aria-label="下个月" disabled={shiftMonth(month, 2) > limits.maxDate} onClick={() => moveMonth(shiftMonth(month, 1))}><ChevronRight /></button><button type="button" aria-label="下一年" disabled={shiftMonth(month, 12) > limits.maxDate} onClick={() => moveMonth(shiftMonth(month, 12))}><ChevronsRight /></button></> : <span />}</header>
          <div className="ui-date-panel__days"><div className="ui-date-panel__week">{"一二三四五六日".split("").map((day) => <span key={day}>{day}</span>)}</div>
            <div className="ui-date-panel__grid">{monthCells(visible).map((date) => date.slice(0, 7) !== visible.slice(0, 7) ? <span key={date} /> : <button key={date} type="button" data-calendar-date={date}
              aria-label={date.replaceAll("-", ".")} aria-pressed={date >= rangeStart && date <= rangeEnd} tabIndex={date === focused ? 0 : -1}
              className={`${date >= rangeStart && date <= rangeEnd ? "is-range" : ""}${date === rangeStart || date === rangeEnd ? " is-endpoint" : ""}${date === startAnchor ? " is-anchor" : ""}`}
              disabled={date > limits.maxDate || Boolean(limits.minDate && date < limits.minDate)} onClick={() => choose(date)} onMouseEnter={() => { if (date <= limits.maxDate && (!limits.minDate || date >= limits.minDate)) setHoverDate(date); }} onKeyDown={(event) => navigate(event, date)}>{Number(date.slice(8))}</button>)}</div>
          </div></section>)}</div>
        <p className="ui-date-panel__guidance" aria-live="polite">{startAnchor ? `已选开始日期 ${startAnchor.replaceAll("-", ".")}，请选择结束日期` : "可跨月选择，确认后回填筛选条件"}</p>
      </div>
    </div>
    <footer><span role="status">{error ?? `${draft.start} 至 ${draft.end}`}</span><Button type="button" onClick={onCancel}>取消</Button><Button variant="primary" type="button" disabled={Boolean(error) || Boolean(startAnchor)} onClick={() => onConfirm(draft)}>确认日期</Button></footer>
  </dialog>, document.body);
}
