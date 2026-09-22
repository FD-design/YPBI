import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

export interface MenuSelectOption {
  value: string;
  label: string;
  meta?: string;
  disabled?: boolean;
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

type OpenFocusIntent = "selected" | "first" | "last";

function enabledOptions(root: HTMLElement | null) {
  return [...(root?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])]
    .filter((option) => option.getClientRects().length > 0);
}

function useListboxKeyboard({
  open,
  setOpen,
  rootRef,
  triggerRef
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  rootRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const openFocusIntentRef = useRef<OpenFocusIntent>("selected");
  const typeaheadRef = useRef({ value: "", at: 0 });

  const closeAndRestoreFocus = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openWithIntent = (intent: OpenFocusIntent) => {
    openFocusIntentRef.current = intent;
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const focusInitialOption = window.requestAnimationFrame(() => {
      const options = enabledOptions(rootRef.current);
      const search = rootRef.current?.querySelector<HTMLInputElement>("input[type=search]");
      if (search) { search.focus(); return; }
      if (!options.length) return;
      if (options.includes(document.activeElement as HTMLButtonElement)) {
        openFocusIntentRef.current = "selected";
        return;
      }
      const selectedIndex = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
      const intent = openFocusIntentRef.current;
      const index = intent === "last" ? options.length - 1 : intent === "first" ? 0 : Math.max(0, selectedIndex);
      options[index]?.focus();
      openFocusIntentRef.current = "selected";
    });
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      window.cancelAnimationFrame(focusInitialOption);
      document.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, [open, rootRef, setOpen]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      const intent = event.key === "ArrowUp" || event.key === "End" ? "last" : "first";
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        openWithIntent(intent);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (event.target instanceof HTMLInputElement && !["ArrowDown", "ArrowUp"].includes(event.key)) return;
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }

    const options = enabledOptions(rootRef.current);
    if (!options.length) return;
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % options.length;
    if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? options.length - 1 : (currentIndex - 1 + options.length) % options.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = options.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      options[nextIndex]?.focus();
      return;
    }

    if (event.key.length !== 1 || event.key === " " || event.ctrlKey || event.metaKey || event.altKey) return;
    const now = Date.now();
    const previous = now - typeaheadRef.current.at < 600 ? typeaheadRef.current.value : "";
    const query = `${previous}${event.key}`.toLocaleLowerCase("zh-CN");
    typeaheadRef.current = { value: query, at: now };
    const startIndex = currentIndex < 0 ? 0 : currentIndex + 1;
    const ordered = [...options.slice(startIndex), ...options.slice(0, startIndex)];
    const match = ordered.find((option) => (option.dataset.optionLabel ?? option.textContent ?? "")
      .trim()
      .toLocaleLowerCase("zh-CN")
      .startsWith(query));
    if (match) {
      event.preventDefault();
      match.focus();
    }
  };

  return { closeAndRestoreFocus, onKeyDown, openWithIntent };
}

export function MenuSelect({
  label,
  value,
  groups,
  onChange,
  ariaLabel = label,
  align = "start",
  density = "default",
  className = "",
  disabled = false,
  searchable = false,
  placeholder = "请选择"
}: {
  label: string;
  value: string;
  groups: MenuSelectGroup[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  align?: "start" | "end";
  density?: "default" | "compact";
  className?: string;
  disabled?: boolean;
  searchable?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxId = useId();
  const canSearch = searchable && groups.reduce((count, group) => count + group.options.length, 0) > 8;
  const visibleGroups = groups.map(group => ({ ...group, options: group.options.filter(option => !canSearch || `${option.label} ${option.value} ${option.meta ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) }));
  const selected = groups.flatMap((group) => group.options).find((option) => option.value === value);
  const keyboard = useListboxKeyboard({ open, setOpen, rootRef, triggerRef });

  return <div ref={rootRef} className={`ui-menu-select ui-menu-select--${align} ui-menu-select--${density}${className ? ` ${className}` : ""}${open ? " is-open" : ""}`} onKeyDown={keyboard.onKeyDown}>
    <button
      ref={triggerRef}
      type="button"
      className="ui-menu-select__trigger"
      aria-label={`${ariaLabel}：${selected?.label ?? "未选择"}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      disabled={disabled}
      onClick={() => open ? setOpen(false) : keyboard.openWithIntent("selected")}
    >
      <span><small>{label}</small><b>{selected?.label ?? placeholder}</b></span>
      <ChevronDown aria-hidden="true" />
    </button>
    {open && !disabled && <div id={listboxId} className="ui-menu-select__menu" role="listbox" aria-label={ariaLabel}>
      {canSearch && <input type="search" aria-label={`搜索${label}`} placeholder="搜索名称或编码" value={search} onChange={event => setSearch(event.target.value)} className="ui-menu-select__search" />}
      {canSearch && !visibleGroups.some(group => group.options.length) && <p className="ui-menu-select__group-label">没有匹配项</p>}
      {visibleGroups.filter((group) => group.options.length > 0).map((group) => <section key={group.label} className="ui-menu-select__group" role="group" aria-label={group.label}>
        <div className="ui-menu-select__group-label">{group.label}</div>
        {group.options.map((option) => {
          const active = option.value === value;
          return <button
            key={option.value}
            type="button"
            role="option"
            disabled={option.disabled}
            aria-selected={active}
            tabIndex={-1}
            data-option-label={option.label}
            className={active ? "is-selected" : ""}
            onClick={() => {
              onChange(option.value);
              keyboard.closeAndRestoreFocus();
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
  const keyboard = useListboxKeyboard({ open, setOpen, rootRef, triggerRef });

  const summary = selectedOptions.length === 1 ? selectedOptions[0].label : `${selectedOptions.length} 项`;
  return <div ref={rootRef} className={`ui-menu-select ui-menu-select--multi ui-menu-select--${align}${open ? " is-open" : ""}`} onKeyDown={keyboard.onKeyDown}>
    <button ref={triggerRef} type="button" className="ui-menu-select__trigger" aria-label={`${ariaLabel}：${summary}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId} onClick={() => open ? setOpen(false) : keyboard.openWithIntent("selected")}>
      <span><small>{label}</small><b>{summary}</b></span><ChevronDown aria-hidden="true" />
    </button>
    {open && <div id={listboxId} className="ui-menu-select__menu ui-menu-select__menu--multi" role="listbox" aria-label={ariaLabel} aria-multiselectable="true">
      <section className="ui-menu-select__group" role="group" aria-label={ariaLabel}>
        <div className="ui-menu-select__group-label">{minSelected > 0 ? `至少 ${minSelected} 项，` : ""}最多 {Number.isFinite(maxSelected) ? maxSelected : options.length} 项</div>
        {options.map((option) => {
          const active = values.includes(option.value);
          const disabled = active ? values.length <= minSelected : values.length >= maxSelected;
          return <button key={option.value} type="button" role="option" aria-selected={active} tabIndex={-1} data-option-label={option.label} disabled={disabled || option.disabled} className={active ? "is-selected" : ""} onClick={() => onChange(active ? values.filter((value) => value !== option.value) : [...values, option.value])}>
            <span><b>{option.label}</b>{option.meta && <small>{option.meta}</small>}</span>{active && <Check aria-hidden="true" />}
          </button>;
        })}
      </section>
      <div className="ui-menu-select__footer"><span>已选 {values.length}{Number.isFinite(maxSelected) ? ` / ${maxSelected}` : ""}</span><button type="button" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>完成</button></div>
    </div>}
  </div>;
}
