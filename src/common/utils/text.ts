export function makeTextPreview(text: string, maxLen: number): string {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  const n = Math.max(0, Math.min(5000, Math.trunc(maxLen)));
  if (n === 0 || normalized.length === 0) return "";
  if (normalized.length <= n) return normalized;
  return `${normalized.slice(0, n)}...`;
}
