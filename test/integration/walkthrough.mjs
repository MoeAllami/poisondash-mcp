/**
 * Happy-path walkthrough: one detection run taken all the way to completion.
 *
 * smoke.mjs deliberately cancels its run mid-flight to exercise the stub and
 * failure paths; this script covers the other half -- a run that finishes, and
 * the tools that only have something to say afterwards (results, score
 * analysis, comparison, sample images, the sanitized export). It prints each
 * tool's output, so it doubles as a transcript of what an agent sees.
 *
 *   npm run mock                                # in one terminal
 *   node test/integration/walkthrough.mjs       # in another (--dist for dist/)
 *
 * Same SMOKE_* environment as smoke.mjs. Against the mock a run takes
 * MOCK_JOB_MS (default 8s); against the real backend it trains a model, so
 * expect minutes. It deletes the configuration and experiment it creates.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { EMAIL, PASSWORD, check, failureCount, login, restClient, section, startServer } from "./harness.mjs";

const useDist = process.argv.includes("--dist");
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "poisondash-walkthrough-"));
const created = { configs: [], experiments: [] };
let server;
let rest;

const show = (result) => console.log(result.text.split("\n").map((l) => `  | ${l}`).join("\n"));

try {
  rest = restClient(await login());
  const me = await rest.get("/api/auth/me");
  server = startServer({
    useDist,
    env: {
      POISONDASH_EMAIL: EMAIL,
      POISONDASH_PASSWORD: PASSWORD,
      POISONDASH_ADMIN: me.role === "admin" ? "true" : "false",
      POISONDASH_OUTPUT_DIR: outputDir,
    },
  });
  await server.initialize();

  section("pick a poisoned dataset and a clean reference");
  const datasets = await rest.get("/api/datasets?type=dataset&limit=100");
  const suspect = datasets.datasets.find((d) => d.attack_type && d.generation_status === "completed");
  const clean = datasets.datasets.find((d) => !d.attack_type && d.approval_status === "approved");
  check("found a generated poisoned dataset", suspect !== undefined);
  check("found an approved clean dataset", clean !== undefined);
  show(await server.call("get_dataset", { dataset_id: suspect.id }));

  section("configure and run");
  const config = await server.call("create_configuration", {
    name: `walkthrough-${process.pid}`,
    dataset_id: suspect.id,
    clean_dataset_id: clean.id,
    threshold_method: "kmeans",
    total_epochs: 4,
    batch_level_epochs: 2,
    sample_level_epochs: 2,
    sample_level_start_epoch: 2,
  });
  const configId = Number(config.text.match(/#(\d+)/)?.[1]);
  created.configs.push(configId);
  check("create_configuration succeeded", !config.isError, config.text);

  const experiment = await server.call("create_experiment", { name: `walkthrough-${process.pid}`, configuration_id: configId });
  const experimentId = Number(experiment.text.match(/#(\d+)/)?.[1]);
  created.experiments.push(experimentId);
  check("create_experiment succeeded", !experiment.isError, experiment.text);
  check("run_experiment accepted", !(await server.call("run_experiment", { experiment_id: experimentId })).isError);

  let cursor = 0;
  let finalStatus = "";
  for (let i = 0; i < 600; i += 1) {
    const logs = await server.call("get_experiment_logs", { experiment_id: experimentId, since: cursor });
    cursor = Number(logs.text.match(/next_cursor=(\d+)/)?.[1] ?? cursor);
    for (const line of logs.text.split("\n").filter((l) => l.startsWith("["))) console.log(`  | ${line}`);
    const status = await server.call("get_experiment_status", { experiment_id: experimentId });
    finalStatus = status.text;
    if (/completed|failed|cancelled/.test(status.text)) break;
    await delay(1000);
  }
  check("the run completed", /completed/.test(finalStatus), finalStatus);

  section("results");
  const results = await server.call("get_experiment_results", { experiment_id: experimentId });
  show(results);
  check("results report a detection rate", /detection rate/.test(results.text), results.text);

  const analysis = await server.call("analyze_score_distribution", { experiment_id: experimentId });
  show(analysis);
  check("analyze_score_distribution computed statistics", !analysis.isError && /Median/.test(analysis.text));

  const provenance = await server.call("get_provenance_records", { experiment_id: experimentId });
  check("both pipeline phases left provenance", /batch_level/.test(provenance.text) && /sample_level/.test(provenance.text), provenance.text);

  const experiments = await rest.get("/api/experiments?limit=100");
  const baseline = experiments.experiments.find((e) => e.status === "completed" && e.id !== experimentId);
  if (baseline) {
    const compare = await server.call("compare_experiments", { experiment_ids: [baseline.id, experimentId] });
    show(compare);
    check("compare_experiments succeeded", !compare.isError, compare.text);
  }

  section("inspect and export");
  const image = await server.call("get_sample_image", { experiment_id: experimentId, sample_index: 0 });
  const png = image.content?.find((c) => c.type === "image");
  check("get_sample_image returned a PNG", png !== undefined && Buffer.from(png.data, "base64").subarray(1, 4).toString() === "PNG");

  const sanitized = await server.call("get_sanitized_dataset", { experiment_id: experimentId });
  show(sanitized);
  check("get_sanitized_dataset saved a file", !sanitized.isError, sanitized.text);
  const files = await fs.readdir(outputDir);
  check("exactly one .npz landed in the output directory", files.length === 1 && files[0].endsWith(".npz"), files.join(", "));
  const bytes = await fs.readFile(path.join(outputDir, files[0] ?? ""));
  check("the export is a ZIP (.npz) archive", bytes.readUInt32LE(0) === 0x04034b50);

  const again = await server.call("get_sanitized_dataset", { experiment_id: experimentId });
  check("a second export refuses to overwrite", again.isError === true && /already exists/.test(again.text));
} catch (err) {
  check(`unexpected failure: ${err.message}`, false);
  if (process.env.SMOKE_VERBOSE) console.error(err);
} finally {
  section("teardown");
  server?.stop();
  for (const id of created.experiments) await rest?.del(`/api/experiments/${id}`).catch(() => {});
  for (const id of created.configs) await rest?.del(`/api/config/${id}`).catch(() => {});
  await fs.rm(outputDir, { recursive: true, force: true });
}

const failed = failureCount();
console.log(failed === 0 ? "\nWALKTHROUGH PASSED" : `\nWALKTHROUGH FAILED (${failed} check(s))`);
process.exit(failed === 0 ? 0 : 1);
