import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import "../../src/tools/configuration.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { __resetAuthStateForTests } from "../../src/auth.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const SAMPLE_CONFIG = {
  id: 7,
  created_by: 4,
  created_at: "2026-07-31T00:00:00",
  updated_at: "2026-07-31T00:00:00",
  name: "MCP test config",
  dataset_id: 7,
  clean_dataset_id: 8,
  model_id: null,
  dataset_name: "suspect.npz",
  clean_dataset_name: "clean.npz",
  model_architecture: null,
  training_setting: null,
  batch_size: 32,
  total_epochs: 5,
  batch_level_epochs: 10,
  batch_level_start_epoch: 0,
  sample_level_epochs: 5,
  sample_level_start_epoch: 5,
  threshold_method: "kmeans",
  poisoning_threshold: 0.5,
  phase_i_zscore: 1.0,
  phase_ii_feature_importance: 0.0001,
  learning_rate: 0.01,
  optimizer: "SGD",
  momentum: 0.9,
  weight_decay: 0.0005,
  nesterov: false,
  lr_schedule: "150,180",
  lr_gamma: 0.1,
  target_class: 0,
  n_groups: 5,
  cv_model: "RandomForest",
  scoring_k: 50,
  confidence_threshold: 0.7,
  seed: 545,
  device: "cpu",
  num_workers: 0,
};

let fetchMock: ReturnType<typeof mock.fn>;

beforeEach(() => {
  __resetAuthStateForTests({ token: "tok" });
  fetchMock = mock.method(globalThis, "fetch");
});

afterEach(() => {
  mock.restoreAll();
});

describe("get_default_configuration", () => {
  test("hits GET /api/config/defaults", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/config/defaults");
      return jsonResponse({ ...SAMPLE_CONFIG, id: 0, dataset_id: null, clean_dataset_id: null, dataset_name: null, clean_dataset_name: null });
    });
    const tool = ToolRegistry.get("get_default_configuration")!;
    const result = await tool.handler(tool.schema.parse({}));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /#0 "MCP test config"/);
    // No dataset/clean_dataset set -> the not-runnable warning must fire.
    assert.match(text, /WARNING: a runnable config needs BOTH/);
  });
});

describe("list_configurations", () => {
  test("lists configs and does not warn when both dataset ids are set", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/api/config");
      assert.equal(parsed.searchParams.get("limit"), "20");
      return jsonResponse({ configurations: [SAMPLE_CONFIG], total: 1 });
    });
    const tool = ToolRegistry.get("list_configurations")!;
    const result = await tool.handler(tool.schema.parse({}));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /#7 "MCP test config"/);
    assert.match(text, /dataset_id=7 \(suspect\.npz\)/);
    assert.match(text, /clean_dataset_id=8 \(clean\.npz\)/);
    assert.doesNotMatch(text, /WARNING/);
  });

  test("empty list reports the total without rows", async () => {
    fetchMock.mock.mockImplementation(async () => jsonResponse({ configurations: [], total: 0 }));
    const tool = ToolRegistry.get("list_configurations")!;
    const result = await tool.handler(tool.schema.parse({}));
    assert.match((result.content[0] as { text: string }).text, /No configurations found/);
  });
});

