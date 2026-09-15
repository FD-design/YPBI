import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../../../components/ui/Button";
import "./analysis-scope-controls.css";

export interface AnalysisScopeValue {
  client: string;
  audience: string;
}

export interface AnalysisScopeOption {
  value: string;
  label: string;
  disabled?: boolean;
  color?: string;
}

export type AnalysisDisplayMode = "overall" | "groups";

export interface AnalysisGroupDisplay {
  mode: AnalysisDisplayMode;
  onModeChange: (mode: AnalysisDisplayMode) => void;
  clientOptions: AnalysisScopeOption[];
  selectedClients: string[];
  onClientsChange: (values: string[]) => void;
  audienceOptions?: AnalysisScopeOption[];
  selectedAudiences?: string[];
  onAudiencesChange?: (values: string[]) => void;
  onRestoreAll: () => void;
  canRestoreAll?: boolean;
}

/**
 * Keeps low-cardinality visibility state shared by the scope bar and trend.
 * A query-key change restores every applicable group; no totals are derived here.
 */
export const analysisGroupId = (client: string, audience: string) => `${client}:${audience}`;
export interface AnalysisGroupVisibilityState { key: string; groups: string[] }
export type AnalysisGroupVisibilityAction =
  | { type: "groups" | "clients" | "audiences"; values: string[] }
  | { type: "toggle"; id: string }
  | { type: "selectOnly"; client: string; audience?: string }
  | { type: "reset" };

/** Canonical selected-pair state; projecting its axes must not recreate hidden cells. */
export function reduceAnalysisGroupVisibility(previous: AnalysisGroupVisibilityState | undefined, clientValues: string[], audienceValues: string[], queryKey: string, action?: AnalysisGroupVisibilityAction): AnalysisGroupVisibilityState {
  const clients = [...new Set(clientValues)], audiences = [...new Set(audienceValues)];
  const pairs = clients.flatMap(client => audiences.map(audience => ({ client, audience, id: analysisGroupId(client, audience) })));
  const key = JSON.stringify([queryKey, clients, audiences]);
  const initial = { key, groups: pairs.map(pair => pair.id) };
  const state = previous?.key === key ? previous : initial;
  if (!action) return state;
  if (action.type === "reset") return initial;
  const selected = new Set(state.groups);
  const selectedPairs = pairs.filter(pair => selected.has(pair.id));
  let next: string[];
  if (action.type === "groups") next = pairs.filter(pair => action.values.includes(pair.id)).map(pair => pair.id);
  else if (action.type === "toggle") next = pairs.filter(pair => pair.id === action.id ? !selected.has(pair.id) : selected.has(pair.id)).map(pair => pair.id);
  else if (action.type === "selectOnly") {
    const selectedClient = clients.includes(action.client) ? action.client : null;
    const selectedAudience = action.audience && audiences.includes(action.audience) ? action.audience : null;
    next = pairs.filter(pair => (!selectedClient || pair.client === selectedClient) && (!selectedAudience || pair.audience === selectedAudience)).map(pair => pair.id);
  } else {
    const dimension = action.type === "clients" ? "client" : "audience";
    const otherDimension = dimension === "client" ? "audience" : "client";
    const currentValues = new Set(selectedPairs.map(pair => pair[dimension]));
    const otherValues = new Set(selectedPairs.map(pair => pair[otherDimension]));
    next = pairs.filter(pair => action.values.includes(pair[dimension]) && (selected.has(pair.id) || (!currentValues.has(pair[dimension]) && otherValues.has(pair[otherDimension])))).map(pair => pair.id);
  }
  // Empty capability sets are valid; a visible nonempty set keeps its last group.
  return next.length ? { key, groups: next } : state;
}

export function useAnalysisGroupVisibility(clientValues: string[], audienceValues: string[], queryKey: string) {
  const initial = () => reduceAnalysisGroupVisibility(undefined, clientValues, audienceValues, queryKey);
  const [state, setState] = useState(initial);
  const current = reduceAnalysisGroupVisibility(state, clientValues, audienceValues, queryKey);
  useEffect(() => {
    if (state.key !== current.key) setState(initial());
  }, [current.key]);
  const dispatch = (action: AnalysisGroupVisibilityAction) => setState(previous => reduceAnalysisGroupVisibility(previous, clientValues, audienceValues, queryKey, action));
  const allGroups = initial().groups;
  return {
    clients: clientValues.filter(client => audienceValues.some(audience => current.groups.includes(analysisGroupId(client, audience)))),
    audiences: audienceValues.filter(audience => clientValues.some(client => current.groups.includes(analysisGroupId(client, audience)))),
    groups: current.groups,
    allGroups,
    setGroups: (values: string[]) => dispatch({ type: "groups", values }),
    toggleGroup: (id: string) => dispatch({ type: "toggle", id }),
    isGroupVisible: (client: string, audience: string) => current.groups.includes(analysisGroupId(client, audience)),
    setClients: (values: string[]) => dispatch({ type: "clients", values }),
    setAudiences: (values: string[]) => dispatch({ type: "audiences", values }),
    restoreAll: () => dispatch({ type: "reset" }),
    selectOnly: (client: string, audience?: string) => dispatch({ type: "selectOnly", client, audience }),
    isAll: current.groups.length === allGroups.length
  };
}

const DEFAULT_AUDIENCE_OPTIONS: AnalysisScopeOption[] = [
  { value: "overall", label: "总体" },
  { value: "new", label: "新用户" },
  { value: "existing", label: "老用户" }
];

