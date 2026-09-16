import { useEffect } from "react";

let activeLocks = 0;
let previousOverflow = "";
let previousPaddingRight = "";
let previousDocumentOverflow = "";

function lockBodyScroll() {
  const body = document.body;
  const documentElement = document.documentElement;
  if (activeLocks === 0) {
    previousOverflow = body.style.overflow;
    previousPaddingRight = body.style.paddingRight;
    previousDocumentOverflow = documentElement.style.overflow;

    const widthBeforeLock = body.getBoundingClientRect().width;
    const computedPaddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
    body.style.overflow = "hidden";
    documentElement.style.overflow = "hidden";

    const releasedScrollbarWidth = Math.max(0, body.getBoundingClientRect().width - widthBeforeLock);
    if (releasedScrollbarWidth > 0) {
      body.style.paddingRight = `${computedPaddingRight + releasedScrollbarWidth}px`;
    }
    body.dataset.scrollLocked = "true";
  }
  activeLocks += 1;
}

function unlockBodyScroll() {
  activeLocks = Math.max(0, activeLocks - 1);
  if (activeLocks > 0) return;

  const body = document.body;
  const documentElement = document.documentElement;
  body.style.overflow = previousOverflow;
  body.style.paddingRight = previousPaddingRight;
  documentElement.style.overflow = previousDocumentOverflow;
  delete body.dataset.scrollLocked;
}

/**
 * Keeps the application canvas at a stable width while an overlay prevents
 * background scrolling. Multiple overlays can safely share the same lock.
 */
export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return undefined;
    lockBodyScroll();
    return unlockBodyScroll;
  }, [locked]);
}
