import { useState, type ReactNode } from "react";
import { DashboardCardModeProvider, type DashboardCardMode } from "../features/dashboards/DashboardCardMode";

/** DEV-only device-local preference; never part of a query or saved object. */
export function PreviewBoardPresentation({ board, children }: { board: string; children: ReactNode }) {
  const key = `ypbi.preview.card-mode.v1:${board}`;
  const [mode, setMode] = useState<DashboardCardMode>(() => { try { return localStorage.getItem(key) === "value" ? "value" : "trend"; } catch { return "trend"; } });
  const [failed, setFailed] = useState(false);
  return <DashboardCardModeProvider mode={mode} notice="仅本机开发体验记忆，不是账号偏好。" onChange={next => { setMode(next); try { localStorage.setItem(key, next); setFailed(false); } catch { setFailed(true); } }}>
    {failed && <p className="topic-preview__pending" role="status">展示模式已切换；本机偏好未保存，刷新后恢复默认。</p>}{children}
  </DashboardCardModeProvider>;
}
