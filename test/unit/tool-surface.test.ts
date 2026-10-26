import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { zodToJsonSchema } from "zod-to-json-schema";
import "../../src/tools/index.js";
import { ToolRegistry, visibleTools } from "../../src/tools/registry.js";

/** Tools that only read. The protocol defaults readOnlyHint to false and
 * destructiveHint to true, so anything omitted here is advertised to clients
 * as a destructive write and may be gated behind a confirmation prompt. */
const READ_ONLY = new Set([
  "get_dashboard_summary",
  "list_datasets",
  "get_dataset",
  "list_available_attacks",
  "get_default_configuration",
  "get_configuration",
  "list_configurations",
  "list_experiments",
  "get_experiment_status",
  "get_experiment_logs",
  "get_experiment_results",
  "get_provenance_records",
  "compare_experiments",
  "analyze_score_distribution",
  "get_sample_image",
  "get_generation_status",
  "list_pending_datasets",
  "get_system_stats",
]);

describe("tool surface", () => {
  test("every registered tool declares annotations", () => {
    const missing = [...ToolRegistry.values()].filter((t) => t.annotations === undefined);
    assert.deepEqual(missing.map((t) => t.name), []);
  });

  test("read-only tools are flagged read-only and non-destructive", () => {
    for (const tool of ToolRegistry.values()) {
      if (!READ_ONLY.has(tool.name)) continue;
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} should be readOnlyHint:true`);
      assert.notEqual(tool.annotations?.destructiveHint, true, `${tool.name} must not be destructive`);
    }
  });

  test("mutating tools are not flagged read-only", () => {
    for (const tool of ToolRegistry.values()) {
      if (READ_ONLY.has(tool.name)) continue;
      assert.notEqual(tool.annotations?.readOnlyHint, true, `${tool.name} mutates and must not be readOnlyHint:true`);
    }
  });

  test("no tool accepts a password or other raw credential", () => {
    // Tool arguments reach model context, client history, and logs; credentials
    // belong in the server's environment instead.
    for (const tool of ToolRegistry.values()) {
      const schema = JSON.stringify(zodToJsonSchema(tool.schema, { target: "jsonSchema7" }));
      assert.doesNotMatch(schema, /"(password|secret|token|api_key)"/i, `${tool.name} exposes a credential field`);
    }
  });

  test("every tool produces a valid object input schema", () => {
    for (const tool of ToolRegistry.values()) {
      const schema = zodToJsonSchema(tool.schema, { target: "jsonSchema7" }) as { type?: string };
      assert.equal(schema.type, "object", `${tool.name} input schema must be an object`);
    }
  });

  test("admin tools are hidden from tools/list unless POISONDASH_ADMIN is set", () => {
    const visible = new Set(visibleTools().map((t) => t.name));
    for (const name of ["list_pending_datasets", "get_system_stats", "approve_dataset", "reject_dataset"]) {
      assert.ok(ToolRegistry.has(name), `${name} should be registered`);
      assert.equal(visible.has(name), false, `${name} should be gated in this environment`);
    }
    assert.equal(visible.size, ToolRegistry.size - 4);
  });
});

/** Tools that can destroy or replace state a caller may still want. The
 * protocol only treats destructiveHint as meaningful when readOnlyHint is
 * false, and understating it is the dangerous direction: a client may skip a
 * confirmation it should have shown. */
const DESTRUCTIVE = new Set([
  "run_experiment",        // clears results_json, progress and error_message on restart
  "cancel_experiment",
  "cancel_generation",
  "update_configuration",  // replaces field values, and null clears a reference
  "get_sanitized_dataset", // overwrite:true replaces a local file
  "approve_dataset",       // overwrites an existing decision and its reason
  "reject_dataset",
]);

describe("destructive classification", () => {
  test("state-replacing tools are flagged destructive", () => {
    for (const name of DESTRUCTIVE) {
      const tool = ToolRegistry.get(name);
      assert.ok(tool, `${name} should be registered`);
      assert.equal(tool!.annotations?.destructiveHint, true, `${name} should be destructiveHint:true`);
    }
  });

  test("purely additive tools are not flagged destructive", () => {
    for (const name of ["create_experiment", "create_configuration", "start_generation"]) {
      assert.notEqual(
        ToolRegistry.get(name)!.annotations?.destructiveHint,
        true,
        `${name} only creates new rows`
      );
    }
  });

  test("no tool is both read-only and destructive", () => {
    for (const tool of ToolRegistry.values()) {
      if (tool.annotations?.readOnlyHint === true) {
        assert.notEqual(tool.annotations?.destructiveHint, true, `${tool.name} is contradictory`);
      }
    }
  });
});

describe("idempotency classification", () => {
  /** Repeating these rewrites a timestamp or audit column, so a client that
   * treats a retry as free would silently alter history. */
  const NOT_IDEMPOTENT = new Set([
    "approve_dataset",       // _set_approval always rewrites reviewed_by/reviewed_at
    "reject_dataset",
    "update_configuration",  // Configuration.updated_at has onupdate=func.now()
    "create_experiment",
    "create_configuration",
    "start_generation",
    "get_sanitized_dataset",
    "run_experiment",
  ]);

  test("tools whose repeat rewrites state are not flagged idempotent", () => {
    for (const name of NOT_IDEMPOTENT) {
      const tool = ToolRegistry.get(name);
      assert.ok(tool, `${name} should be registered`);
      assert.notEqual(
        tool!.annotations?.idempotentHint,
        true,
        `${name} rewrites state on repeat and must not claim idempotentHint:true`
      );
    }
  });

  test("read-only tools are idempotent", () => {
    for (const tool of ToolRegistry.values()) {
      if (tool.annotations?.readOnlyHint !== true) continue;
      assert.equal(tool.annotations?.idempotentHint, true, `${tool.name} reads only, so repeats are free`);
    }
  });
});
