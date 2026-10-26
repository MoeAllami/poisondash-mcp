import { z } from "zod";
import { apiFetch } from "../client.js";
import { registerTool, textResult } from "./registry.js";
import type { AttackInfo } from "../types.js";

/**
 * Client-supplied parameter documentation. The backend's GET /api/generate/attacks
 * only returns per-attack metadata (supported datasets, required fields) with no
 * per-parameter descriptions, so this dictionary is hardcoded here and clearly
 * labeled as client-side documentation, not part of the API response.
 */
const PARAM_DOCS: Record<string, string> = {
  name: "Display name for the generated dataset (start_generation request).",
  base_dataset: "Source dataset to poison: cifar10, stl10, or tinyimagenet.",
  attack_type: "Which poisoning attack to run: lc, narcissus, sa, or htb.",
  poison_ratio: "Percentage (0-100] of samples to poison.",
  target_class: "Class label the attack tries to make the model predict for triggered inputs.",
  source_class: "Class the trigger is drawn from. REQUIRED for sa and htb.",
  clean_model_id: "Dataset-table ID of an uploaded clean model checkpoint. REQUIRED for lc only.",
  eps: "Perturbation budget (L-infinity, 1-255) for the adversarial/trigger perturbation.",
  vis: "Trigger visibility/blend strength (0-255).",
  model_architecture: "Architecture used if a model needs to be trained during generation: resnet18, resnet34, custom_cnn, or custom_resnet18.",
  device: "cpu, cuda, or cuda:N -- where generation runs.",
  seed: "Random seed for reproducibility.",
  description: "Free-text notes stored with the dataset.",
};

registerTool({
  name: "list_available_attacks",
  description:
    "List the poisoning attacks PoisonDash can generate (lc, narcissus, sa, htb), " +
    "with which base datasets each supports and which extra parameters each requires. " +
    "Optionally filter to attacks that support a specific base_dataset. Parameter " +
    "descriptions are client-supplied documentation, not part of the API response.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    base_dataset: z
      .enum(["cifar10", "stl10", "tinyimagenet"])
      .optional()
      .describe("Only list attacks that support this base dataset"),
  }),
  handler: async (args) => {
    const { base_dataset } = args as { base_dataset?: string };
    const attacks = await apiFetch<AttackInfo[]>("/api/generate/attacks");

    const filtered = base_dataset
      ? attacks.filter((a) => a.supported_datasets.includes(base_dataset))
      : attacks;

    if (filtered.length === 0) {
      return textResult(`No attacks support base_dataset=${base_dataset}.`);
    }

    const lines: string[] = [];
    for (const a of filtered) {
      lines.push(`${a.id} -- ${a.name}`);
      lines.push(`  Supported datasets: ${a.supported_datasets.join(", ")}`);
      const requirements: string[] = [];
      if (a.requires_source_class) requirements.push("source_class");
      if (a.requires_clean_model) requirements.push("clean_model_id");
      if (a.requires_pregenerated_data)
        requirements.push("pre-generated .npy files must already exist on disk");
      lines.push(`  Requires: ${requirements.length > 0 ? requirements.join(", ") : "none extra"}`);
      lines.push(`  ${a.description}`);
      lines.push("");
    }

    lines.push("Parameter reference (client-supplied, not from the API):");
    for (const [key, doc] of Object.entries(PARAM_DOCS)) {
      lines.push(`  ${key}: ${doc}`);
    }

    return textResult(lines.join("\n"));
  },
});
