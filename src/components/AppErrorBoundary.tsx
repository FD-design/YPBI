import { Component, type ErrorInfo, type ReactNode } from "react";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("BI 页面渲染失败", error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="fatal-state" role="alert"><div><b>页面暂时无法显示</b><p>前端渲染发生异常，刷新后可重新加载工作区。</p><button onClick={() => window.location.reload()}>刷新页面</button></div></main>;
  }
}
