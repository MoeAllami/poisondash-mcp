/**
 * Live smoke test against a running PoisonDash backend -- the real one, or the
 * bundled mock (`npm run mock`).
 *
 * Not part of `npm test` -- this one needs a running backend. It drives the MCP
 * server over stdio exactly as a client would, and provisions everything it
 * touches through the API so it can be run against any dev instance from a
 * fresh checkout and delete precisely what it created.
 *
 *   node test/integration/smoke.mjs            # run from src/ via tsx
 *   node test/integration/smoke.mjs --dist     # run the compiled dist/index.js
 *
 * Environment: SMOKE_API_URL, SMOKE_EMAIL, SMOKE_PASSWORD (defaults target the
 * mock backend's demo admin), SMOKE_VERBOSE=1 to echo the server's stderr.
 *
 * It creates and then removes: three datasets, one configuration, one
 * experiment. Point it at a dev database, not one you care about.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  API_URL,
  EMAIL,
  PASSWORD,
  check,
  failureCount,
  login,
  makeNpz,
  restClient,
  section,
  startServer,
} from "./harness.mjs";

const useDist = process.argv.includes("--dist");
const stamp = `mcp-smoke-${process.pid}`;
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "poisondash-smoke-"));

const created = { datasets: [], configs: [], experiments: [] };
let rest;
let server;

async function teardown() {
  section("teardown");
  if (server) server.stop();
  // Always reclaim the scratch directory, even if provisioning never got far
  // enough to create anything server-side.
  const removeScratch = () => fs.rm(outputDir, { recursive: true, force: true });
  if (!rest) {
    await removeScratch();
    return;
  }

  for (const id of created.experiments) {
    await rest.del(`/api/experiments/${id}`).then(
      () => check(`deleted experiment #${id}`, true),
      (err) => check(`deleted experiment #${id}`, false, err.message)
    );
  }
  for (const id of created.configs) {
    await rest.del(`/api/config/${id}`).then(
      () => check(`deleted configuration #${id}`, true),
      (err) => check(`deleted configuration #${id}`, false, err.message)
    );
  }
  for (const id of created.datasets) {
    await rest.del(`/api/datasets/${id}`).then(
      () => check(`deleted dataset #${id}`, true),
      (err) => check(`deleted dataset #${id}`, false, err.message)
    );
  }
  await removeScratch();
}

try {
  section(`provisioning against ${API_URL} as ${EMAIL}`);
  const token = await login();
  rest = restClient(token);

  const me = await rest.get("/api/auth/me");
  const isAdmin = me.role === "admin";
  check(`logged in as ${me.username} (role=${me.role})`, true);

  const before = await rest.get("/api/datasets/storage/info");

  const suspect = await rest.uploadDataset(`${stamp}-suspect.npz`, makeNpz(6));
  created.datasets.push(suspect.id);
  const clean = await rest.uploadDataset(`${stamp}-clean.npz`, makeNpz(6));
  created.datasets.push(clean.id);
  const spare = await rest.uploadDataset(`${stamp}-moderation.npz`, makeNpz(2));
  created.datasets.push(spare.id);
  check(`uploaded 3 fixture datasets (#${suspect.id}, #${clean.id}, #${spare.id})`, true);

  server = startServer({
    useDist,
    env: {
      POISONDASH_EMAIL: EMAIL,
      POISONDASH_PASSWORD: PASSWORD,
      POISONDASH_ADMIN: isAdmin ? "true" : "false",
      POISONDASH_OUTPUT_DIR: outputDir,
    },
  });

  // -------------------------------------------------------------------------
  section("protocol handshake");
  const init = await server.initialize();
  check("initialize returns serverInfo", init.result?.serverInfo?.name === "poisondash-research-pipeline");

  const tools = await server.listTools();
  const names = tools.map((t) => t.name);
  console.log(`  ${tools.length} tools: ${names.join(", ")}`);
  check("no tool accepts a password", !JSON.stringify(tools).match(/"password"/));
  check("every tool publishes annotations", tools.every((t) => t.annotations !== undefined));
  check(
    "read-only tools are flagged readOnlyHint",
    tools.find((t) => t.name === "list_datasets")?.annotations?.readOnlyHint === true
  );
  check(
    "admin tools are visible only when POISONDASH_ADMIN is set",
    names.includes("get_system_stats") === isAdmin
  );

  // -------------------------------------------------------------------------
  section("read-only tools");
  const dashboard = await server.call("get_dashboard_summary");
  console.log(dashboard.text.split("\n").map((l) => `  | ${l}`).join("\n"));
  check("get_dashboard_summary succeeded", !dashboard.isError);
  check("reports the caller's own storage", /Your storage:/.test(dashboard.text));
  check("reports installation storage separately", /Installation storage \(all users\)/.test(dashboard.text));

  const list = await server.call("list_datasets", { limit: 100 });
  check("list_datasets sees the uploaded fixtures", list.text.includes(`${stamp}-suspect.npz`));

  const detail = await server.call("get_dataset", { dataset_id: suspect.id });
  check("get_dataset returns the fixture", detail.text.includes(`${stamp}-suspect.npz`));

  const attacks = await server.call("list_available_attacks", { base_dataset: "cifar10" });
  check("list_available_attacks filters by base dataset", /narcissus/.test(attacks.text));

  const defaults = await server.call("get_default_configuration");
  check("get_default_configuration succeeded", !defaults.isError);

  // -------------------------------------------------------------------------
  section("configuration lifecycle");
  const createdConfig = await server.call("create_configuration", {
    name: `${stamp} config`,
    dataset_id: suspect.id,
    clean_dataset_id: clean.id,
    total_epochs: 1,
    batch_size: 4,
  });
  check("create_configuration succeeded", !createdConfig.isError, createdConfig.text);
  const configId = Number(createdConfig.text.match(/#(\d+)/)?.[1]);
  if (Number.isFinite(configId)) created.configs.push(configId);
  check("parsed a configuration id", Number.isFinite(configId));

  const fetched = await server.call("get_configuration", { config_id: configId });
  check("get_configuration returns the new row", fetched.text.includes(`#${configId}`));
  check("get_configuration exposes phase epoch counts", /batch_level_epochs=\d+/.test(fetched.text));

  const updated = await server.call("update_configuration", {
    config_id: configId,
    threshold_method: "gaussian",
  });
  check("update_configuration applied one field", updated.text.includes("gaussian"));
  check("untouched fields survived the update", updated.text.includes(`(${stamp}-suspect.npz)`));

  const detached = await server.call("update_configuration", { config_id: configId, model_id: null });
  check("update_configuration accepts an explicit null", !detached.isError, detached.text);

  // -------------------------------------------------------------------------
  section("experiment lifecycle");
  const experiment = await server.call("create_experiment", {
    name: `${stamp} experiment`,
    configuration_id: configId,
  });
  check("create_experiment succeeded", !experiment.isError, experiment.text);
  const experimentId = Number(experiment.text.match(/#(\d+)/)?.[1]);
  if (Number.isFinite(experimentId)) created.experiments.push(experimentId);

  const run = await server.call("run_experiment", { experiment_id: experimentId });
  check("run_experiment accepted", !run.isError, run.text);

  await delay(1500);
  const status = await server.call("get_experiment_status", { experiment_id: experimentId });
  console.log(`  | ${status.text}`);
  check("get_experiment_status succeeded", !status.isError);

  const logs = await server.call("get_experiment_logs", { experiment_id: experimentId, tail_lines: 5 });
  check("get_experiment_logs succeeded", !logs.isError, logs.text);

  const results = await server.call("get_experiment_results", { experiment_id: experimentId });
  check("get_experiment_results tolerates a partial/stub payload", !results.isError, results.text);

  const provenance = await server.call("get_provenance_records", { experiment_id: experimentId });
  check("get_provenance_records succeeded", !provenance.isError, provenance.text);

  const cancel = await server.call("cancel_experiment", { experiment_id: experimentId });
  check(
    "cancel_experiment cancels or reports a clean 'not running'",
    !cancel.isError || /not running/i.test(cancel.text),
    cancel.text
  );
  // A cancelled or failed run must reach a terminal state before teardown --
  // the backend refuses to delete a running experiment.
  for (let i = 0; i < 20; i += 1) {
    const s = await server.call("get_experiment_status", { experiment_id: experimentId });
    if (/completed|failed|cancelled/.test(s.text)) break;
    await delay(500);
  }

  // -------------------------------------------------------------------------
  section("binary and error paths");
  const image = await server.call("get_sample_image", { experiment_id: experimentId, sample_index: 0 });
  check(
    "get_sample_image decodes a real sample to PNG",
    !image.isError && image.content.some((c) => c.type === "image"),
    image.text
  );

  const outOfRange = await server.call("get_sample_image", { experiment_id: experimentId, sample_index: 9999 });
  check("an out-of-range sample index reports isError", outOfRange.isError === true);

  // The run above will not have completed, so this exercises the failure path:
  // the guard must leave neither a reservation nor a .part file behind.
  const sanitized = await server.call("get_sanitized_dataset", { experiment_id: experimentId });
  check("get_sanitized_dataset reports the backend's reason", sanitized.isError === true, sanitized.text);
  console.log(`  | ${sanitized.text}`);
  const leftovers = await fs.readdir(outputDir);
  check("no reservation or partial file left behind", leftovers.length === 0, leftovers.join(", "));

  const escape = await server.call("get_sanitized_dataset", {
    experiment_id: experimentId,
    output_path: "../escaped.npz",
  });
  check("path traversal is refused", escape.isError === true && /Refusing to write outside/.test(escape.text));

  const missing = await server.call("get_experiment_status", { experiment_id: 99999999 });
  check("a 404 surfaces the backend detail", missing.isError === true && /not found/i.test(missing.text));

  const badArgs = await server.call("create_experiment", { name: "", configuration_id: configId });
  check("schema validation rejects bad arguments", badArgs.isError === true);

  // -------------------------------------------------------------------------
  section("generation");
  const generation = await server.call("start_generation", {
    name: `${stamp} generated`,
    attack_type: "sa",
    base_dataset: "cifar10",
    source_class: 1,
    poison_ratio: 5,
  });
  if (!generation.isError) {
    const datasetId = Number(generation.text.match(/dataset #(\d+)/)?.[1]);
    if (Number.isFinite(datasetId)) created.datasets.push(datasetId);
    check("start_generation accepted", true);
    const genStatus = await server.call("get_generation_status", { dataset_id: datasetId });
    check("get_generation_status succeeded", !genStatus.isError, genStatus.text);
    const genCancel = await server.call("cancel_generation", { dataset_id: datasetId });
    check(
      "cancel_generation cancels or reports a clean 'not running'",
      !genCancel.isError || /not running/i.test(genCancel.text),
      genCancel.text
    );
    for (let i = 0; i < 20; i += 1) {
      const s = await server.call("get_generation_status", { dataset_id: datasetId });
      if (!/running|pending|cancelling/.test(s.text)) break;
      await delay(500);
    }
  } else {
    // 'sa' needs pre-generated .npy files on disk; a clean rejection still
    // proves the request was well-formed and the error path is wired up.
    check("start_generation reports a well-formed backend error", /required|not found|missing|\.npy/i.test(generation.text), generation.text);
  }

  // -------------------------------------------------------------------------
  if (isAdmin) {
    section("admin tools");
    const stats = await server.call("get_system_stats");
    check("get_system_stats succeeded", !stats.isError, stats.text);
    check("stats report role counts", /Users: \d+ \(admin=/.test(stats.text));

    const reject = await server.call("reject_dataset", { dataset_id: spare.id, reason: "smoke test" });
    check("reject_dataset succeeded", !reject.isError, reject.text);
    check("rejection is reflected in the response", /Approval: rejected \(smoke test\)/.test(reject.text));

    const afterReject = await rest.get(`/api/datasets/${spare.id}`);
    check("rejection persisted server-side", afterReject.approval_status === "rejected");

    const pending = await server.call("list_pending_datasets", { limit: 100 });
    check("list_pending_datasets succeeded", !pending.isError, pending.text);

    const approve = await server.call("approve_dataset", { dataset_id: spare.id });
    check("approve_dataset succeeded", !approve.isError, approve.text);
    const afterApprove = await rest.get(`/api/datasets/${spare.id}`);
    check("approval persisted server-side", afterApprove.approval_status === "approved");
  } else {
    section("admin tools (skipped: not an admin account)");
  }

  // -------------------------------------------------------------------------
  section("comparison");
  const compare = await server.call("compare_experiments", {
    experiment_ids: [experimentId, experimentId],
  });
  check("compare_experiments succeeded", !compare.isError, compare.text);

  const analyze = await server.call("analyze_score_distribution", { experiment_id: experimentId });
  check(
    "analyze_score_distribution handles a run with no scores",
    analyze.isError === true && /no per-sample scores/i.test(analyze.text)
  );

  // -------------------------------------------------------------------------
  section("storage accounting");
  const after = await rest.get("/api/datasets/storage/info");
  check(
    "uploads are attributed to the caller's quota",
    after.user_used_bytes > before.user_used_bytes,
    `${before.user_used_bytes} -> ${after.user_used_bytes}`
  );
} catch (err) {
  check(`unexpected failure: ${err.message}`, false);
  if (process.env.SMOKE_VERBOSE) console.error(err);
} finally {
  await teardown().catch((err) => check(`teardown failed: ${err.message}`, false));
}

const failed = failureCount();
console.log(failed === 0 ? "\nSMOKE TEST PASSED" : `\nSMOKE TEST FAILED (${failed} check(s))`);
process.exit(failed === 0 ? 0 : 1);
