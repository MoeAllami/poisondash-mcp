import { z } from "zod";
import { apiFetch } from "../client.js";
import { DEFAULT_CONCURRENCY, mapLimit } from "../concurrency.js";
import { safeJsonParse } from "../json.js";
import { registerTool, textResult } from "./registry.js";
import { parseResults, formatResultsSummary } from "./results-format.js";
import type {
  ExperimentListResponse,
  ExperimentLogsResponse,
  ExperimentResponse,
  ExperimentResultsResponse,
  ExperimentStatusResponse,
} from "../types.js";

registerTool({
  name: "create_experiment",
  description:
    "Create a new experiment bound to an existing configuration (the caller must own " +
    "the configuration, or be admin). Does not start the run -- call run_experiment " +
    "with the returned id next.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  schema: z.object({
    name: z.string().min(1),
    configuration_id: z.number().int(),
    description: z.string().optional(),
  }),
  handler: async (args) => {
    const exp = await apiFetch<ExperimentResponse>("/api/experiments", { method: "POST", body: args });
    return textResult(
      `Created experiment #${exp.id} "${exp.name}" (status: ${exp.status}). ` +
        `Call run_experiment({ experiment_id: ${exp.id} }) to start it.`
    );
  },
});

registerTool({
  name: "run_experiment",
  description:
    "Start (or restart) an experiment's detection pipeline in the background. Fails " +
    "with 409 if already running, or 400 if the linked configuration/dataset is " +
    "missing or was rejected by an admin. Poll get_experiment_status or " +
    "get_experiment_logs afterward -- this call returns as soon as the run is queued.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  schema: z.object({
    experiment_id: z.number().int(),
  }),
  handler: async (args) => {
    const { experiment_id } = args as { experiment_id: number };
    await apiFetch(`/api/experiments/${experiment_id}/run`, { method: "POST" });
    return textResult(
      `Pipeline started for experiment ${experiment_id}. ` +
        `Poll get_experiment_status({ experiment_id: ${experiment_id} }) for progress.`
    );
  },
});

registerTool({
  name: "cancel_experiment",
  description:
    "Cancel a running or pending experiment. If a background thread is actively " +
    "running, this only requests cancellation -- status reads 'cancelling' until it " +
    "finishes unwinding.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  schema: z.object({
    experiment_id: z.number().int(),
  }),
  handler: async (args) => {
    const { experiment_id } = args as { experiment_id: number };
    const result = await apiFetch<{ detail: string }>(`/api/experiments/${experiment_id}/cancel`, {
      method: "POST",
    });
    return textResult(result.detail);
  },
});

registerTool({
  name: "list_experiments",
  description:
    "List the caller's own experiments. There is no server-side status filter -- " +
    "fetch and filter by `status` client-side if needed (pending, running, cancelling, " +
    "completed, failed, cancelled).",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    limit: z.number().int().min(1).max(500).default(20),
    skip: z.number().int().min(0).default(0),
  }),
  handler: async (args) => {
    const { limit, skip } = args as { limit: number; skip: number };
    const data = await apiFetch<ExperimentListResponse>("/api/experiments", {
      query: { limit, skip },
    });
    if (data.experiments.length === 0) {
      return textResult(`No experiments found (total: ${data.total}).`);
    }
    const lines = [`Showing ${data.experiments.length} of ${data.total}:`];
    for (const e of data.experiments) {
      lines.push(
        `#${e.id} "${e.name}" -- ${e.status} (${e.progress}%) config=${e.configuration_id ?? "none"}` +
          (e.error_message ? ` error=${e.error_message}` : "")
      );
    }
    return textResult(lines.join("\n"));
  },
});

registerTool({
  name: "get_experiment_status",
  description: "Poll an experiment's run status and progress percentage.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    experiment_id: z.number().int(),
  }),
  handler: async (args) => {
    const { experiment_id } = args as { experiment_id: number };
    const s = await apiFetch<ExperimentStatusResponse>(`/api/experiments/${experiment_id}/status`);
    if (s.status === "failed") {
      return textResult(`Experiment ${s.id}: failed: ${s.error_message ?? "unknown error"}`);
    }
    return textResult(`Experiment ${s.id}: ${s.status} (${s.progress}%)`);
  },
});

registerTool({
  name: "get_experiment_logs",
  description:
    "Fetch new log lines for a running or finished experiment. Poll with `since` " +
    "(the cursor from the previous call's next_cursor) to get only new lines. Pass " +
    "`tail_lines` instead to fetch everything from the start and return just the " +
    "last N lines (a 'tail' view) -- this overrides `since`. After the in-memory log " +
    "buffer is evicted (5 minutes after the run finishes) this falls back to the " +
    "persisted log tail in the experiment's results, if any.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    experiment_id: z.number().int(),
    since: z.number().int().min(0).default(0).describe("Cursor from a previous call's next_cursor"),
    tail_lines: z.number().int().min(1).max(2000).optional().describe("Return only the last N lines"),
  }),
  handler: async (args) => {
    const { experiment_id, since, tail_lines } = args as {
      experiment_id: number;
      since: number;
      tail_lines?: number;
    };
    const effectiveSince = tail_lines !== undefined ? 0 : since;
    const data = await apiFetch<ExperimentLogsResponse>(`/api/experiments/${experiment_id}/logs`, {
      query: { since: effectiveSince },
    });

    let lines = data.lines;
    if (tail_lines !== undefined && lines.length > tail_lines) {
      lines = lines.slice(-tail_lines);
    }

    const header = `active=${data.active} complete=${data.complete} next_cursor=${data.next_cursor}`;
    if (lines.length === 0) {
      return textResult(`${header}\n(no new log lines)`);
    }
    const body = lines.map((l) => `[${l.stream}] ${l.text}`).join("\n");
    return textResult(`${header}\n\`\`\`\n${body}\n\`\`\``);
  },
});

