export const V2_AUTHENTICATION_REQUIRED_EVENT = "ypbi-v2:authentication-required";

export function notifyAuthenticationRequired() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(V2_AUTHENTICATION_REQUIRED_EVENT));
}
