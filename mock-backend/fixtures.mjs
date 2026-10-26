/**
 * Seed data and simulated pipeline output for the mock backend.
 *
 * Shapes follow src/types.ts, which mirrors the real backend's response
 * schemas. Numbers are synthetic but internally consistent: counts add up,
 * the threshold separates the score populations the way the real detector's
 * would, and every derived summary is computed from the per-sample scores
 * rather than typed in.
 */
import { rng } from "./binary.mjs";

export const GB = 1024 ** 3;
export const STORAGE_CAP_BYTES = 5 * GB;
export const USER_QUOTA_BYTES = 1 * GB;

/** Demo accounts. Printed on startup; they exist only in this process's memory. */
export const USERS = [
  { id: 1, username: "demo-admin", email: "admin@demo.local", password: "demo-admin", role: "admin" },
  { id: 2, username: "demo-researcher", email: "researcher@demo.local", password: "demo-researcher", role: "registered" },
  { id: 3, username: "demo-guest", email: "guest@demo.local", password: "demo-guest", role: "guest" },
];

export const ATTACKS = [
  {
    id: "narcissus",
    name: "Narcissus (clean-label trigger optimisation)",
    supported_datasets: ["cifar10", "stl10", "tinyimagenet"],
    requires_source_class: false,
    requires_clean_model: false,
    requires_pregenerated_data: false,
    description: "Optimises a trigger from target-class samples only; poisons without flipping labels.",
  },
  {
    id: "lc",
    name: "Label-Consistent backdoor",
    supported_datasets: ["cifar10", "stl10"],
    requires_source_class: false,
    requires_clean_model: true,
    requires_pregenerated_data: false,
    description: "Adversarially perturbs target-class images so the trigger, not the content, is learned.",
  },
  {
    id: "sa",
    name: "Sleeper Agent (hidden-trigger gradient matching)",
    supported_datasets: ["cifar10"],
    requires_source_class: true,
    requires_clean_model: false,
    requires_pregenerated_data: true,
    description: "Gradient-matching poisons that implant a trigger only activated on source-class inputs.",
  },
  {
    id: "htb",
    name: "Hidden Trigger Backdoor",
    supported_datasets: ["cifar10", "tinyimagenet"],
    requires_source_class: true,
    requires_clean_model: false,
    requires_pregenerated_data: true,
    description: "Poisons look like clean target-class images; the trigger is revealed only at test time.",
  },
];

export const DEFAULT_CONFIG = {
  name: "Default configuration",
  dataset_id: null,
  clean_dataset_id: null,
  model_id: null,
  model_architecture: "resnet18",
  training_setting: "from_scratch",
  batch_size: 128,
  total_epochs: 40,
  batch_level_epochs: 10,
  batch_level_start_epoch: 0,
  sample_level_epochs: 10,
  sample_level_start_epoch: 10,
  threshold_method: "kmeans",
  poisoning_threshold: 0.5,
  phase_i_zscore: 2.0,
  phase_ii_feature_importance: 0.01,
  learning_rate: 0.1,
  optimizer: "SGD",
  momentum: 0.9,
  weight_decay: 0.0005,
  nesterov: true,
  lr_schedule: "multistep",
  lr_gamma: 0.1,
  target_class: 2,
  n_groups: 10,
  cv_model: "RandomForest",
  scoring_k: 5,
  confidence_threshold: 0.9,
  seed: 545,
  device: "cpu",
  num_workers: 2,
};

/** Clamp to [0, 1] with a little headroom so no score is exactly 0 or 1. */
const clamp01 = (v) => Math.min(0.999, Math.max(0.001, v));

/** Box-Muller normal draw from a uniform generator. */
function normal(rand, mean, std) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Which samples of a dataset carry the poison -- stable for a given seed. */
export function poisonedSet(seed, sampleCount, poisonRatio) {
  const rand = rng(seed);
  const set = new Set();
  const target = Math.round((sampleCount * (poisonRatio ?? 0)) / 100);
  while (set.size < target) set.add(Math.floor(rand() * sampleCount));
  return set;
}