function ScopeChoice({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: AnalysisScopeOption[];
  onChange: (value: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const enabled = options.filter(option => !option.disabled);
  const selectedEnabled = enabled.some(option => option.value === value);
  const move = (event: KeyboardEvent<HTMLButtonElement>, option: AnalysisScopeOption) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!enabled.length) return;
    const index = Math.max(0, enabled.findIndex(item => item.value === option.value));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? enabled.length - 1
        : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : enabled.length - 1)) % enabled.length;
    const next = enabled[nextIndex];
    onChange(next.value);
    window.requestAnimationFrame(() => root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")[nextIndex]?.focus());
  };
  return <div className="analysis-scope-controls__field">
    <span>{label}</span>
    <div ref={root} className="analysis-scope-controls__choices" role="radiogroup" aria-label={label}>
      {options.map(option => <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={value === option.value}
        disabled={option.disabled}
        tabIndex={!option.disabled && (value === option.value || (!selectedEnabled && enabled[0]?.value === option.value)) ? 0 : -1}
        onClick={() => onChange(option.value)}
        onKeyDown={event => move(event, option)}
      >{option.label}</button>)}
    </div>
  </div>;
}

function VisibilityChoice({ label, values, options, onChange }: {
  label: string;
  values: string[];
  options: AnalysisScopeOption[];
  onChange: (values: string[]) => void;
}) {
  const enabledValues = options.filter(option => !option.disabled).map(option => option.value);
  const toggle = (option: AnalysisScopeOption) => {
    if (option.disabled) return;
    const selected = values.includes(option.value);
    const next = selected ? values.filter(value => value !== option.value) : [...values, option.value];
    if (next.some(value => enabledValues.includes(value))) onChange(next);
  };
  return <div className="analysis-scope-controls__field">
    <span>{label}</span>
    <div className="analysis-scope-controls__choices is-multiple" role="group" aria-label={label}>
      {options.map(option => {
        const selected = values.includes(option.value);
        const lastSelected = selected && values.filter(value => enabledValues.includes(value)).length === 1;
        return <button
          key={option.value}
          type="button"
          aria-pressed={selected}
          disabled={option.disabled || lastSelected}
          onClick={() => toggle(option)}
        >{option.color && <i aria-hidden="true" style={{ backgroundColor: option.color }} />}{option.label}</button>;
      })}
    </div>
  </div>;
}

/**
 * Keeps the two stable analysis dimensions together. It only publishes scope
 * changes; totals, availability and dependent filters stay with the caller.
 */
export function AnalysisScopeControls({
  label,
  scope,
  clientOptions,
  audienceOptions = DEFAULT_AUDIENCE_OPTIONS,
  onChange,
  onReset,
  canReset,
  groupDisplay,
  children,
  tools,
  note
}: {
  label: string;
  scope?: AnalysisScopeValue;
  clientOptions?: AnalysisScopeOption[];
  audienceOptions?: AnalysisScopeOption[];
  onChange?: (scope: AnalysisScopeValue) => void;
  onReset?: () => void;
  canReset?: boolean;
  groupDisplay?: AnalysisGroupDisplay;
  children?: ReactNode;
  tools?: ReactNode;
  note?: string;
}) {
  return <section className="analysis-scope-controls" aria-label={label}>
    <div className="analysis-scope-controls__main">
      <div className="analysis-scope-controls__conditions">
        <strong className="analysis-scope-controls__label">{label}</strong>
        {scope && onChange && clientOptions && <ScopeChoice label="客户端" value={scope.client} options={clientOptions} onChange={client => onChange({ ...scope, client })} />}
        {scope && onChange && audienceOptions.length > 0 && <ScopeChoice label="用户人群" value={scope.audience} options={audienceOptions} onChange={audience => onChange({ ...scope, audience })} />}
        {children && <div className="analysis-scope-controls__dependent">{children}</div>}
        {groupDisplay && <>
          <ScopeChoice label="展示方式" value={groupDisplay.mode} options={[{ value: "overall", label: "总体" }, { value: "groups", label: "分组对比" }]} onChange={value => groupDisplay.onModeChange(value as AnalysisDisplayMode)} />
          {groupDisplay.mode === "groups" && <>
            <VisibilityChoice label="客户端分组" values={groupDisplay.selectedClients} options={groupDisplay.clientOptions} onChange={groupDisplay.onClientsChange} />
            {groupDisplay.audienceOptions?.length && groupDisplay.selectedAudiences && groupDisplay.onAudiencesChange
              ? <VisibilityChoice label="用户人群分组" values={groupDisplay.selectedAudiences} options={groupDisplay.audienceOptions} onChange={groupDisplay.onAudiencesChange} />
              : null}
          </>}
        </>}
      </div>
      {(onReset || groupDisplay || tools) && <div className="analysis-scope-controls__tools">
        {onReset && <Button size="sm" variant="ghost" disabled={canReset === false} onClick={onReset}>恢复总体</Button>}
        {groupDisplay && groupDisplay.mode === "groups" && <Button size="sm" variant="ghost" disabled={groupDisplay.canRestoreAll === false} onClick={groupDisplay.onRestoreAll}>恢复全部分组</Button>}
        {tools}
      </div>}
    </div>
    {note && <p className="analysis-scope-controls__note">{note}</p>}
  </section>;
}

export default AnalysisScopeControls;
