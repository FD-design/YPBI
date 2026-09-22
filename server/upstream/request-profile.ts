import { AsyncLocalStorage } from "node:async_hooks";

export interface UpstreamRequestProfile {
  environment: "test";
  baseUrl: string;
  token: string;
  userName: string;
  cachePartition: string;
}

const requestProfileStorage = new AsyncLocalStorage<UpstreamRequestProfile>();

export function runWithUpstreamRequestProfile<T>(
  profile: UpstreamRequestProfile,
  operation: () => Promise<T>
) {
  return requestProfileStorage.run(profile, operation);
}

export function currentUpstreamRequestProfile() {
  return requestProfileStorage.getStore();
}