registerTool({
  name: "get_experiment_results",
  description:
    "Get the detection results for a completed experiment: summary counts, average " +
    "poisoning score, score distribution, threshold, important features, and runtime. " +
    "Set include_per_sample_scores=true to also include the raw per-sample scores " +
    "(large -- displayed truncated for very large sets). Failed/cancelled runs may " +
    "return only a status stub with a log tail.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    experiment_id: z.number().int(),
    include_per_sample_scores: z.boolean().default(false),
  }),
  handler: async (args) => {
    const { experiment_id, include_per_sample_scores } = args as {
      experiment_id: number;
      include_per_sample_scores: boolean;
    };
    const data = await apiFetch<ExperimentResultsResponse>(`/api/experiments/${experiment_id}/results`);
    const parsed = parseResults(data.results_json);

    const lines = [`Experiment #${data.id} (status: ${data.status})`, "", ...formatResultsSummary(parsed)];

    if (include_per_sample_scores) {
      const scores = parsed.per_sample_scores ?? [];
      lines.push("");
      if (scores.length === 0) {
        lines.push("No per-sample scores available.");
      } else {
        const CAP = 200;
        const shown = scores.slice(0, CAP);
        lines.push(`Per-sample scores (${shown.length}${scores.length > CAP ? ` of ${scores.length}, truncated` : ""}):`);
        for (const s of shown) {
          lines.push(`  [${s.sample_index}] score=${s.score.toFixed(3)} poisoned=${s.predicted_poisoned}`);
        }
      }
    }

    return textResult(lines.join("\n"));
  },
});

registerTool({
  name: "get_provenance_records",
  description:
    "Get the pipeline-stage provenance trail for an experiment: batch-level feature " +
    "importance (phase I), sample-level dataset composition (phase II setup), and " +
    "scoring thresholds (phase II results). Summarizes the three pipeline stages.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    experiment_id: z.number().int(),
  }),
  handler: async (args) => {
    const { experiment_id } = args as { experiment_id: number };
    const data = await apiFetch<ExperimentResultsResponse>(`/api/experiments/${experiment_id}/results`);

    if (data.provenance_records.length === 0) {
      return textResult(`Experiment #${data.id}: no provenance records yet.`);
    }

    const lines = [`Experiment #${data.id} provenance (${data.provenance_records.length} records):`];
    for (const rec of data.provenance_records) {
      lines.push("");
      lines.push(`[${rec.provenance_type}] ${rec.created_at ?? ""}`);
      const parsedData = safeJsonParse<Record<string, unknown>>(rec.data_json, {});
      for (const [key, value] of Object.entries(parsedData)) {
        lines.push(`  ${key}: ${JSON.stringify(value)}`);
      }
      const feats = safeJsonParse<unknown[] | null>(rec.important_features, null);
      if (feats !== null) {
        lines.push(`  important_features: ${Array.isArray(feats) ? `${feats.length} indices` : "present"}`);
      }
    }

    return textResult(lines.join("\n"));
  },
});

registerTool({
  name: "compare_experiments",
  description:
    "Compare multiple experiments side by side: dataset name, threshold method, " +
    "threshold, detection rate, average score, and runtime. Fetches each experiment's " +
    "name and results in parallel. Attack type is not available from these endpoints " +
    "and is omitted (it can only be approximated via a best-effort dataset-name lookup).",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    experiment_ids: z.array(z.number().int()).min(2).max(20),
  }),
  handler: async (args) => {
    const { experiment_ids } = args as { experiment_ids: number[] };

    // Two requests per experiment, capped rather than fired all at once: 20 ids
    // would otherwise open 40 concurrent sockets against the backend.
    const rows = await mapLimit(
      experiment_ids,
      DEFAULT_CONCURRENCY,
      async (id) => {
        const [exp, results] = await Promise.all([
          apiFetch<ExperimentResponse>(`/api/experiments/${id}`),
          apiFetch<ExperimentResultsResponse>(`/api/experiments/${id}/results`),
        ]);
        const parsed = parseResults(results.results_json);
        return {
          id,
          name: exp.name,
          dataset: parsed.metadata?.dataset_name ?? "?",
          thresholdMethod: parsed.metadata?.threshold_method ?? "?",
          threshold: parsed.summary?.threshold,
          poisoned: parsed.summary?.poisoned_count,
          scored: parsed.total_scored_samples ?? parsed.summary?.suspect_count,
          avgScore: parsed.summary?.avg_score,
          runtime: parsed.metadata?.runtime_seconds,
        };
      }
    );

    const header = ["ID", "Name", "Dataset", "Method", "Threshold", "Detected/Scored", "Avg score", "Runtime(s)"];
    const lines = [header.join(" | ")];
    for (const r of rows) {
      const detected = r.poisoned !== undefined && r.scored !== undefined ? `${r.poisoned}/${r.scored}` : "?";
      lines.push(
        [
          `#${r.id}`,
          r.name,
          r.dataset,
          r.thresholdMethod,
          r.threshold?.toFixed(2) ?? "?",
          detected,
          r.avgScore?.toFixed(3) ?? "?",
          r.runtime?.toFixed(1) ?? "?",
        ].join(" | ")
      );
    }

    return textResult(lines.join("\n"));
  },
});
