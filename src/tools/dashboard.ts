import { z } from "zod";
import { apiFetch } from "../client.js";
import { formatBytes } from "../json.js";
import { registerTool, textResult } from "./registry.js";
import type { DashboardSummary, StorageInfoResponse } from "../types.js";

registerTool({
  name: "get_dashboard_summary",
  description:
    "Get the calling user's dashboard: counts of their datasets/models/experiments, " +
    "their 5 most recent datasets and experiments, storage usage, and the latest " +
    "analysis from their most recent completed/running experiment. Counts and recent " +
    "items are scoped to the logged-in user even for admins; storage is reported both " +
    "per-user (against the caller's quota) and installation-wide (against the system " +
    "cap). For system-wide state across all users, use get_system_stats (admin only).",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({}),
  handler: async () => {
    // /api/dashboard/summary reports storage_used_bytes from the global
    // get_storage_usage(), i.e. every user's data, so it cannot answer "how
    // much have I used". /api/datasets/storage/info carries both figures.
    const [data, storage] = await Promise.all([
      apiFetch<DashboardSummary>("/api/dashboard/summary"),
      apiFetch<StorageInfoResponse>("/api/datasets/storage/info"),
    ]);

    const lines: string[] = [];
    lines.push(
      `Datasets: ${data.total_datasets} | Models: ${data.total_models} | Experiments: ${data.total_experiments}`
    );
    lines.push(
      `Your storage: ${formatBytes(storage.user_used_bytes)} / ${formatBytes(storage.user_quota_bytes)}`
    );
    lines.push(
      `Installation storage (all users): ${formatBytes(storage.used_bytes)} / ${formatBytes(storage.cap_bytes)}`
    );

    if (data.latest_analysis) {
      const a = data.latest_analysis;
      lines.push("");
      lines.push(`Latest analysis (${a.status}):`);
      // summary.total_samples is suspect_count + clean_count, so the suspect
      // set -- the only thing that gets scored -- is suspect_count.
      const rate =
        a.suspect_count > 0 ? ` (detection rate ${((a.poisoned_count / a.suspect_count) * 100).toFixed(1)}%)` : "";
      lines.push(
        `  Poisoned: ${a.poisoned_count}/${a.suspect_count} suspect samples${rate}`
      );
      lines.push(`  Clean reference set: ${a.clean_count}`);
      lines.push(`  Avg score: ${a.avg_score.toFixed(3)}`);
      if (a.last_run) lines.push(`  Last run: ${a.last_run}`);
    } else {
      lines.push("");
      lines.push("No completed/running analysis yet.");
    }

    if (data.recent_datasets.length > 0) {
      lines.push("");
      lines.push("Recent datasets/models:");
      for (const d of data.recent_datasets) {
        lines.push(`  #${d.id} ${d.name} (${d.type}, ${d.approval_status})`);
      }
    }

    if (data.recent_experiments.length > 0) {
      lines.push("");
      lines.push("Recent experiments:");
      for (const e of data.recent_experiments) {
        lines.push(`  #${e.id} ${e.name} (${e.status})`);
      }
    }

    return textResult(lines.join("\n"));
  },
});
