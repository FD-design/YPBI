import { useRef, type PointerEvent, type RefObject } from "react";

/** Close only for a complete gesture on the backdrop, never a drag from the dialog. */
export function useDialogBackdrop(ref: RefObject<HTMLDialogElement | null>, close: () => void, enabled = true) {
  const startedOutside = useRef(false);
  const outside = (event: PointerEvent<HTMLDialogElement>) => {
    const box = ref.current?.getBoundingClientRect();
    return event.target === event.currentTarget && !!box && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLDialogElement>) => { startedOutside.current = event.button === 0 && outside(event); },
    onPointerCancel: () => { startedOutside.current = false; },
    onPointerUp: (event: PointerEvent<HTMLDialogElement>) => {
      const dismiss = enabled && startedOutside.current && outside(event);
      startedOutside.current = false;
      if (dismiss) { event.stopPropagation(); close(); }
    }
  };
}
