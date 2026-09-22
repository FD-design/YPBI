import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { FloatingHint } from "../../../components/ui/FloatingHint";
import "./dashboard-card-mode.css";

export type DashboardCardMode = "value" | "trend";
const Context = createContext<{ mode: DashboardCardMode; onChange: (mode: DashboardCardMode) => void; register: () => () => void; count: number; notice: string } | null>(null);
export function DashboardCardModeProvider({ mode, onChange, children, notice = "" }: { mode: DashboardCardMode; onChange: (mode: DashboardCardMode) => void; children: ReactNode; notice?: string }) {
  const [count, setCount] = useState(0);
  const register = useCallback(() => { setCount(n => n + 1); return () => setCount(n => n - 1); }, []);
  const value = useMemo(() => ({ mode, onChange, register, count, notice }), [mode, onChange, register, count, notice]);
  return <Context.Provider value={value}><div className="dashboard-reading-scope" data-card-mode={mode}>{children}</div></Context.Provider>;
}
export function useDashboardCardMode(ordinary: boolean) {
  const context = useContext(Context), register = context?.register;
  useEffect(() => ordinary && register ? register() : undefined, [ordinary, register]);
  return ordinary ? context?.mode : undefined;
}
export function DashboardCardModeControl() {
  const context = useContext(Context);
  if (!context || context.count === 0) return null;
  return <div className="dashboard-card-mode-control">
    <FloatingHint content={`仅切换当前看板的普通指标卡，专用分析图与经营明细保持原样。${context.notice}`}><span>指标卡展示</span></FloatingHint>
    <SegmentedControl label="指标卡展示" value={context.mode} options={[{value:"value",label:"纯数值"},{value:"trend",label:"数值＋趋势"}]} onChange={mode => context.onChange(mode as DashboardCardMode)} />
  </div>;
}