/**
 * Pick a threshold the way each method would: fixed, a 2-means split, or a
 * Gaussian fit to the clean bulk. The fit uses median and MAD rather than mean
 * and std so the poisoned tail it is meant to catch doesn't widen it.
 */
function chooseThreshold(scores, method, manual) {
  if (method === "manual") return manual;
  const sorted = [...scores].sort((a, b) => a - b);
  const median = (xs) => xs[Math.floor(xs.length / 2)];
  if (method === "gaussian") {
    const m = median(sorted);
    const mad = median(sorted.map((s) => Math.abs(s - m)).sort((a, b) => a - b));
    return clamp01(m + 3 * 1.4826 * mad);
  }
  // kmeans with k=2 on a line: iterate the midpoint between the two centroids.
  let lo = sorted[0];
  let hi = sorted[sorted.length - 1];
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    const low = sorted.filter((s) => s < mid);
    const high = sorted.filter((s) => s >= mid);
    if (low.length === 0 || high.length === 0) break;
    lo = low.reduce((a, b) => a + b, 0) / low.length;
    hi = high.reduce((a, b) => a + b, 0) / high.length;
  }
  return (lo + hi) / 2;
}

/**
 * The results_json a completed run would persist: summary, per-sample scores
 * over the suspect set, important features, and run metadata.
 */
export function buildResults({ suspect, clean, config, runtimeSeconds, logTail }) {
  const seed = config.seed + suspect.id * 7919;
  const rand = rng(seed);
  const poisoned = poisonedSet(suspect._seed, suspect._sample_count, suspect.poison_ratio);

  const perSample = [];
  for (let i = 0; i < suspect._sample_count; i += 1) {
    const score = poisoned.has(i) ? normal(rand, 0.78, 0.1) : Math.abs(normal(rand, 0.12, 0.1));
    perSample.push({ sample_index: i, score: Number(clamp01(score).toFixed(6)) });
  }
  const scores = perSample.map((s) => s.score);
  const threshold = chooseThreshold(scores, config.threshold_method, config.poisoning_threshold);
  for (const s of perSample) s.predicted_poisoned = s.score >= threshold;

  const bins = new Array(10).fill(0);
  for (const s of scores) bins[Math.min(9, Math.floor(s * 10))] += 1;
  const poisonedCount = perSample.filter((s) => s.predicted_poisoned).length;
  const cleanCount = clean?._sample_count ?? 0;

  const featureCount = 12 + Math.floor(rand() * 20);
  const featureIndices = [...new Set(Array.from({ length: featureCount }, () => Math.floor(rand() * 512)))].sort(
    (a, b) => a - b
  );

  return {
    summary: {
      status: "completed",
      total_samples: scores.length + cleanCount,
      clean_count: cleanCount,
      suspect_count: scores.length,
      poisoned_count: poisonedCount,
      avg_score: Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(6)),
      score_distribution: bins,
      threshold,
    },
    important_features: { count: featureIndices.length, indices: featureIndices },
    total_scored_samples: scores.length,
    per_sample_scores: perSample,
    metadata: {
      runtime_seconds: runtimeSeconds,
      device: config.device,
      model_architecture: config.model_architecture,
      dataset_name: suspect.name,
      threshold_method: config.threshold_method,
      // The real backend reads these from a config snapshot that lacks them,
      // so they are always 0 there. Mirrored faithfully.
      batch_level_epochs: 0,
      sample_level_epochs: 0,
      log_tail: logTail,
    },
  };
}

