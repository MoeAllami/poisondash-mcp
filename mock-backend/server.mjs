#!/usr/bin/env node
/**
 * In-memory mock of the PoisonDash FastAPI backend.
 *
 * The real backend is private research infrastructure (GPU training jobs, a
 * database, uploaded datasets), so this stands in for it well enough to run
 * the MCP server end to end: every route the tools call, FastAPI-shaped
 * `{"detail": ...}` errors, bearer-token auth with expiry, role checks, and
 * background generation/experiment jobs that progress on timers, log, and
 * honour cancellation. State lives in this process and resets on restart.
 *
 *   node mock-backend/server.mjs        # listens on MOCK_PORT (default 8321)
 *
 * MOCK_PORT, MOCK_HOST (default 127.0.0.1), MOCK_JOB_MS (simulated experiment
 * duration, default 8000), MOCK_TOKEN_TTL_S (token lifetime, default 3600 --
 * set it low to watch the MCP server's silent re-login).
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodePng, makeNpz, npzSampleCount, sampleRgb } from "./binary.mjs";
import {
  ATTACKS,
  DEFAULT_CONFIG,
  STORAGE_CAP_BYTES,
  USERS,
  USER_QUOTA_BYTES,
  buildProvenance,
  buildResults,
  poisonedSet,
  seedRows,
} from "./fixtures.mjs";

const ROLE_RANK = { guest: 0, registered: 1, admin: 2 };

class HttpError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}

const notFound = (what) => new HttpError(404, `${what} not found`);

/** A FastAPI-style 422 body for one bad field. */
const invalid = (field, msg) =>
  new HttpError(422, [{ loc: ["body", field], msg, type: "value_error" }]);

