import { useEffect, useSyncExternalStore } from "react";
import { previewFavorites } from "./preview-favorites";
import { readWorkspace, subscribeWorkspace } from "./personal-workspace-model";

export interface LocalDirectoryState { favorites: string[]; boards: { id: string; title: string; category: null; scope: string }[] }
/** Reuse existing device-local objects without treating them as account persistence. */
export default function ConnectedDirectoryState({ onChange }: { onChange: (state: LocalDirectoryState) => void }) {
  const workspace = useSyncExternalStore(subscribeWorkspace, readWorkspace);
  useEffect(() => {
    const update = () => onChange({ favorites: previewFavorites(), boards: [{ id: "all", title: "全部我的看板", category: null, scope: "个人看板" }, ...workspace.boards.map(board => ({ id: board.id, title: board.name, category: null, scope: "个人看板" }))] });
    update(); window.addEventListener("preview-favorites-change", update); window.addEventListener("storage", update);
    return () => { window.removeEventListener("preview-favorites-change", update); window.removeEventListener("storage", update); };
  }, [workspace, onChange]);
  return null;
}
