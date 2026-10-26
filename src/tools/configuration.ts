import { z } from "zod";
import { apiFetch } from "../client.js";
import { registerTool, textResult } from "./registry.js";
import { optionalDeviceField } from "./shared-schemas.js";
import type { ConfigurationListResponse, ConfigurationResponse } from "../types.js";

const THRESHOLD_METHODS = ["manual", "kmeans", "gaussian"] as const;
const OPTIMIZERS = ["SGD", "Adam", "AdamW"] as const;
const CV_MODELS = ["RandomForest", "LogisticRegression", "SVM_Linear", "SVM_RBF"] as const;

/**
 * Render a configuration in full.
 *
 * Every field the update tool accepts is printed. A partial view would be
 * worse than none: an agent can set momentum or weight_decay but would have no
 * way to read back what they currently are, so it could neither verify its own
 * write nor report the settings a run actually used.
 */
export function formatConfiguration(c: ConfigurationResponse): string {
  // Values are labelled with their exact API field names rather than prose, so
  // whatever an agent reads here it can pass straight back to
  // update_configuration without having to guess the mapping.
  const lines = [
    `#${c.id} "${c.name}"`,
    `Datasets: dataset_id=${c.dataset_id ?? "none"}${c.dataset_name ? ` (${c.dataset_name})` : ""}` +
      `, clean_dataset_id=${c.clean_dataset_id ?? "none"}${c.clean_dataset_name ? ` (${c.clean_dataset_name})` : ""}` +
      `, model_id=${c.model_id ?? "none"}${c.model_architecture ? ` (${c.model_architecture})` : ""}`,
    `Labels: model_architecture=${c.model_architecture ?? "none"}, training_setting=${c.training_setting ?? "none"}`,
    `Training: batch_size=${c.batch_size}, total_epochs=${c.total_epochs}, device=${c.device}, num_workers=${c.num_workers}, seed=${c.seed}`,
    `Optimizer: optimizer=${c.optimizer}, learning_rate=${c.learning_rate}, momentum=${c.momentum}, weight_decay=${c.weight_decay}, nesterov=${c.nesterov}`,
    `Schedule: lr_schedule=${c.lr_schedule}, lr_gamma=${c.lr_gamma}`,
    `Phase I (batch level): batch_level_epochs=${c.batch_level_epochs}, batch_level_start_epoch=${c.batch_level_start_epoch}, phase_i_zscore=${c.phase_i_zscore}`,
    `Phase II (sample level): sample_level_epochs=${c.sample_level_epochs}, sample_level_start_epoch=${c.sample_level_start_epoch}, phase_ii_feature_importance=${c.phase_ii_feature_importance}`,
    `Detection: threshold_method=${c.threshold_method}, poisoning_threshold=${c.poisoning_threshold}, target_class=${c.target_class}`,
    `Scoring: cv_model=${c.cv_model}, n_groups=${c.n_groups}, scoring_k=${c.scoring_k}, confidence_threshold=${c.confidence_threshold}`,
  ];
  if (c.dataset_id === null || c.clean_dataset_id === null) {
    lines.push(
      "WARNING: a runnable config needs BOTH dataset_id and clean_dataset_id set -- " +
        "running a pipeline without the clean dataset raises FileNotFoundError."
    );
  }
  return lines.join("\n");
}

registerTool({
  name: "get_default_configuration",
  description:
    "Get the built-in default pipeline configuration (id=0, a virtual template, not " +
    "a saved row). Use this to see PoisonDash's default hyperparameters before " +
    "creating a real configuration.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({}),
  handler: async () => {
    const c = await apiFetch<ConfigurationResponse>("/api/config/defaults");
    return textResult(formatConfiguration(c));
  },
});

registerTool({
  name: "get_configuration",
  description:
    "Get a single saved pipeline configuration by ID, including the batch-level and " +
    "sample-level epoch counts that experiment results do not carry. This is the " +
    "source of truth for an experiment's real hyperparameters: take configuration_id " +
    "from list_experiments and look it up here.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    config_id: z.number().int().min(0).describe("Configuration ID (0 returns the built-in defaults)"),
  }),
  handler: async (args) => {
    const { config_id } = args as { config_id: number };
    // Id 0 is the virtual defaults template, not a stored row: GET
    // /api/config/0 looks for a row with that id and 404s. The defaults live
    // on their own route, so honour the documented id here rather than
    // handing the caller a confusing "Configuration not found".
    const endpoint = config_id === 0 ? "/api/config/defaults" : `/api/config/${config_id}`;
    const c = await apiFetch<ConfigurationResponse>(endpoint);
    return textResult(formatConfiguration(c));
  },
});

registerTool({
  name: "list_configurations",
  description: "List the caller's own saved pipeline configurations.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    limit: z.number().int().min(1).max(500).default(20),
    skip: z.number().int().min(0).default(0),
  }),
  handler: async (args) => {
    const { limit, skip } = args as { limit: number; skip: number };
    const data = await apiFetch<ConfigurationListResponse>("/api/config", {
      query: { limit, skip },
    });
    if (data.configurations.length === 0) {
      return textResult(`No configurations found (total: ${data.total}).`);
    }
    const lines = [`Showing ${data.configurations.length} of ${data.total}:`, ""];
    for (const c of data.configurations) {
      lines.push(formatConfiguration(c));
      lines.push("");
    }
    return textResult(lines.join("\n").trimEnd());
  },
});

