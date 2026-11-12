/**
 * Non-secret defaults for this repository's single production BI deployment.
 * The address and username identify the test backend. Tokens belong to the
 * authenticated preview session.
 */
export const productionDataPreviewDefaults = {
  enabled: true,
  baseUrl: "https://zq-admin-api.ypdev.cc",
  userName: "xcq"
} as const;

export function usesDefaultTestPreviewOrigin(baseUrl: string) {
  return new URL(baseUrl).origin === new URL(productionDataPreviewDefaults.baseUrl).origin;
}
