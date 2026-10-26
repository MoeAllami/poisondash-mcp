import { formatThreshold, safeJsonParse } from "../json.js";
import type { ParsedResults } from "../types.js";

/** Parse an experiment's results_json string, tolerating missing/partial/stub shapes. */
export function parseResults(resultsJson: string | null | undefined): ParsedResults {
  return safeJsonParse<ParsedResults>(resultsJson, {});
}

/**
 * Render the compact, human-readable results summary used by
 * get_experiment_results and (minus per-sample detail) compare_experiments.
 *
 * Detection is reported purely as poisoning scores and threshold-based
 * counts -- the pipeline does not retain per-sample ground-truth labels, so
 * precision/recall is out of scope. batch_level_epochs/sample_level_epochs
 * in metadata are known to read as 0 (not populated in the config_json
 * snapshot taken at experiment-create time) and are deliberately omitted
 * here; get_configuration is the source of truth for real epoch counts.
 */
export function formatResultsSummary(parsed: ParsedResults): string[] {
  const lines: string[] = [];
  const summary = parsed.summary;

  if (!summary) {
    lines.push("No results summary available yet.");
    if (parsed.metadata?.log_tail && parsed.metadata.log_tail.length > 0) {
      lines.push("Log tail:");
      for (const l of parsed.metadata.log_tail) lines.push(`  ${l}`);
    }
    return lines;
  }

  lines.push(`Status: ${summary.status ?? "unknown"}`);

  const scored = parsed.total_scored_samples ?? summary.suspect_count;
  if (scored !== undefined) {
    const cleanNote =
      summary.clean_count !== undefined ? ` (clean reference set: ${summary.clean_count})` : "";
    lines.push(`Scored suspect samples: ${scored}${cleanNote}`);
  }

  if (summary.poisoned_count !== undefined && scored !== undefined && scored > 0) {
    const rate = ((summary.poisoned_count / scored) * 100).toFixed(1);
    const thresholdNote = summary.threshold !== undefined ? ` (score >= threshold)` : "";
    lines.push(
      `Predicted poisoned${thresholdNote}: ${summary.poisoned_count} / ${scored} (detection rate ${rate}%)`
    );
  }

  if (summary.avg_score !== undefined) {
    lines.push(`Avg poisoning score: ${summary.avg_score.toFixed(3)}`);
  }

  if (summary.score_distribution && summary.score_distribution.length > 0) {
    lines.push(`Score distribution (0->1, ${summary.score_distribution.length} bins): [${summary.score_distribution.join(", ")}]`);
  }

  const methodParts: string[] = [];
  if (parsed.metadata?.threshold_method) methodParts.push(`Threshold method: ${parsed.metadata.threshold_method}`);
  if (summary.threshold !== undefined) methodParts.push(`Threshold: ${formatThreshold(summary.threshold)}`);
  if (methodParts.length > 0) lines.push(methodParts.join(" | "));

  if (parsed.important_features?.count !== undefined) {
    lines.push(`Important features: ${parsed.important_features.count} identified`);
  }

  if (parsed.metadata?.runtime_seconds !== undefined) {
    const device = parsed.metadata.device ? ` on ${parsed.metadata.device}` : "";
    lines.push(`Runtime: ${parsed.metadata.runtime_seconds.toFixed(1)}s${device}`);
  }

  if ((summary.status === "failed" || summary.status === "cancelled") && parsed.metadata?.log_tail?.length) {
    lines.push("");
    lines.push("Log tail:");
    for (const l of parsed.metadata.log_tail) lines.push(`  ${l}`);
  }

  return lines;
}
