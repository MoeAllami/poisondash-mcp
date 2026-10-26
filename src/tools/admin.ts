import { z } from "zod";
import { apiFetch } from "../client.js";
import { config } from "../config.js";
import { DEFAULT_CONCURRENCY, mapLimit } from "../concurrency.js";
import { formatBytes } from "../json.js";
import { registerTool, textResult } from "./registry.js";
import type {
  AdminStatsResponse,
  AdminUserResponse,
  DatasetListResponse,
  DatasetResponse,
} from "../types.js";

/**
 * Registered only if POISONDASH_ADMIN=true -- this gate only controls tool
 * *visibility* in tools/list. Real authority always comes from the logged-in
 * user's role: even with this flag on, a non-admin token gets a 403 from
 * every endpoint these tools call.
 */
const adminGate = { enabled: () => config.adminToolsEnabled };

registerTool({
  name: "list_pending_datasets",
  description:
    "[Admin] List datasets awaiting moderation across all users. Uploader is shown by " +
    "username where a lookup succeeds, otherwise by user id with the lookup failure " +
    "noted. Act on the queue with approve_dataset / reject_dataset.",
  ...adminGate,
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    limit: z.number().int().min(1).max(500).default(50),
    skip: z.number().int().min(0).default(0),
  }),
  handler: async (args) => {
    const { limit, skip } = args as { limit: number; skip: number };
    const data = await apiFetch<DatasetListResponse>("/api/admin/datasets", {
      query: { status: "pending", limit, skip },
    });

    if (data.datasets.length === 0) {
      return textResult(`No pending datasets (total: ${data.total}).`);
    }

    // One lookup per distinct uploader, capped: with limit=500 an unbounded
    // fan-out would open 500 sockets against a single-process dev backend.
    const uploaderIds = [...new Set(data.datasets.map((d) => d.uploaded_by))];
    const uploaderNames = new Map<number, string>();
    let lookupFailures = 0;
    await mapLimit(uploaderIds, DEFAULT_CONCURRENCY, async (id) => {
      try {
        const user = await apiFetch<AdminUserResponse>(`/api/admin/users/${id}`);
        uploaderNames.set(id, user.username);
      } catch {
        // A lookup failure (e.g. a purged user) shouldn't break the listing,
        // but it is counted so the caller knows a name is missing rather than
        // assuming the raw id is all the API had.
        lookupFailures += 1;
      }
    });

    const lines = [`Showing ${data.datasets.length} of ${data.total} pending:`];
    for (const d of data.datasets) {
      const uploader = uploaderNames.get(d.uploaded_by) ?? `user#${d.uploaded_by}`;
      lines.push(
        `#${d.id} ${d.name} -- uploaded by ${uploader}, ${formatBytes(d.file_size_bytes)}${
          d.created_at ? `, ${d.created_at}` : ""
        }`
      );
    }
    if (lookupFailures > 0) {
      lines.push("");
      lines.push(
        `Note: ${lookupFailures} uploader lookup(s) failed; those rows show a raw user id.`
      );
    }
    return textResult(lines.join("\n"));
  },
});

function formatDecision(d: DatasetResponse): string {
  return [
    `#${d.id} ${d.name} [${d.type}]`,
    `Approval: ${d.approval_status}${d.approval_reason ? ` (${d.approval_reason})` : ""}`,
    `Uploaded by: user#${d.uploaded_by}`,
  ].join("\n");
}

registerTool({
  name: "approve_dataset",
  description:
    "[Admin] Approve a pending dataset so it can be referenced by configurations and " +
    "pipeline runs. Safe to call on an already-approved dataset.",
  ...adminGate,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  schema: z.object({
    dataset_id: z.number().int(),
    reason: z.string().max(2000).optional().describe("Optional note stored with the decision"),
  }),
  handler: async (args) => {
    const { dataset_id, reason } = args as { dataset_id: number; reason?: string };
    const d = await apiFetch<DatasetResponse>(`/api/admin/datasets/${dataset_id}/approve`, {
      method: "POST",
      body: { reason: reason ?? null },
    });
    return textResult(`Approved:\n${formatDecision(d)}`);
  },
});

registerTool({
  name: "reject_dataset",
  description:
    "[Admin] Reject a dataset, taking it out of circulation. Rejection is enforced at " +
    "run time as well as at configuration time, so experiments whose configuration " +
    "already references this dataset will fail to start afterwards.",
  ...adminGate,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  schema: z.object({
    dataset_id: z.number().int(),
    reason: z.string().max(2000).optional().describe("Why it was rejected; shown to the uploader"),
  }),
  handler: async (args) => {
    const { dataset_id, reason } = args as { dataset_id: number; reason?: string };
    const d = await apiFetch<DatasetResponse>(`/api/admin/datasets/${dataset_id}/reject`, {
      method: "POST",
      body: { reason: reason ?? null },
    });
    return textResult(`Rejected:\n${formatDecision(d)}`);
  },
});

registerTool({
  name: "get_system_stats",
  description:
    "[Admin] System-wide usage stats: user counts by role, dataset/experiment counts " +
    "by status, total storage usage, top storage users, and a recent activity feed " +
    "(signups, uploads, completed experiments). This is the only source of state " +
    "across all users -- get_dashboard_summary is scoped to the caller only.",
  ...adminGate,
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({}),
  handler: async () => {
    const s = await apiFetch<AdminStatsResponse>("/api/admin/stats");

    const lines = [
      `Users: ${s.user_count} (admin=${s.user_roles.admin}, registered=${s.user_roles.registered}, guest=${s.user_roles.guest})`,
      `Datasets: ${s.dataset_count} (pending=${s.dataset_statuses.pending}, approved=${s.dataset_statuses.approved}, rejected=${s.dataset_statuses.rejected})`,
      `Experiments: ${s.experiment_count} (pending=${s.experiment_statuses.pending}, running=${s.experiment_statuses.running}, completed=${s.experiment_statuses.completed}, failed=${s.experiment_statuses.failed}, cancelled=${s.experiment_statuses.cancelled})`,
      `Storage: ${formatBytes(s.storage_used_bytes)} / ${formatBytes(s.storage_cap_bytes)}`,
    ];

    if (s.top_storage_users.length > 0) {
      lines.push("");
      lines.push("Top storage users:");
      for (const u of s.top_storage_users) {
        lines.push(`  ${u.username} (${u.email}): ${formatBytes(u.used_bytes)} / ${formatBytes(u.quota_bytes)}`);
      }
    }

    if (s.recent_activity.length > 0) {
      lines.push("");
      lines.push("Recent activity:");
      for (const e of s.recent_activity.slice(0, 20)) {
        lines.push(`  [${e.timestamp}] ${e.type} -- ${e.actor}: ${e.detail}`);
      }
    }

    return textResult(lines.join("\n"));
  },
});
