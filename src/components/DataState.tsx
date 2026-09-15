export function DataState({ loading, error, empty, loadingLabel = "正在加载真实数据...", emptyLabel = "当前筛选条件下暂无数据", onRetry }: { loading: boolean; error?: string | null; empty: boolean; loadingLabel?: string; emptyLabel?: string; onRetry?: () => void }) {
  if (loading) return <div className="data-state loading" role="status"><span className="state-spinner" /><b>{loadingLabel}</b><span className="data-state-progress" aria-hidden="true"><i /></span></div>;
  if (error) return <div className="data-state error" role="alert"><div><b>数据加载失败</b><span>{error}</span></div>{onRetry && <button type="button" onClick={onRetry}>重试</button>}</div>;
  if (empty) return <div className="data-state empty"><b>暂无真实数据</b><span>{emptyLabel}</span></div>;
  return null;
}
