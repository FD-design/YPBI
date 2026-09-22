export interface DirectoryItem { id: string; title: string; category: string | null; scope: string; favorite?: boolean }
export interface DirectoryNavigationState { query: string; collapsed: string[]; hidden: boolean }

export function normalizeDirectoryNavigation(value: unknown, categories: readonly string[]): DirectoryNavigationState {
  const candidate = value && typeof value === "object" ? value as Partial<DirectoryNavigationState> : {};
  return {
    query: typeof candidate.query === "string" ? candidate.query.slice(0, 120) : "",
    collapsed: Array.isArray(candidate.collapsed) ? [...new Set(candidate.collapsed.filter((name) => typeof name === "string" && (categories.includes(name) || name === "我的收藏")))] : [],
    hidden: candidate.hidden === true
  };
}
