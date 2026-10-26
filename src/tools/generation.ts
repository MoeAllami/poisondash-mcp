import { z } from "zod";
import { apiFetch } from "../client.js";
import { registerTool, textResult } from "./registry.js";
import { deviceField } from "./shared-schemas.js";
import type { GenerateDatasetResponse, GenerateStatusResponse } from "../types.js";

registerTool({
  name: "start_generation",
  description:
    "Start generating a poisoned dataset with one of the 4 attacks (see " +
    "list_available_attacks). Runs as a background job -- poll get_generation_status " +
    "with the returned dataset id. Constraints (enforced server-side): 'lc' requires " +
    "clean_model_id (an uploaded model checkpoint); 'sa' and 'htb' require " +
    "source_class AND pre-generated .npy files already present on disk -- generation " +
    "fails at runtime without them. Each attack only supports specific base_dataset " +
    "values (see list_available_attacks).",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  schema: z.object({
    name: z.string().min(1).max(200),
    attack_type: z.enum(["lc", "narcissus", "sa", "htb"]),
    base_dataset: z.enum(["cifar10", "stl10", "tinyimagenet"]).default("cifar10"),
    poison_ratio: z.number().gt(0).max(100).default(10.0).describe("Percent of samples to poison"),
    target_class: z.number().int().min(0).max(10000).default(2),
    source_class: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe("Required for sa and htb"),
    clean_model_id: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Dataset-table ID of an uploaded clean model checkpoint. Required for lc only."),
    eps: z.number().int().min(1).max(255).default(8),
    vis: z.number().int().min(0).max(255).default(255),
    model_architecture: z
      .enum(["resnet18", "resnet34", "custom_cnn", "custom_resnet18"])
      .default("resnet18"),
    device: deviceField("cpu"),
    seed: z.number().int().min(0).max(2 ** 31 - 1).default(545),
    description: z.string().max(2000).optional(),
  }),
  handler: async (args) => {
    const dataset = await apiFetch<GenerateDatasetResponse>("/api/generate", {
      method: "POST",
      body: args,
    });
    return textResult(
      `Generation started: dataset #${dataset.id} "${dataset.name}" (status: ${dataset.generation_status}).\n` +
        `Poll with get_generation_status({ dataset_id: ${dataset.id} }).`
    );
  },
});

registerTool({
  name: "get_generation_status",
  description: "Poll the progress of a dataset generation job started with start_generation.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    dataset_id: z.number().int(),
  }),
  handler: async (args) => {
    const { dataset_id } = args as { dataset_id: number };
    const s = await apiFetch<GenerateStatusResponse>(`/api/generate/${dataset_id}/status`);
    if (s.generation_error) {
      return textResult(
        `Dataset ${s.id}: ${s.generation_status} (${s.generation_progress ?? 0}%) -- ${s.generation_error}`
      );
    }
    return textResult(`Dataset ${s.id}: ${s.generation_status} (${s.generation_progress ?? 0}%)`);
  },
});

registerTool({
  name: "cancel_generation",
  description:
    "Cancel an in-progress (or pending) dataset generation job. If a background thread is " +
    "actively running, this only requests cancellation -- the status will read " +
    "'cancelling' until it finishes unwinding.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  schema: z.object({
    dataset_id: z.number().int(),
  }),
  handler: async (args) => {
    const { dataset_id } = args as { dataset_id: number };
    const result = await apiFetch<{ detail: string }>(`/api/generate/${dataset_id}/cancel`, {
      method: "POST",
    });
    return textResult(result.detail);
  },
});