/** Provenance rows for the two pipeline phases, as the real pipeline stores them. */
export function buildProvenance(results, config, phase) {
  if (phase === "batch_level") {
    return {
      provenance_type: "batch_level",
      data_json: JSON.stringify({
        epochs: config.batch_level_epochs,
        n_groups: config.n_groups,
        zscore_cutoff: config.phase_i_zscore,
        flagged_groups: [1, 4, 7].slice(0, Math.max(1, Math.round(config.n_groups / 4))),
      }),
      important_features: null,
    };
  }
  return {
    provenance_type: "sample_level",
    data_json: JSON.stringify({
      epochs: config.sample_level_epochs,
      cv_model: config.cv_model,
      scoring_k: config.scoring_k,
      feature_importance_cutoff: config.phase_ii_feature_importance,
    }),
    important_features: JSON.stringify(results.important_features.indices),
  };
}

/**
 * Seed rows, owned mostly by the admin so a single login shows a populated
 * dashboard, plus one pending upload from the researcher so the moderation
 * queue (and its uploader lookup) has something in it.
 */
export function seedRows(now) {
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const dataset = (row) => ({
    description: null,
    generation_status: null,
    generation_progress: null,
    generation_error: null,
    attack_type: null,
    base_dataset: null,
    poison_ratio: null,
    approval_status: "approved",
    approval_reason: null,
    reviewed_by: 1,
    reviewed_at: row.created_at,
    _seed: row.id * 31,
    ...row,
  });

  const datasets = [
    dataset({
      id: 1,
      name: "cifar10-clean-reference.npz",
      type: "dataset",
      file_size_bytes: 61_440_000,
      description: "Held-out clean CIFAR-10 subset used as the reference set.",
      uploaded_by: 1,
      created_at: ago(60 * 26),
      base_dataset: "cifar10",
      _sample_count: 400,
    }),
    dataset({
      id: 2,
      name: "cifar10-narcissus-10pct",
      type: "dataset",
      file_size_bytes: 92_160_000,
      description: "Narcissus clean-label poison, target class 2, 10% poison ratio.",
      uploaded_by: 1,
      created_at: ago(60 * 25),
      generation_status: "completed",
      generation_progress: 100,
      attack_type: "narcissus",
      base_dataset: "cifar10",
      poison_ratio: 10,
      _sample_count: 600,
    }),
    dataset({
      id: 3,
      name: "resnet18-cifar10-clean.pt",
      type: "model",
      file_size_bytes: 44_786_000,
      description: "Clean ResNet-18 checkpoint (required by the lc attack).",
      uploaded_by: 1,
      created_at: ago(60 * 24),
      _sample_count: 0,
    }),
    dataset({
      id: 4,
      name: "stl10-lc-5pct",
      type: "dataset",
      file_size_bytes: 133_120_000,
      description: "Label-consistent backdoor on STL-10, 5% poison ratio.",
      uploaded_by: 1,
      created_at: ago(60 * 3),
      generation_status: "completed",
      generation_progress: 100,
      attack_type: "lc",
      base_dataset: "stl10",
      poison_ratio: 5,
      _sample_count: 500,
    }),
    dataset({
      id: 5,
      name: "field-collected-batch-07.npz",
      type: "dataset",
      file_size_bytes: 18_432_000,
      description: "Uploaded by a researcher; awaiting moderation.",
      uploaded_by: 2,
      created_at: ago(45),
      approval_status: "pending",
      reviewed_by: null,
      reviewed_at: null,
      _sample_count: 120,
    }),
  ];

  const configurations = [
    {
      ...DEFAULT_CONFIG,
      id: 1,
      name: "Narcissus detection, kmeans threshold",
      created_by: 1,
      created_at: ago(60 * 24),
      updated_at: ago(60 * 24),
      dataset_id: 2,
      clean_dataset_id: 1,
      model_id: null,
      total_epochs: 20,
    },
    {
      ...DEFAULT_CONFIG,
      id: 2,
      name: "LC on STL-10, gaussian threshold",
      created_by: 1,
      created_at: ago(60 * 2),
      updated_at: ago(60 * 2),
      dataset_id: 4,
      clean_dataset_id: 1,
      model_id: 3,
      model_architecture: "resnet18-cifar10-clean.pt",
      threshold_method: "gaussian",
      total_epochs: 20,
    },
  ];

  return { datasets, configurations };
}
