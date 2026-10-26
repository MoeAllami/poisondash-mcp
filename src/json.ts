/**
 * The backend serializes several fields (results_json, config_json,
 * provenance data_json / important_features) as opaque strings rather than
 * nested JSON. Every one of them must be treated as untrusted: parse inside
 * try/catch and tolerate missing, partial, or stub shapes rather than
 * throwing and losing the rest of a response.
 */
export function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") {
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Render a threshold for display.
 *
 * A manual threshold is a round number the user chose, but the kmeans and
 * gaussian methods derive one from the data, so it arrives as a full-precision
 * float -- a real run produced 0.5090393198284318. Printing that verbatim
 * implies a precision the number does not have and makes the surrounding line
 * unreadable.
 *
 * Rounding has to widen rather than collapse, though. The schema allows any
 * value in [0, 1], so a fixed 4 decimals would render 0.00001 as "0" and
 * 0.99999 as "1" while the counts beside it were still computed against the
 * real value -- a label that contradicts its own numbers. Add precision until
 * the result is distinguishable from the endpoints, and only print 0 or 1 when
 * that is genuinely the value.
 */
export function formatThreshold(threshold: number): string {
  if (!Number.isFinite(threshold)) return String(threshold);
  for (const digits of [4, 6, 8, 12]) {
    const rounded = Number(threshold.toFixed(digits));
    if (rounded === threshold) return String(rounded);
    if (rounded !== 0 && rounded !== 1) return String(rounded);
  }
  return String(threshold);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
