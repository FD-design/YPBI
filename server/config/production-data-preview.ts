/**
 * Non-secret defaults for this repository's single production BI deployment.
 * The request user name follows the configured primary upstream user; tokens
 * are never stored here and remain scoped to an authenticated preview session.
 */
export const productionDataPreviewDefaults = {
  enabled: true,
  baseUrl: "https://zq-admin-api.ypdev.cc"
} as const;