registerTool({
  name: "create_configuration",
  description:
    "Create a new pipeline configuration. Any field you omit takes the backend's own " +
    "default (see get_default_configuration). A runnable configuration needs BOTH " +
    "dataset_id (the suspect dataset) and clean_dataset_id (the clean reference set) " +
    "-- running a pipeline without the clean dataset raises FileNotFoundError. " +
    "dataset_id/clean_dataset_id/model_id must reference datasets or models the " +
    "caller owns (admins can reference anyone's), and a rejected dataset cannot be used.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  // Every field is optional with no client-side default: the backend already
  // defines a default for each one, and duplicating those values here would
  // pin them silently the moment the backend's change.
  schema: z.object({
    name: z.string().min(1).max(200).optional(),
    dataset_id: z.number().int().min(1).optional().describe("Suspect dataset ID"),
    clean_dataset_id: z.number().int().min(1).optional().describe("Clean reference dataset ID"),
    model_id: z.number().int().min(1).optional(),
    model_architecture: z.string().max(200).optional()
      .describe("Free-text architecture label. Overwritten by the linked model's name when model_id is set."),
    training_setting: z.string().max(200).optional().describe("Free-text training-setting label"),
    batch_size: z.number().int().min(1).max(8192).optional(),
    total_epochs: z.number().int().min(1).max(10000).optional(),
    batch_level_epochs: z.number().int().min(0).max(10000).optional(),
    batch_level_start_epoch: z.number().int().min(0).max(10000).optional(),
    sample_level_epochs: z.number().int().min(0).max(10000).optional(),
    sample_level_start_epoch: z.number().int().min(0).max(10000).optional(),
    threshold_method: z.enum(THRESHOLD_METHODS).optional(),
    poisoning_threshold: z.number().min(0).max(1).optional(),
    phase_i_zscore: z.number().min(0).max(100).optional(),
    phase_ii_feature_importance: z.number().min(0).max(1).optional(),
    learning_rate: z.number().gt(0).max(10).optional(),
    optimizer: z.enum(OPTIMIZERS).optional(),
    momentum: z.number().min(0).max(1).optional(),
    weight_decay: z.number().min(0).max(1).optional(),
    nesterov: z.boolean().optional(),
    lr_schedule: z.string().max(200).optional().describe("Comma-separated epoch milestones"),
    lr_gamma: z.number().gt(0).max(1).optional(),
    target_class: z.number().int().min(0).max(10000).optional(),
    n_groups: z.number().int().min(2).max(1000).optional(),
    cv_model: z.enum(CV_MODELS).optional(),
    scoring_k: z.number().int().min(1).max(100000).optional(),
    confidence_threshold: z.number().min(0).max(1).optional(),
    seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
    device: optionalDeviceField(),
    num_workers: z.number().int().min(0).max(64).optional(),
  }),
  handler: async (args) => {
    const c = await apiFetch<ConfigurationResponse>("/api/config", { method: "POST", body: args });
    return textResult(`Created configuration:\n${formatConfiguration(c)}`);
  },
});

registerTool({
  name: "update_configuration",
  description:
    "Update fields on an existing configuration. Only the fields you pass are sent to " +
    "the API and changed -- omitted fields keep their current value (the backend uses " +
    "exclude_unset semantics). Do not pass a field just to keep it the same. Pass null " +
    "for dataset_id, clean_dataset_id, or model_id to detach that reference.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  schema: z.object({
    config_id: z.number().int(),
    name: z.string().min(1).max(200).optional(),
    // Nullable so a reference can be cleared: the backend's update schema
    // accepts None for all three, and there is no other way to detach one.
    dataset_id: z.number().int().min(1).nullable().optional(),
    clean_dataset_id: z.number().int().min(1).nullable().optional(),
    model_id: z.number().int().min(1).nullable().optional(),
    model_architecture: z.string().max(200).nullable().optional(),
    training_setting: z.string().max(200).nullable().optional(),
    batch_size: z.number().int().min(1).max(8192).optional(),
    total_epochs: z.number().int().min(1).max(10000).optional(),
    batch_level_epochs: z.number().int().min(0).max(10000).optional(),
    batch_level_start_epoch: z.number().int().min(0).max(10000).optional(),
    sample_level_epochs: z.number().int().min(0).max(10000).optional(),
    sample_level_start_epoch: z.number().int().min(0).max(10000).optional(),
    threshold_method: z.enum(THRESHOLD_METHODS).optional(),
    poisoning_threshold: z.number().min(0).max(1).optional(),
    phase_i_zscore: z.number().min(0).max(100).optional(),
    phase_ii_feature_importance: z.number().min(0).max(1).optional(),
    learning_rate: z.number().gt(0).max(10).optional(),
    optimizer: z.enum(OPTIMIZERS).optional(),
    momentum: z.number().min(0).max(1).optional(),
    weight_decay: z.number().min(0).max(1).optional(),
    nesterov: z.boolean().optional(),
    lr_schedule: z.string().max(200).optional(),
    lr_gamma: z.number().gt(0).max(1).optional(),
    target_class: z.number().int().min(0).max(10000).optional(),
    n_groups: z.number().int().min(2).max(1000).optional(),
    cv_model: z.enum(CV_MODELS).optional(),
    scoring_k: z.number().int().min(1).max(100000).optional(),
    confidence_threshold: z.number().min(0).max(1).optional(),
    seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
    device: optionalDeviceField(),
    num_workers: z.number().int().min(0).max(64).optional(),
  }),
  handler: async (args) => {
    const { config_id, ...fields } = args as { config_id: number } & Record<string, unknown>;
    // Zod leaves unset optional fields as `undefined`; JSON.stringify drops
    // undefined-valued keys, so only explicitly-passed fields reach the API --
    // matching the backend's exclude_unset PUT semantics. An explicit null
    // survives that serialization and clears the field.
    const c = await apiFetch<ConfigurationResponse>(`/api/config/${config_id}`, {
      method: "PUT",
      body: fields,
    });
    return textResult(`Updated configuration:\n${formatConfiguration(c)}`);
  },
});
