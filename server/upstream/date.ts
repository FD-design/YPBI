export function toBeijingDate(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return "";
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) return text.slice(0, 10);
  const timestamp = new Date(text).getTime();
  if (!Number.isFinite(timestamp)) return text.slice(0, 10);
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
