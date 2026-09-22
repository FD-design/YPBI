/**
 * Single build-time authority for review-only surfaces.
 * Normal production builds keep this false; the explicit internal-preview
 * build enables the same bounded routes that local development exposes.
 */
export const internalPreviewEnabled = import.meta.env.DEV
  || import.meta.env.VITE_INTERNAL_DASHBOARD_PREVIEW_ENABLED === "true";
