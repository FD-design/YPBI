import { createContext, useContext, type ReactNode } from "react";
import "./data-origin.css";

const DataOriginContext = createContext<"demo" | "pending" | null>(null);
export const DataOriginProvider = DataOriginContext.Provider;
export function useDataOrigin() { return useContext(DataOriginContext); }

/** Only explicit development fixtures opt into this label; query errors never do. */
export function DemoDataProvider({ children }: { children: ReactNode }) {
  return <DataOriginContext.Provider value="demo">{children}</DataOriginContext.Provider>;
}

export function DataOriginBadge() {
  const origin = useDataOrigin();
  if (origin === "pending") return <span className="data-origin-badge data-origin-badge--pending" title="真实后台结果，待验数；完整性与数据水位详见指标说明">待验数</span>;
  return origin === "demo"
    ? <span className="data-origin-badge data-origin-badge--demo" title="合成数据用于展示页面效果，真实接口尚未接入">演示数据</span>
    : null;
}
