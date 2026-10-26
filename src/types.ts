/**
 * TypeScript mirrors of the backend's Pydantic response schemas, verified
 * against the running PoisonDash API and its (private) schema and router
 * source. Kept intentionally loose on optional /
 * nullable fields to match `from_attributes=True` models that leave many
 * columns nullable.
 */

export interface DatasetResponse {
  id: number;
  name: string;
  type: "dataset" | "model" | string;
  file_size_bytes: number | null;
  description: string | null;
  uploaded_by: number;
  created_at: string | null;
  generation_status: string | null;
  generation_progress: number | null;
  generation_error: string | null;
  attack_type: string | null;
  base_dataset: string | null;
  poison_ratio: number | null;
  approval_status: string;
  approval_reason: string | null;
  reviewed_by: number | null;
  reviewed_at: string | null;
}

export interface DatasetListResponse {
  datasets: DatasetResponse[];
  total: number;
}

/** GET /api/datasets/storage/info. `used_bytes`/`cap_bytes` are
 * installation-wide; the `user_*` fields are the caller's own. */
export interface StorageInfoResponse {
  used_bytes: number;
  cap_bytes: number;
  remaining_bytes: number;
  user_used_bytes: number;
  user_quota_bytes: number;
  user_remaining_bytes: number;
}

export interface AnalysisSummary {
  status: string;
  clean_count: number;
  suspect_count: number;
  poisoned_count: number;
  total_samples: number;
  avg_score: number;
  score_distribution: number[];
  last_run: string | null;
}

export interface DashboardSummary {
  total_datasets: number;
  total_models: number;
  total_experiments: number;
  recent_datasets: DatasetResponse[];
  recent_experiments: ExperimentResponse[];
  storage_used_bytes: number;
  storage_cap_bytes: number;
  latest_analysis: AnalysisSummary | null;
}

export interface AttackInfo {
  id: string;
  name: string;
  supported_datasets: string[];
  requires_source_class: boolean;
  requires_clean_model: boolean;
  requires_pregenerated_data: boolean;
  description: string;
}

export interface ConfigurationResponse {
  id: number;
  created_by: number;
  created_at: string | null;
  updated_at: string | null;
  name: string;
  dataset_id: number | null;
  clean_dataset_id: number | null;
  model_id: number | null;
  dataset_name: string | null;
  clean_dataset_name: string | null;
  model_architecture: string | null;
  training_setting: string | null;
  batch_size: number;
  total_epochs: number;
  batch_level_epochs: number;
  batch_level_start_epoch: number;
  sample_level_epochs: number;
  sample_level_start_epoch: number;
  threshold_method: "manual" | "kmeans" | "gaussian";
  poisoning_threshold: number;
  phase_i_zscore: number;
  phase_ii_feature_importance: number;
  learning_rate: number;
  optimizer: "SGD" | "Adam" | "AdamW";
  momentum: number;
  weight_decay: number;
  nesterov: boolean;
  lr_schedule: string;
  lr_gamma: number;
  target_class: number;
  n_groups: number;
  cv_model: "RandomForest" | "LogisticRegression" | "SVM_Linear" | "SVM_RBF";
  scoring_k: number;
  confidence_threshold: number;
  seed: number;
  device: string;
  num_workers: number;
}

export interface GenerateDatasetResponse {
  id: number;
  name: string;
  generation_status: string | null;
  generation_progress: number | null;
  generation_error: string | null;
  attack_type: string | null;
  base_dataset: string | null;
  poison_ratio: number | null;
  file_size_bytes: number | null;
  created_at: string | null;
}

export interface GenerateStatusResponse {
  id: number;
  generation_status: string | null;
  generation_progress: number | null;
  generation_error: string | null;
}

export interface ConfigurationListResponse {
  configurations: ConfigurationResponse[];
  total: number;
}

export interface ExperimentResponse {
  id: number;
  name: string;
  description: string | null;
  configuration_id: number | null;
  config_json: string | null;
  status: string;
  progress: number;
  error_message: string | null;
  results_json: string | null;
  created_by: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface ExperimentListResponse {
  experiments: ExperimentResponse[];
  total: number;
}

export interface ExperimentStatusResponse {
  id: number;
  status: string;
  progress: number;
  error_message: string | null;
}

export interface LogLine {
  seq: number;
  ts: number;
  stream: string;
  text: string;
}

export interface ExperimentLogsResponse {
  lines: LogLine[];
  next_cursor: number;
  active: boolean;
  complete: boolean;
}

export interface ProvenanceResponse {
  id: number;
  experiment_id: number;
  provenance_type: string;
  data_json: string | null;
  important_features: string | null;
  created_at: string | null;
}

export interface ExperimentResultsResponse {
  id: number;
  status: string;
  results_json: string | null;
  provenance_records: ProvenanceResponse[];
}

/** Parsed shape of ExperimentResultsResponse.results_json. Every field is
 * treated as possibly-absent: failed/cancelled runs may carry only a stub
 * (summary.status + metadata.log_tail). */
export interface ResultsSummary {
  status?: string;
  total_samples?: number;
  clean_count?: number;
  suspect_count?: number;
  poisoned_count?: number;
  avg_score?: number;
  score_distribution?: number[];
  threshold?: number;
}

export interface PerSampleScore {
  sample_index: number;
  score: number;
  predicted_poisoned: boolean;
}

export interface ResultsMetadata {
  runtime_seconds?: number;
  device?: string;
  model_architecture?: string;
  dataset_name?: string;
  threshold_method?: string;
  // Populated from the experiment's config_json snapshot, which does not
  // include these two -- they read as 0 and are not meaningful. Use
  // get_configuration for the real epoch counts.
  batch_level_epochs?: number;
  sample_level_epochs?: number;
  log_tail?: string[];
}

export interface SampleImageResponse {
  image: string; // base64 PNG
  sample_index: number;
  width: number;
  height: number;
}

export interface RoleCounts {
  admin: number;
  registered: number;
  guest: number;
}

export interface DatasetStatusCounts {
  pending: number;
  approved: number;
  rejected: number;
}

export interface ExperimentStatusCounts {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface UserStorageRow {
  user_id: number;
  username: string;
  email: string;
  used_bytes: number;
  quota_bytes: number;
}

export interface ActivityEvent {
  timestamp: string;
  type: "user_signup" | "dataset_upload" | "experiment_completed";
  actor: string;
  detail: string;
}

export interface AdminStatsResponse {
  user_count: number;
  user_roles: RoleCounts;
  dataset_count: number;
  dataset_statuses: DatasetStatusCounts;
  experiment_count: number;
  experiment_statuses: ExperimentStatusCounts;
  storage_used_bytes: number;
  storage_cap_bytes: number;
  top_storage_users: UserStorageRow[];
  recent_activity: ActivityEvent[];
}

export interface AdminUserResponse {
  id: number;
  username: string;
  email: string;
  role: "guest" | "registered" | "admin";
  is_active: boolean;
  storage_used_bytes: number;
  storage_quota_bytes: number;
  created_at: string | null;
  deleted_at: string | null;
  purge_after: string | null;
  days_until_purge: number | null;
}

export interface ParsedResults {
  summary?: ResultsSummary;
  important_features?: { count?: number; indices?: number[] };
  total_scored_samples?: number;
  per_sample_scores?: PerSampleScore[];
  metadata?: ResultsMetadata;
}
