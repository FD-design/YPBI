import { Component, type ErrorInfo, type ReactNode } from "react";
import { isAssetLoadError, type AssetRecovery } from "../app/assetRecovery";

export function AppFailure({ error, recover }: { error: unknown; recover: AssetRecovery }) {
  return <main className="fatal-state" role="alert"><div><b>页面暂时无法显示</b><p>{isAssetLoadError(error) ? "页面资源加载失败，请刷新后重试。" : "前端渲染发生异常，刷新后可重新加载工作区。"}</p><button onClick={async () => {
    if (!await recover(error, "manual")) window.location.reload();
  }}>刷新页面</button></div></main>;
}

export class AppErrorBoundary extends Component<{ children: ReactNode; recover: AssetRecovery }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("BI 页面渲染失败", error, info.componentStack);
    void this.props.recover(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <AppFailure error={this.state.error} recover={this.props.recover} />;
  }
}
