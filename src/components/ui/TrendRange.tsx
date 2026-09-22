import { useMemo, useRef, useState } from "react";
import "./trend-range.css";
export function useTrendRange(dates: string[]) {
  const key = dates.join(",");
  const [state, setState] = useState({ key, start: 0, end: dates.length - 1 });
  const range = state.key === key ? state : { key, start: 0, end: dates.length - 1 };
  if (state.key !== key) setState(range);
  const setRange = (start: number, end: number) => setState({ key, start: Math.max(0, Math.min(start, end)), end: Math.min(dates.length - 1, Math.max(start, end)) });
  return { start: range.start, end: range.end, setRange };
}
export function TrendRange({ dates, values = [], start, end, onChange }: { dates: string[]; values?: Array<number | null>; start: number; end: number; onChange: (start: number, end: number) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; start: number; end: number } | null>(null);
  const preview = useMemo(() => {
    const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));
    if (!valid.length) return "";
    const min = Math.min(...valid), span = Math.max(...valid) - min || 1;
    let drawing = false;
    return values.map((value, i) => {
      if (value === null || !Number.isFinite(value)) { drawing = false; return ""; }
      const command = drawing ? "L" : "M"; drawing = true;
      return `${command}${i / Math.max(1, dates.length - 1) * 1000},${25 - (value - min) / span * 20}`;
    }).join(" ");
  }, [dates.length, values]);
  const pan = (next: number, length = end - start) => { const left = Math.max(0, Math.min(dates.length - 1 - length, next)); onChange(left, left + length); };
  if (dates.length <= 31) return null;
  return <div className="ui-trend-range" role="group" aria-label="缩放可见日期范围">
    <div className="ui-trend-range__summary"><span>{dates[start]} 至 {dates[end]}</span><button type="button" disabled={start === 0 && end === dates.length - 1} onClick={() => onChange(0, dates.length - 1)}>全部</button></div>
    <div ref={track} className="ui-trend-range__track">
      <svg viewBox="0 0 1000 30" preserveAspectRatio="none" aria-hidden="true"><path d={preview} /></svg>
      <button type="button" className="ui-trend-range__window" aria-label="平移可见日期范围" title="拖动两端缩放，拖动中间平移" style={{ left: `${start / (dates.length - 1) * 100}%`, width: `${(end - start) / (dates.length - 1) * 100}%` }}
        onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, start, end }; }}
        onPointerMove={event => { if (!drag.current) return; const width = track.current?.clientWidth ?? 1; pan(drag.current.start + Math.round((event.clientX - drag.current.x) / width * (dates.length - 1)), drag.current.end - drag.current.start); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); pan(event.key === "Home" ? 0 : event.key === "End" ? dates.length - 1 : start + (event.key === "ArrowLeft" ? -1 : 1)); } }} />
      <input className="ui-trend-range__handle is-start" aria-label="图表起始日期" aria-valuetext={dates[start]} type="range" min={0} max={dates.length - 1} value={start} onChange={event => onChange(Math.min(Number(event.target.value), end), end)} />
      <input className="ui-trend-range__handle is-end" aria-label="图表截止日期" aria-valuetext={dates[end]} type="range" min={0} max={dates.length - 1} value={end} onChange={event => onChange(start, Math.max(start, Number(event.target.value)))} />
    </div>
  </div>;
}