export function createMockBackend({ jobMs = 8000, tokenTtlSeconds = 3600 } = {}) {
  const now = () => new Date().toISOString();
  const { datasets, configurations } = seedRows(Date.now());

  const state = {
    users: USERS.map((u) => ({ ...u, is_active: true, created_at: new Date(Date.now() - 86_400_000 * 30).toISOString() })),
    datasets: new Map(datasets.map((d) => [d.id, d])),
    configurations: new Map(configurations.map((c) => [c.id, c])),
    experiments: new Map(),
    provenance: [],
    tokens: new Map(),
    jobs: new Map(), // experiment id -> { timer, cancelRequested, logs, startedAt }
    genJobs: new Map(), // dataset id -> { timer, cancelRequested }
    activity: [],
    nextId: { dataset: 100, config: 100, experiment: 100, provenance: 100 },
  };

  // ---------------------------------------------------------------------------
  // Seeded experiments: two completed runs and one failure stub, so results,
  // comparison, and the stub-tolerant paths all have something to show.
  // ---------------------------------------------------------------------------

  function seedExperiment(id, name, configId, status, minutesAgo) {
    const config = state.configurations.get(configId);
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    let results = null;
    if (status === "completed") {
      results = buildResults({
        suspect: state.datasets.get(config.dataset_id),
        clean: state.datasets.get(config.clean_dataset_id),
        config,
        runtimeSeconds: 412.6 + id * 37.1,
        logTail: ["[pipeline] scoring complete", "[pipeline] results written"],
      });
      for (const phase of ["batch_level", "sample_level"]) {
        state.provenance.push({
          id: state.nextId.provenance++,
          experiment_id: id,
          ...buildProvenance(results, config, phase),
          created_at: at,
        });
      }
    } else if (status === "failed") {
      results = {
        summary: { status: "failed" },
        metadata: {
          log_tail: [
            "[phase-i] epoch 3/10 loss=1.9821",
            "RuntimeError: CUDA out of memory. Tried to allocate 512.00 MiB",
            "[pipeline] run aborted",
          ],
        },
      };
    }
    state.experiments.set(id, {
      id,
      name,
      description: null,
      configuration_id: configId,
      config_json: JSON.stringify(config),
      status,
      progress: status === "completed" ? 100 : 30,
      error_message: status === "failed" ? "CUDA out of memory" : null,
      results_json: results ? JSON.stringify(results) : null,
      created_by: 1,
      created_at: at,
      updated_at: at,
    });
    if (status === "completed") {
      state.activity.push({ timestamp: at, type: "experiment_completed", actor: "demo-admin", detail: `Experiment #${id} completed` });
    }
  }

  seedExperiment(1, "Narcissus CIFAR-10 baseline", 1, "completed", 60 * 20);
  seedExperiment(2, "LC STL-10, gaussian threshold", 2, "completed", 60);
  seedExperiment(3, "LC STL-10 on GPU (OOM)", 2, "failed", 90);
  state.activity.push(
    { timestamp: state.datasets.get(5).created_at, type: "dataset_upload", actor: "demo-researcher", detail: "Uploaded field-collected-batch-07.npz" },
    { timestamp: state.users[2].created_at, type: "user_signup", actor: "demo-guest", detail: "New guest account" }
  );

  // ---------------------------------------------------------------------------
  // Serialisation: strip the underscore-prefixed bookkeeping fields so
  // responses carry exactly the backend's schema.
  // ---------------------------------------------------------------------------

  const pub = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith("_")));

  function configResponse(c) {
    return {
      ...pub(c),
      dataset_name: state.datasets.get(c.dataset_id)?.name ?? null,
      clean_dataset_name: state.datasets.get(c.clean_dataset_id)?.name ?? null,
    };
  }

  function userStorage(userId) {
    let used = 0;
    for (const d of state.datasets.values()) if (d.uploaded_by === userId) used += d.file_size_bytes ?? 0;
    return used;
  }

  function totalStorage() {
    let used = 0;
    for (const d of state.datasets.values()) used += d.file_size_bytes ?? 0;
    return used;
  }

  function page(rows, query) {
    const skip = Number(query.get("skip") ?? 0);
    const limit = Number(query.get("limit") ?? 100);
    return rows.slice(skip, skip + limit);
  }

  const byNewest = (a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id;

  // ---------------------------------------------------------------------------
  // Access control
  // ---------------------------------------------------------------------------

  function authenticate(req) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    const entry = token ? state.tokens.get(token) : undefined;
    if (!entry || entry.expiresAt < Date.now()) {
      if (entry) state.tokens.delete(token);
      throw new HttpError(401, "Could not validate credentials");
    }
    return state.users.find((u) => u.id === entry.userId);
  }

  function requireRole(user, role) {
    if (ROLE_RANK[user.role] < ROLE_RANK[role]) {
      throw new HttpError(403, role === "admin" ? "Admin privileges required" : "A registered account is required for this action");
    }
  }

  /** Owner-or-admin read; a non-owner gets the same 404 as a missing row, as the real API does. */
  function owned(map, id, ownerField, user, what) {
    const row = map.get(Number(id));
    if (!row || (row[ownerField] !== user.id && user.role !== "admin")) throw notFound(what);
    return row;
  }

  // ---------------------------------------------------------------------------
  // Background jobs
  // ---------------------------------------------------------------------------

  function log(job, stream, text) {
    job.logs.push({ seq: job.logs.length, ts: Date.now() / 1000, stream, text });
  }

  function startExperimentJob(exp, user) {
    const config = JSON.parse(exp.config_json);
    const suspect = state.datasets.get(config.dataset_id);
    const clean = state.datasets.get(config.clean_dataset_id);
    const job = { logs: [], cancelRequested: false, startedAt: Date.now(), timer: null };
    state.jobs.set(exp.id, job);
    state.provenance = state.provenance.filter((p) => p.experiment_id !== exp.id);

    Object.assign(exp, { status: "running", progress: 0, error_message: null, results_json: null, updated_at: now() });
    log(job, "stdout", `[pipeline] experiment #${exp.id} on ${config.device}: suspect=${suspect.name} (${suspect._sample_count} samples)`);

    const steps = 20;
    const phaseIEnd = 8;
    const phaseIIEnd = 16;
    let step = 0;
    let lastEpoch = 0;
    let partial;

    const finish = (status, extra = {}) => {
      clearInterval(job.timer);
      const logTail = job.logs.slice(-10).map((l) => l.text);
      Object.assign(exp, { status, updated_at: now(), ...extra });
      if (status !== "completed") {
        exp.results_json = JSON.stringify({ summary: { status }, metadata: { log_tail: logTail } });
      }
      // The real backend evicts the in-memory buffer five minutes after a run.
      setTimeout(() => state.jobs.get(exp.id) === job && state.jobs.delete(exp.id), 5 * 60_000).unref();
    };

    job.timer = setInterval(() => {
      if (job.cancelRequested) {
        log(job, "stderr", "[pipeline] cancellation requested -- stopping after current step");
        return finish("cancelled");
      }
      step += 1;
      exp.progress = Math.round((step / steps) * 100);
      exp.updated_at = now();

      // Log once per simulated epoch, not once per tick.
      if (step <= phaseIEnd) {
        const epoch = Math.ceil((step / phaseIEnd) * config.batch_level_epochs);
        const loss = (2.3 * Math.exp(-step / 4) + 0.2).toFixed(4);
        if (epoch !== lastEpoch) log(job, "stdout", `[phase-i] batch-level epoch ${epoch}/${config.batch_level_epochs} loss=${loss}`);
        lastEpoch = step === phaseIEnd ? 0 : epoch;
      } else if (step <= phaseIIEnd) {
        const epoch = Math.ceil(((step - phaseIEnd) / (phaseIIEnd - phaseIEnd)) * config.sample_level_epochs);
        if (epoch !== lastEpoch) log(job, "stdout", `[phase-ii] sample-level epoch ${epoch}/${config.sample_level_epochs} (${config.cv_model})`);
        lastEpoch = epoch;
      } else {
        log(job, "stdout", `[scoring] scoring suspect samples ${step - phaseIIEnd}/${steps - phaseIIEnd}`);
      }

      if (step === phaseIEnd || step === phaseIIEnd) {
        partial ??= buildResults({ suspect, clean, config, runtimeSeconds: 0, logTail: [] });
        const phase = step === phaseIEnd ? "batch_level" : "sample_level";
        state.provenance.push({
          id: state.nextId.provenance++,
          experiment_id: exp.id,
          ...buildProvenance(partial, config, phase),
          created_at: now(),
        });
        log(job, "stdout", `[provenance] recorded ${phase} provenance`);
      }

      if (step >= steps) {
        log(job, "stdout", "[pipeline] results written");
        const results = buildResults({
          suspect,
          clean,
          config,
          runtimeSeconds: (Date.now() - job.startedAt) / 1000,
          logTail: job.logs.slice(-10).map((l) => l.text),
        });
        finish("completed", { progress: 100, results_json: JSON.stringify(results) });
        state.activity.push({ timestamp: now(), type: "experiment_completed", actor: user.username, detail: `Experiment #${exp.id} completed` });
      }
    }, Math.max(50, jobMs / steps));
  }

  function startGenerationJob(dataset) {
    const job = { cancelRequested: false, timer: null };
    state.genJobs.set(dataset.id, job);
    let progress = 0;
    job.timer = setInterval(() => {
      if (job.cancelRequested) {
        clearInterval(job.timer);
        Object.assign(dataset, { generation_status: "cancelled", generation_error: "Cancelled by user" });
        state.genJobs.delete(dataset.id);
        return;
      }
      dataset.generation_status = "running";
      progress = Math.min(100, progress + 10);
      dataset.generation_progress = progress;
      if (progress >= 100) {
        clearInterval(job.timer);
        Object.assign(dataset, {
          generation_status: "completed",
          file_size_bytes: dataset._sample_count * 3072 + 4096,
        });
        state.genJobs.delete(dataset.id);
      }
    }, Math.max(50, jobMs / 10));
  }

  // ---------------------------------------------------------------------------
  // Routes. Each handler gets { user, params, query, body } and returns a
  // JSON-serialisable value, or a function taking `res` for raw responses.
  // ---------------------------------------------------------------------------

  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const regex = new RegExp(
      `^${pattern.replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return "([^/]+)";
      })}$`
    );
    routes.push({ method, regex, keys, handler, auth });
  };

  // --- auth ------------------------------------------------------------------

  route(
    "POST",
    "/api/auth/login",
    ({ form }) => {
      const user = state.users.find((u) => u.email === form?.get("username") && u.password === form?.get("password"));
      if (!user) throw new HttpError(401, "Incorrect email or password");
      const token = randomBytes(24).toString("hex");
      state.tokens.set(token, { userId: user.id, expiresAt: Date.now() + tokenTtlSeconds * 1000 });
      return { access_token: token, token_type: "bearer" };
    },
    { auth: false }
  );

  route("GET", "/api/auth/me", ({ user }) => ({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    is_active: user.is_active,
  }));

  // --- dashboard -------------------------------------------------------------

  route("GET", "/api/dashboard/summary", ({ user }) => {
    const mine = [...state.datasets.values()].filter((d) => d.uploaded_by === user.id).sort(byNewest);
    const exps = [...state.experiments.values()].filter((e) => e.created_by === user.id).sort(byNewest);
    const latest = exps.find((e) => ["completed", "running"].includes(e.status) && e.results_json);
    let latest_analysis = null;
    if (latest) {
      const r = JSON.parse(latest.results_json);
      latest_analysis = {
        status: latest.status,
        clean_count: r.summary.clean_count,
        suspect_count: r.summary.suspect_count,
        poisoned_count: r.summary.poisoned_count,
        total_samples: r.summary.total_samples,
        avg_score: r.summary.avg_score,
        score_distribution: r.summary.score_distribution,
        last_run: latest.updated_at,
      };
    }
    return {
      total_datasets: mine.filter((d) => d.type === "dataset").length,
      total_models: mine.filter((d) => d.type === "model").length,
      total_experiments: exps.length,
      recent_datasets: mine.slice(0, 5).map(pub),
      recent_experiments: exps.slice(0, 5),
      // Installation-wide on the real backend too; the MCP tool compensates.
      storage_used_bytes: totalStorage(),
      storage_cap_bytes: STORAGE_CAP_BYTES,
      latest_analysis,
    };
  });

  // --- datasets --------------------------------------------------------------

  route("GET", "/api/datasets", ({ user, query }) => {
    const type = query.get("type");
    const rows = [...state.datasets.values()]
      .filter((d) => d.uploaded_by === user.id && (!type || d.type === type))
      .sort(byNewest);
    return { datasets: page(rows, query).map(pub), total: rows.length };
  });

  route("GET", "/api/datasets/storage/info", ({ user }) => {
    const used = totalStorage();
    const mine = userStorage(user.id);
    return {
      used_bytes: used,
      cap_bytes: STORAGE_CAP_BYTES,
      remaining_bytes: Math.max(0, STORAGE_CAP_BYTES - used),
      user_used_bytes: mine,
      user_quota_bytes: USER_QUOTA_BYTES,
      user_remaining_bytes: Math.max(0, USER_QUOTA_BYTES - mine),
    };
  });

  route("POST", "/api/datasets/upload", async ({ user, multipart }) => {
    requireRole(user, "registered");
    const file = multipart?.get("file");
    if (!file || typeof file === "string") throw new HttpError(422, [{ loc: ["body", "file"], msg: "Field required", type: "missing" }]);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (userStorage(user.id) + bytes.length > USER_QUOTA_BYTES) throw new HttpError(413, "Upload would exceed your storage quota");
    const isModel = /\.(pt|pth|ckpt)$/i.test(file.name);
    const id = state.nextId.dataset++;
    const row = {
      id,
      name: file.name,
      type: isModel ? "model" : "dataset",
      file_size_bytes: bytes.length,
      description: multipart.get("description") || null,
      uploaded_by: user.id,
      created_at: now(),
      generation_status: null,
      generation_progress: null,
      generation_error: null,
      attack_type: null,
      base_dataset: null,
      poison_ratio: null,
      approval_status: "pending",
      approval_reason: null,
      reviewed_by: null,
      reviewed_at: null,
      _seed: id * 31,
      _sample_count: isModel ? 0 : npzSampleCount(bytes) ?? 64,
    };
    state.datasets.set(id, row);
    state.activity.push({ timestamp: row.created_at, type: "dataset_upload", actor: user.username, detail: `Uploaded ${row.name}` });
    return pub(row);
  });

  route("GET", "/api/datasets/:id", ({ user, params }) => pub(owned(state.datasets, params.id, "uploaded_by", user, "Dataset")));

  route("DELETE", "/api/datasets/:id", ({ user, params }) => {
    requireRole(user, "registered");
    const row = owned(state.datasets, params.id, "uploaded_by", user, "Dataset");
    state.genJobs.get(row.id) && clearInterval(state.genJobs.get(row.id).timer);
    state.genJobs.delete(row.id);
    state.datasets.delete(row.id);
    return { detail: `Dataset ${row.id} deleted` };
  });

  // --- generation ------------------------------------------------------------

  const GENERATION_FIELDS = [
    "id", "name", "generation_status", "generation_progress", "generation_error",
    "attack_type", "base_dataset", "poison_ratio", "file_size_bytes", "created_at",
  ];
  const generationResponse = (row) => Object.fromEntries(GENERATION_FIELDS.map((k) => [k, row[k]]));

  route("GET", "/api/generate/attacks", () => ATTACKS);

  route("POST", "/api/generate", ({ user, body }) => {
    requireRole(user, "registered");
    const attack = ATTACKS.find((a) => a.id === body?.attack_type);
    if (!attack) throw invalid("attack_type", "Unknown attack type");
    if (!body.name) throw invalid("name", "Field required");
    const base = body.base_dataset ?? "cifar10";
    if (!attack.supported_datasets.includes(base)) {
      throw new HttpError(400, `Attack '${attack.id}' does not support base dataset '${base}'`);
    }
    if (attack.requires_source_class && body.source_class === undefined) {
      throw new HttpError(400, `source_class is required for the '${attack.id}' attack`);
    }
    if (attack.requires_clean_model) {
      const model = state.datasets.get(body.clean_model_id);
      if (!model || model.type !== "model") throw new HttpError(400, "clean_model_id is required for 'lc' and must reference an uploaded model");
    }
    const id = state.nextId.dataset++;
    const row = {
      id,
      name: body.name,
      type: "dataset",
      file_size_bytes: null,
      description: body.description ?? null,
      uploaded_by: user.id,
      created_at: now(),
      generation_status: "pending",
      generation_progress: 0,
      generation_error: null,
      attack_type: attack.id,
      base_dataset: base,
      poison_ratio: body.poison_ratio ?? 10,
      approval_status: user.role === "admin" ? "approved" : "pending",
      approval_reason: null,
      reviewed_by: null,
      reviewed_at: null,
      _seed: id * 31,
      _sample_count: 500,
    };
    state.datasets.set(id, row);
    startGenerationJob(row);
    return generationResponse(row);
  });

  route("GET", "/api/generate/:id/status", ({ user, params }) => {
    const d = owned(state.datasets, params.id, "uploaded_by", user, "Dataset");
    return { id: d.id, generation_status: d.generation_status, generation_progress: d.generation_progress, generation_error: d.generation_error };
  });

  route("POST", "/api/generate/:id/cancel", ({ user, params }) => {
    requireRole(user, "registered");
    const d = owned(state.datasets, params.id, "uploaded_by", user, "Dataset");
    const job = state.genJobs.get(d.id);
    if (!job) throw new HttpError(400, `Generation for dataset ${d.id} is not running (status: ${d.generation_status})`);
    job.cancelRequested = true;
    d.generation_status = "cancelling";
    return { detail: `Cancellation requested for dataset ${d.id}` };
  });

  // --- configurations --------------------------------------------------------

  const CONFIG_FIELDS = Object.keys(DEFAULT_CONFIG);

  function checkReferences(user, fields) {
    for (const key of ["dataset_id", "clean_dataset_id", "model_id"]) {
      if (fields[key] !== undefined && fields[key] !== null) {
        const row = owned(state.datasets, fields[key], "uploaded_by", user, `Referenced ${key.replace("_id", "")}`);
        if (key === "model_id") fields.model_architecture = row.name;
      }
    }
  }

  route("GET", "/api/config/defaults", ({ user }) => ({
    ...DEFAULT_CONFIG,
    id: 0,
    created_by: user.id,
    created_at: null,
    updated_at: null,
    dataset_name: null,
    clean_dataset_name: null,
  }));

  route("GET", "/api/config", ({ user, query }) => {
    const rows = [...state.configurations.values()].filter((c) => c.created_by === user.id).sort(byNewest);
    return { configurations: page(rows, query).map(configResponse), total: rows.length };
  });

  route("POST", "/api/config", ({ user, body }) => {
    requireRole(user, "registered");
    if (!body?.name) throw invalid("name", "Field required");
    const fields = Object.fromEntries(Object.entries(body).filter(([k]) => CONFIG_FIELDS.includes(k)));
    checkReferences(user, fields);
    const id = state.nextId.config++;
    const row = { ...DEFAULT_CONFIG, ...fields, id, created_by: user.id, created_at: now(), updated_at: now() };
    state.configurations.set(id, row);
    return configResponse(row);
  });

  route("GET", "/api/config/:id", ({ user, params }) => configResponse(owned(state.configurations, params.id, "created_by", user, "Configuration")));

  route("PUT", "/api/config/:id", ({ user, params, body }) => {
    requireRole(user, "registered");
    const row = owned(state.configurations, params.id, "created_by", user, "Configuration");
    // Partial update: absent keys are untouched, an explicit null clears.
    const fields = Object.fromEntries(Object.entries(body ?? {}).filter(([k]) => CONFIG_FIELDS.includes(k)));
    checkReferences(user, fields);
    Object.assign(row, fields, { updated_at: now() });
    return configResponse(row);
  });

  route("DELETE", "/api/config/:id", ({ user, params }) => {
    requireRole(user, "registered");
    const row = owned(state.configurations, params.id, "created_by", user, "Configuration");
    state.configurations.delete(row.id);
    return { detail: `Configuration ${row.id} deleted` };
  });

  // --- experiments -----------------------------------------------------------

  const getExperiment = (user, id) => owned(state.experiments, id, "created_by", user, "Experiment");
  const isActive = (e) => ["running", "cancelling"].includes(e.status);

  route("POST", "/api/experiments", ({ user, body }) => {
    requireRole(user, "registered");
    if (!body?.name) throw invalid("name", "Field required");
    const config = owned(state.configurations, body.configuration_id, "created_by", user, "Configuration");
    const id = state.nextId.experiment++;
    const row = {
      id,
      name: body.name,
      description: body.description ?? null,
      configuration_id: config.id,
      config_json: JSON.stringify(config),
      status: "pending",
      progress: 0,
      error_message: null,
      results_json: null,
      created_by: user.id,
      created_at: now(),
      updated_at: now(),
    };
    state.experiments.set(id, row);
    return row;
  });

  route("GET", "/api/experiments", ({ user, query }) => {
    const rows = [...state.experiments.values()].filter((e) => e.created_by === user.id).sort(byNewest);
    return { experiments: page(rows, query), total: rows.length };
  });

  route("GET", "/api/experiments/:id", ({ user, params }) => getExperiment(user, params.id));

  route("DELETE", "/api/experiments/:id", ({ user, params }) => {
    requireRole(user, "registered");
    const exp = getExperiment(user, params.id);
    if (isActive(exp)) throw new HttpError(409, "Cannot delete a running experiment; cancel it first");
    state.experiments.delete(exp.id);
    state.jobs.delete(exp.id);
    state.provenance = state.provenance.filter((p) => p.experiment_id !== exp.id);
    return { detail: `Experiment ${exp.id} deleted` };
  });

  route("POST", "/api/experiments/:id/run", ({ user, params }) => {
    requireRole(user, "registered");
    const exp = getExperiment(user, params.id);
    if (isActive(exp)) throw new HttpError(409, `Experiment ${exp.id} is already running`);
    const config = state.configurations.get(exp.configuration_id);
    if (!config) throw new HttpError(400, "The experiment's configuration no longer exists");
    for (const key of ["dataset_id", "clean_dataset_id"]) {
      const d = state.datasets.get(config[key]);
      if (!d) throw new HttpError(400, `Configuration ${config.id} has no valid ${key}`);
      if (d.approval_status === "rejected") throw new HttpError(400, `Dataset ${d.id} was rejected by an admin and cannot be used`);
    }
    // Re-snapshot so a restart picks up configuration edits.
    exp.config_json = JSON.stringify(config);
    startExperimentJob(exp, user);
    return { detail: `Experiment ${exp.id} started` };
  });

  route("POST", "/api/experiments/:id/cancel", ({ user, params }) => {
    requireRole(user, "registered");
    const exp = getExperiment(user, params.id);
    if (exp.status === "pending") {
      Object.assign(exp, { status: "cancelled", updated_at: now() });
      return { detail: `Experiment ${exp.id} cancelled` };
    }
    if (!isActive(exp)) throw new HttpError(400, `Experiment ${exp.id} is not running (status: ${exp.status})`);
    state.jobs.get(exp.id).cancelRequested = true;
    exp.status = "cancelling";
    return { detail: `Cancellation requested for experiment ${exp.id}; it will stop after the current step` };
  });

  route("GET", "/api/experiments/:id/status", ({ user, params }) => {
    const e = getExperiment(user, params.id);
    return { id: e.id, status: e.status, progress: e.progress, error_message: e.error_message };
  });

  route("GET", "/api/experiments/:id/logs", ({ user, params, query }) => {
    const e = getExperiment(user, params.id);
    const job = state.jobs.get(e.id);
    const since = Number(query.get("since") ?? 0);
    if (!job) {
      // Buffer evicted (or never existed): fall back to the persisted tail.
      const tail = e.results_json ? JSON.parse(e.results_json).metadata?.log_tail ?? [] : [];
      const lines = tail.map((text, seq) => ({ seq, ts: 0, stream: "stdout", text })).filter((l) => l.seq >= since);
      return { lines, next_cursor: tail.length, active: false, complete: true };
    }
    return {
      lines: job.logs.filter((l) => l.seq >= since),
      next_cursor: job.logs.length,
      active: isActive(e),
      complete: !isActive(e),
    };
  });

  route("GET", "/api/experiments/:id/results", ({ user, params }) => {
    const e = getExperiment(user, params.id);
    return {
      id: e.id,
      status: e.status,
      results_json: e.results_json,
      provenance_records: state.provenance.filter((p) => p.experiment_id === e.id),
    };
  });

  function suspectOf(exp) {
    const config = JSON.parse(exp.config_json);
    const dataset = state.datasets.get(config.dataset_id);
    if (!dataset) throw new HttpError(404, "The experiment's suspect dataset no longer exists");
    return dataset;
  }

  route("GET", "/api/experiments/:id/sample/:index", ({ user, params }) => {
    const exp = getExperiment(user, params.id);
    const dataset = suspectOf(exp);
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 0 || index >= dataset._sample_count) {
      throw new HttpError(404, `Sample index ${params.index} out of range (dataset has ${dataset._sample_count} samples)`);
    }
    const poisoned = poisonedSet(dataset._seed, dataset._sample_count, dataset.poison_ratio).has(index);
    const { width, height, rgb } = sampleRgb(dataset._seed, index, poisoned);
    return { image: encodePng(width, height, rgb).toString("base64"), sample_index: index, width, height };
  });

  route("GET", "/api/experiments/:id/sanitized-dataset", ({ user, params, query }) => {
    const exp = getExperiment(user, params.id);
    if (exp.status !== "completed") {
      throw new HttpError(400, `Experiment ${exp.id} has not completed (status: ${exp.status}); no scores to sanitize with`);
    }
    const results = JSON.parse(exp.results_json);
    const scores = results.per_sample_scores ?? [];
    if (scores.length === 0) throw new HttpError(400, "Experiment has no per-sample scores");
    const threshold = query.has("threshold") ? Number(query.get("threshold")) : results.summary.threshold;
    const kept = scores.filter((s) => s.score < threshold).map((s) => s.sample_index);
    const dataset = suspectOf(exp);
    const npz = makeNpz(dataset._seed, kept, (i) => (i * 7) % 10);

    return (res) => {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="experiment_${exp.id}_sanitized.npz"`,
        "Content-Length": npz.length,
        "X-Original-Sample-Count": scores.length,
        "X-Removed-Sample-Count": scores.length - kept.length,
        "X-Kept-Sample-Count": kept.length,
        "X-Threshold": threshold,
      });
      // Written in chunks so the client's streaming path is exercised for real.
      const chunk = 64 * 1024;
      for (let o = 0; o < npz.length; o += chunk) res.write(npz.subarray(o, o + chunk));
      res.end();
    };
  });

  // --- admin -----------------------------------------------------------------

  route("GET", "/api/admin/datasets", ({ user, query }) => {
    requireRole(user, "admin");
    const status = query.get("status");
    const rows = [...state.datasets.values()].filter((d) => !status || d.approval_status === status).sort(byNewest);
    return { datasets: page(rows, query).map(pub), total: rows.length };
  });

  function moderate(user, id, decision, body) {
    requireRole(user, "admin");
    const d = state.datasets.get(Number(id));
    if (!d) throw notFound("Dataset");
    Object.assign(d, { approval_status: decision, approval_reason: body?.reason ?? null, reviewed_by: user.id, reviewed_at: now() });
    return pub(d);
  }

  route("POST", "/api/admin/datasets/:id/approve", ({ user, params, body }) => moderate(user, params.id, "approved", body));
  route("POST", "/api/admin/datasets/:id/reject", ({ user, params, body }) => moderate(user, params.id, "rejected", body));

  route("GET", "/api/admin/users/:id", ({ user, params }) => {
    requireRole(user, "admin");
    const u = state.users.find((x) => x.id === Number(params.id));
    if (!u) throw notFound("User");
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      is_active: u.is_active,
      storage_used_bytes: userStorage(u.id),
      storage_quota_bytes: USER_QUOTA_BYTES,
      created_at: u.created_at,
      deleted_at: null,
      purge_after: null,
      days_until_purge: null,
    };
  });

  route("GET", "/api/admin/stats", ({ user }) => {
    requireRole(user, "admin");
    const count = (rows, key, values) => Object.fromEntries(values.map((v) => [v, rows.filter((r) => r[key] === v).length]));
    const datasets = [...state.datasets.values()];
    const exps = [...state.experiments.values()].map((e) => ({ ...e, status: e.status === "cancelling" ? "running" : e.status }));
    return {
      user_count: state.users.length,
      user_roles: count(state.users, "role", ["admin", "registered", "guest"]),
      dataset_count: datasets.length,
      dataset_statuses: count(datasets, "approval_status", ["pending", "approved", "rejected"]),
      experiment_count: exps.length,
      experiment_statuses: count(exps, "status", ["pending", "running", "completed", "failed", "cancelled"]),
      storage_used_bytes: totalStorage(),
      storage_cap_bytes: STORAGE_CAP_BYTES,
      top_storage_users: state.users
        .map((u) => ({ user_id: u.id, username: u.username, email: u.email, used_bytes: userStorage(u.id), quota_bytes: USER_QUOTA_BYTES }))
        .sort((a, b) => b.used_bytes - a.used_bytes)
        .slice(0, 5),
      recent_activity: [...state.activity].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 10),
    };
  });

  // ---------------------------------------------------------------------------
  // HTTP plumbing
  // ---------------------------------------------------------------------------

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async function parseBody(req, raw) {
    const type = req.headers["content-type"] ?? "";
    if (raw.length === 0) return {};
    if (type.startsWith("application/json")) {
      try {
        return { body: JSON.parse(raw.toString("utf8")) };
      } catch {
        throw new HttpError(422, [{ loc: ["body"], msg: "JSON decode error", type: "json_invalid" }]);
      }
    }
    if (type.startsWith("application/x-www-form-urlencoded")) {
      return { form: new URLSearchParams(raw.toString("utf8")) };
    }
    if (type.startsWith("multipart/form-data")) {
      // Let the platform's fetch implementation do the multipart parsing.
      return { multipart: await new Request("http://mock/", { method: "POST", headers: { "content-type": type }, body: raw }).formData() };
    }
    return {};
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    };

    try {
      const raw = await readBody(req);
      const candidates = routes.filter((r) => r.regex.test(url.pathname));
      const match = candidates.find((r) => r.method === req.method);
      if (!match) {
        throw candidates.length > 0 ? new HttpError(405, "Method Not Allowed") : new HttpError(404, "Not Found");
      }
      const values = match.regex.exec(url.pathname).slice(1);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(values[i])]));
      const user = match.auth ? authenticate(req) : undefined;
      const result = await match.handler({ user, params, query: url.searchParams, ...(await parseBody(req, raw)) });
      if (typeof result === "function") return result(res);
      send(200, result);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 401) res.setHeader("WWW-Authenticate", "Bearer");
        send(err.status, { detail: err.detail });
      } else {
        console.error(err);
        send(500, { detail: "Internal Server Error" });
      }
    } finally {
      if (process.env.MOCK_QUIET !== "1") {
        console.log(`${req.method} ${url.pathname}${url.search} -> ${res.statusCode}`);
      }
    }
  });

  server.on("close", () => {
    for (const job of state.jobs.values()) clearInterval(job.timer);
    for (const job of state.genJobs.values()) clearInterval(job.timer);
  });

  return { server, state };
}

// Run as a script (not imported). Compared case-insensitively on Windows,
// where the drive letter's case depends on how the path was typed.
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  const port = Number(process.env.MOCK_PORT ?? 8321);
  const host = process.env.MOCK_HOST ?? "127.0.0.1";
  const { server } = createMockBackend({
    jobMs: Number(process.env.MOCK_JOB_MS ?? 8000),
    tokenTtlSeconds: Number(process.env.MOCK_TOKEN_TTL_S ?? 3600),
  });
  server.listen(port, host, () => {
    console.log(`PoisonDash mock backend listening on http://${host}:${port}`);
    console.log("Demo accounts (in-memory, reset on restart):");
    for (const u of USERS) console.log(`  ${u.role.padEnd(10)} ${u.email}  /  ${u.password}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
