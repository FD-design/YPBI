import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export interface MenuSelectOption {
  value: string;
  label: string;
  meta?: string;
}

export interface MenuSelectGroup {
  label: string;
  options: MenuSelectOption[];
}

interface MenuSelectBaseProps {
  label: string;
  ariaLabel?: string;
  align?: "start" | "end";
}

export function MenuSelect({
  label,
  value,
  groups,
  onChange,
  ariaLabel = label,
  align = "start",
  className = "",
  disabled = false
}: {
  label: string;
  value: string;
  groups: MenuSelectGroup[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  align?: "start" | "end";
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxId = useId();
  const selected = groups.flatMap((group) => group.options).find((option) => option.value === value);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <div ref={rootRef} className={`ui-menu-select ui-menu-select--${align}${className ? ` ${className}` : ""}${open ? " is-open" : ""}`}>
    <button
      ref={triggerRef}
      type="button"
      className="ui-menu-select__trigger"
      aria-label={`${ariaLabel}：${selected?.label ?? "未选择"}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      disabled={disabled}
      onClick={() => setOpen((current) => !current)}
    >
      <span><small>{label}</small><b>{selected?.label ?? "请选择"}</b></span>
      <ChevronDown aria-hidden="true" />
    </button>
    {open && !disabled && <div id={listboxId} className="ui-menu-select__menu" role="listbox" aria-label={ariaLabel}>
      {groups.filter((group) => group.options.length > 0).map((group) => <section key={group.label} className="ui-menu-select__group">
        <div className="ui-menu-select__group-label">{group.label}</div>
        {group.options.map((option) => {
          const active = option.value === value;
          return <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={active}
            className={active ? "is-selected" : ""}
            onClick={() => {
              onChange(option.value);
              setOpen(false);
              triggerRef.current?.focus();
            }}
          >
            <span><b>{option.label}</b>{option.meta && <small>{option.meta}</small>}</span>
            {active && <Check aria-hidden="true" />}
          </button>;
        })}
      </section>)}
    </div>}
  </div>;
}

export function MultiMenuSelect({
  label,
  values,
  options,
  onChange,
  minSelected = 0,
  maxSelected = Number.POSITIVE_INFINITY,
  ariaLabel = label,
  align = "start"
}: MenuSelectBaseProps & {
  values: string[];
  options: MenuSelectOption[];
  onChange: (values: string[]) => void;
  minSelected?: number;
  maxSelected?: number;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxId = useId();
  const selectedOptions = options.filter((option) => values.includes(option.value));

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const summary = selectedOptions.length === 1 ? selectedOptions[0].label : `${selectedOptions.length} 个平台`;
  return <div ref={rootRef} className={`ui-menu-select ui-menu-select--multi ui-menu-select--${align}${open ? " is-open" : ""}`}>
    <button ref={triggerRef} type="button" className="ui-menu-select__trigger" aria-label={`${ariaLabel}：${summary}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId} onClick={() => setOpen((current) => !current)}>
      <span><small>{label}</small><b>{summary}</b></span><ChevronDown aria-hidden="true" />
    </button>
    {open && <div id={listboxId} className="ui-menu-select__menu ui-menu-select__menu--multi" role="listbox" aria-label={ariaLabel} aria-multiselectable="true">
      <section className="ui-menu-select__group">
        <div className="ui-menu-select__group-label">{minSelected > 0 ? `至少 ${minSelected} 项，` : ""}最多 {Number.isFinite(maxSelected) ? maxSelected : options.length} 项</div>
        {options.map((option) => {
          const active = values.includes(option.value);
          const disabled = active ? values.length <= minSelected : values.length >= maxSelected;
          return <button key={option.value} type="button" role="option" aria-selected={active} disabled={disabled} className={active ? "is-selected" : ""} onClick={() => onChange(active ? values.filter((value) => value !== option.value) : [...values, option.value])}>
            <span><b>{option.label}</b>{option.meta && <small>{option.meta}</small>}</span>{active && <Check aria-hidden="true" />}
          </button>;
        })}
      </section>
      <div className="ui-menu-select__footer"><span>已选 {values.length}{Number.isFinite(maxSelected) ? ` / ${maxSelected}` : ""}</span><button type="button" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>完成</button></div>
    </div>}
  </div>;
}
