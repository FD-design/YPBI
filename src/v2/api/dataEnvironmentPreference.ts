export type DataEnvironmentMode = "production" | "test";

const storagePrefix = "ypbi.data-environment.v1";
let activeSubjectId = "";
let activeMode: DataEnvironmentMode = "production";

function storageKey(subjectId: string) {
  return `${storagePrefix}:${subjectId}`;
}

export function initializeDataEnvironmentPreference(subjectId: string) {
  activeSubjectId = subjectId;
  try {
    activeMode = sessionStorage.getItem(storageKey(subjectId)) === "test" ? "test" : "production";
  } catch {
    activeMode = "production";
  }
  return activeMode;
}

export function currentDataEnvironmentPreference() {
  return activeMode;
}

export function setDataEnvironmentPreference(mode: DataEnvironmentMode) {
  activeMode = mode;
  if (!activeSubjectId) return;
  try {
    if (mode === "test") sessionStorage.setItem(storageKey(activeSubjectId), mode);
    else sessionStorage.removeItem(storageKey(activeSubjectId));
  } catch {
    // A blocked sessionStorage must not prevent returning to production data.
  }
}

export function dataEnvironmentHeaders(initial?: HeadersInit) {
  const headers = new Headers(initial);
  headers.set("x-ypbi-data-environment", activeMode);
  return headers;
}
