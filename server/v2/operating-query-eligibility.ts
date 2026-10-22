/** Production admission is explicit; test admission follows the validated request profile. */
export function operatingQueryEnvironmentEnabled(environment: "test" | "production", productionEnabled = false) {
  return environment === "test" || productionEnabled === true;
}