describe("get_configuration", () => {
  test("hits GET /api/config/{id} and shows the phase epoch counts", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/config/7");
      return jsonResponse(SAMPLE_CONFIG);
    });
    const tool = ToolRegistry.get("get_configuration")!;
    const result = await tool.handler(tool.schema.parse({ config_id: 7 }));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /#7 "MCP test config"/);
    // Experiment results report these as 0, so this tool is the only place
    // the real values are visible.
    assert.match(text, /batch_level_epochs=10, batch_level_start_epoch=0/);
    assert.match(text, /sample_level_epochs=5, sample_level_start_epoch=5/);
  });

  test("config_id 0 is routed to the defaults endpoint, not a row lookup", async () => {
    // Id 0 is a virtual template; GET /api/config/0 looks for a stored row
    // with that id and 404s.
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/config/defaults");
      return jsonResponse({ ...SAMPLE_CONFIG, id: 0 });
    });
    const tool = ToolRegistry.get("get_configuration")!;
    const result = await tool.handler(tool.schema.parse({ config_id: 0 }));
    assert.match((result.content[0] as { text: string }).text, /^#0 /);
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  test("every field update_configuration can set is visible in the output", async () => {
    // A partial view would let an agent write a value it can never read back,
    // so it could neither verify its own update nor report what a run used.
    fetchMock.mock.mockImplementation(async () => jsonResponse(SAMPLE_CONFIG));
    const tool = ToolRegistry.get("get_configuration")!;
    const text = (
      (await tool.handler(tool.schema.parse({ config_id: 7 }))).content[0] as { text: string }
    ).text;

    const updatable = Object.keys(ToolRegistry.get("update_configuration")!.schema.shape).filter(
      (k) => k !== "config_id" && k !== "name"
    );
    const missing = updatable.filter((field) => !text.includes(`${field}=`));
    assert.deepEqual(missing, [], `not shown by get_configuration: ${missing.join(", ")}`);
  });
});

describe("create_configuration", () => {
  test("sends only what the caller passed, leaving defaults to the backend", async () => {
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).pathname, "/api/config");
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body as string);
      // Mirroring the backend's ~25 defaults client-side would silently pin
      // them to whatever they were when this file was written.
      assert.deepEqual(Object.keys(body).sort(), ["clean_dataset_id", "dataset_id"]);
      assert.equal(body.dataset_id, 7);
      assert.equal(body.clean_dataset_id, 8);
      return jsonResponse(SAMPLE_CONFIG);
    });
    const tool = ToolRegistry.get("create_configuration")!;
    const args = tool.schema.parse({ dataset_id: 7, clean_dataset_id: 8 });
    const result = await tool.handler(args);
    assert.match((result.content[0] as { text: string }).text, /Created configuration:/);
  });

  test("still forwards an explicitly-passed value", async () => {
    fetchMock.mock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      assert.equal(body.batch_size, 64);
      assert.equal(body.optimizer, "AdamW");
      return jsonResponse(SAMPLE_CONFIG);
    });
    const tool = ToolRegistry.get("create_configuration")!;
    await tool.handler(tool.schema.parse({ batch_size: 64, optimizer: "AdamW" }));
  });
});

describe("update_configuration", () => {
  test("only sends explicitly-passed fields (exclude_unset semantics)", async () => {
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).pathname, "/api/config/7");
      assert.equal(init.method, "PUT");
      const body = JSON.parse(init.body as string);
      assert.deepEqual(Object.keys(body), ["threshold_method"]);
      assert.equal(body.threshold_method, "gaussian");
      return jsonResponse({ ...SAMPLE_CONFIG, threshold_method: "gaussian" });
    });
    const tool = ToolRegistry.get("update_configuration")!;
    const args = tool.schema.parse({ config_id: 7, threshold_method: "gaussian" });
    const result = await tool.handler(args);
    assert.match((result.content[0] as { text: string }).text, /gaussian/);
  });

  test("an explicit null clears a reference instead of being dropped", async () => {
    // JSON.stringify drops undefined but keeps null, which is what lets the
    // backend's exclude_unset PUT distinguish "unchanged" from "detach".
    fetchMock.mock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      assert.deepEqual(Object.keys(body).sort(), ["clean_dataset_id", "model_id"]);
      assert.equal(body.model_id, null);
      assert.equal(body.clean_dataset_id, 9);
      return jsonResponse({ ...SAMPLE_CONFIG, model_id: null, clean_dataset_id: 9 });
    });
    const tool = ToolRegistry.get("update_configuration")!;
    const args = tool.schema.parse({ config_id: 7, model_id: null, clean_dataset_id: 9 });
    await tool.handler(args);
  });
});
