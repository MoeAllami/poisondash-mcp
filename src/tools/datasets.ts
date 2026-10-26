import { z } from "zod";
import { apiFetch } from "../client.js";
import { formatBytes } from "../json.js";
import { registerTool, textResult } from "./registry.js";
import type { DatasetListResponse, DatasetResponse } from "../types.js";

function formatDatasetRow(d: DatasetResponse): string {
  const parts = [`#${d.id} ${d.name} [${d.type}]`, d.approval_status];
  if (d.attack_type) parts.push(`attack=${d.attack_type}`);
  if (d.base_dataset) parts.push(`base=${d.base_dataset}`);
  if (d.poison_ratio !== null) parts.push(`poison_ratio=${d.poison_ratio}%`);
  parts.push(formatBytes(d.file_size_bytes));
  if (d.created_at) parts.push(d.created_at);
  return parts.join(" | ");
}

registerTool({
  name: "list_datasets",
  description:
    "List the caller's own datasets and/or models (uploaded or generated). " +
    "Per-user: only shows items the caller owns, with no server-side status " +
    "filter -- the owner sees all of their own items regardless of approval " +
    "state. Use type to filter to just 'dataset' or just 'model'.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    type: z.enum(["dataset", "model"]).optional().describe("Filter to datasets or models only"),
    limit: z.number().int().min(1).max(500).default(20),
    skip: z.number().int().min(0).default(0),
  }),
  handler: async (args) => {
    const { type, limit, skip } = args as { type?: "dataset" | "model"; limit: number; skip: number };
    const data = await apiFetch<DatasetListResponse>("/api/datasets", {
      query: { type, limit, skip },
    });

    if (data.datasets.length === 0) {
      return textResult(`No ${type ?? "datasets/models"} found (total: ${data.total}).`);
    }

    const lines = [`Showing ${data.datasets.length} of ${data.total}:`];
    for (const d of data.datasets) lines.push(formatDatasetRow(d));
    return textResult(lines.join("\n"));
  },
});

registerTool({
  name: "get_dataset",
  description:
    "Get full detail on a single dataset or model by ID: generation status/progress, " +
    "attack type, base dataset, poison ratio, and moderation (approval) state. " +
    "Note: the generation parameters used to create the dataset and its on-disk " +
    "file path are intentionally not exposed by the API -- no endpoint returns them.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    dataset_id: z.number().int().describe("The dataset/model ID"),
  }),
  handler: async (args) => {
    const { dataset_id } = args as { dataset_id: number };
    const d = await apiFetch<DatasetResponse>(`/api/datasets/${dataset_id}`);

    const lines = [
      `#${d.id} ${d.name} [${d.type}]`,
      `Approval: ${d.approval_status}${d.approval_reason ? ` (${d.approval_reason})` : ""}`,
      `Size: ${formatBytes(d.file_size_bytes)}`,
    ];
    if (d.description) lines.push(`Description: ${d.description}`);
    if (d.attack_type) lines.push(`Attack: ${d.attack_type}`);
    if (d.base_dataset) lines.push(`Base dataset: ${d.base_dataset}`);
    if (d.poison_ratio !== null) lines.push(`Poison ratio: ${d.poison_ratio}%`);
    if (d.generation_status) {
      lines.push(
        `Generation: ${d.generation_status}${
          d.generation_progress !== null ? ` (${d.generation_progress}%)` : ""
        }${d.generation_error ? ` -- error: ${d.generation_error}` : ""}`
      );
    }
    if (d.created_at) lines.push(`Created: ${d.created_at}`);

    return textResult(lines.join("\n"));
  },
});
