import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import "../../src/tools/experiments.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { __resetAuthStateForTests } from "../../src/auth.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof mock.fn>;

beforeEach(() => {
  __resetAuthStateForTests({ token: "tok" });
  fetchMock = mock.method(globalThis, "fetch");
});

afterEach(() => {
  mock.restoreAll();
});

describe("create_experiment", () => {
  test("POSTs name/configuration_id/description and reports the next step", async () => {
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).pathname, "/api/experiments");
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body as string);
      assert.equal(body.configuration_id, 7);
      return jsonResponse({ id: 9, name: "exp new", status: "pending" });
    });
    const tool = ToolRegistry.get("create_experiment")!;
    const result = await tool.handler(tool.schema.parse({ name: "exp new", configuration_id: 7 }));
    assert.match((result.content[0] as { text: string }).text, /Created experiment #9 "exp new"/);
    assert.match((result.content[0] as { text: string }).text, /run_experiment/);
  });
});

describe("run_experiment", () => {
  test("POSTs to /run and points at get_experiment_status", async () => {
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).pathname, "/api/experiments/9/run");
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify({ detail: "Pipeline started", experiment_id: 9 }), { status: 202 });
    });
    const tool = ToolRegistry.get("run_experiment")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 9 }));
    assert.match((result.content[0] as { text: string }).text, /Pipeline started for experiment 9/);
  });
});

describe("cancel_experiment", () => {
  test("POSTs to /cancel and returns the backend's detail", async () => {
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).pathname, "/api/experiments/9/cancel");
      assert.equal(init.method, "POST");
      return jsonResponse({ detail: "Cancellation requested" });
    });
    const tool = ToolRegistry.get("cancel_experiment")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 9 }));
    assert.equal((result.content[0] as { text: string }).text, "Cancellation requested");
  });
});

describe("list_experiments", () => {
  test("lists rows with status/progress", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/experiments");
      return jsonResponse({
        experiments: [
          { id: 5, name: "exp A", status: "completed", progress: 100, configuration_id: 7, error_message: null },
        ],
        total: 1,
      });
    });
    const tool = ToolRegistry.get("list_experiments")!;
    const result = await tool.handler(tool.schema.parse({}));
    assert.match((result.content[0] as { text: string }).text, /#5 "exp A" -- completed \(100%\)/);
  });
});

describe("get_experiment_status", () => {
  test("formats a running experiment", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/experiments/5/status");
      return jsonResponse({ id: 5, status: "running", progress: 73, error_message: null });
    });
    const tool = ToolRegistry.get("get_experiment_status")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 5 }));
    assert.equal((result.content[0] as { text: string }).text, "Experiment 5: running (73%)");
  });

  test("surfaces error_message for a failed experiment", async () => {
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({ id: 7, status: "failed", progress: 30, error_message: "RuntimeError: oom" })
    );
    const tool = ToolRegistry.get("get_experiment_status")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 7 }));
    assert.match((result.content[0] as { text: string }).text, /failed: RuntimeError: oom/);
  });
});

describe("get_experiment_logs", () => {
  test("passes since as a query param by default", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/api/experiments/5/logs");
      assert.equal(parsed.searchParams.get("since"), "10");
      return jsonResponse({
        lines: [{ seq: 11, ts: 1.0, stream: "stdout", text: "hello" }],
        next_cursor: 11,
        active: true,
        complete: false,
      });
    });
    const tool = ToolRegistry.get("get_experiment_logs")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 5, since: 10 }));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /active=true complete=false next_cursor=11/);
    assert.match(text, /\[stdout\] hello/);
  });

  test("tail_lines fetches from since=0 and slices client-side", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("since"), "0");
      return jsonResponse({
        lines: [1, 2, 3, 4, 5].map((n) => ({ seq: n, ts: 0, stream: "stdout", text: `line${n}` })),
        next_cursor: 5,
        active: false,
        complete: true,
      });
    });
    const tool = ToolRegistry.get("get_experiment_logs")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 5, since: 999, tail_lines: 2 }));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /line4/);
    assert.match(text, /line5/);
    assert.doesNotMatch(text, /line3/);
  });

  test("empty line set reports no new log lines", async () => {
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({ lines: [], next_cursor: 5, active: false, complete: true })
    );
    const tool = ToolRegistry.get("get_experiment_logs")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 5, since: 5 }));
    assert.match((result.content[0] as { text: string }).text, /no new log lines/);
  });
});

describe("get_experiment_results", () => {
  test("formats the summary and omits per-sample scores by default", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/experiments/5/results");
      return jsonResponse({
        id: 5,
        status: "completed",
        results_json: JSON.stringify({
          summary: { status: "completed", suspect_count: 2, poisoned_count: 1, avg_score: 0.5, clean_count: 1 },
          total_scored_samples: 2,
          per_sample_scores: [
            { sample_index: 0, score: 0.9, predicted_poisoned: true },
            { sample_index: 1, score: 0.1, predicted_poisoned: false },
          ],
        }),
        provenance_records: [],
      });
    });
    const tool = ToolRegistry.get("get_experiment_results")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 5 }));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Experiment #5 \(status: completed\)/);
    assert.doesNotMatch(text, /Per-sample scores/);
  });

  test("include_per_sample_scores=true lists the raw scores", async () => {
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({
        id: 5,
        status: "completed",
        results_json: JSON.stringify({
          summary: { status: "completed" },
          per_sample_scores: [{ sample_index: 0, score: 0.9, predicted_poisoned: true }],
        }),
        provenance_records: [],
      })
    );
    const tool = ToolRegistry.get("get_experiment_results")!;
    const result = await tool.handler(
      tool.schema.parse({ experiment_id: 5, include_per_sample_scores: true })
    );
    assert.match((result.content[0] as { text: string }).text, /\[0\] score=0\.900 poisoned=true/);
  });
});

describe("get_provenance_records", () => {
  test("summarizes batch/sample/scoring provenance types", async () => {
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({
        id: 5,
        status: "completed",
        results_json: "{}",
        provenance_records: [
          {
            id: 1,
            experiment_id: 5,
            provenance_type: "batch",
            data_json: JSON.stringify({ num_important: 12, phase_i_zscore: 1.0 }),
            important_features: JSON.stringify([0, 1, 2]),
            created_at: "2026-07-31T00:00:00",
          },
          {
            id: 2,
            experiment_id: 5,
            provenance_type: "scoring",
            data_json: JSON.stringify({ threshold: 0.5, num_poisoned: 4, num_clean: 16 }),
            important_features: null,
            created_at: "2026-07-31T00:00:01",
          },
        ],
      })
    );
    const tool = ToolRegistry.get("get_provenance_records")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 5 }));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /\[batch\]/);
    assert.match(text, /num_important: 12/);
    assert.match(text, /important_features: 3 indices/);
    assert.match(text, /\[scoring\]/);
    assert.match(text, /threshold: 0\.5/);
  });

  test("no records yet is handled gracefully", async () => {
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({ id: 9, status: "pending", results_json: null, provenance_records: [] })
    );
    const tool = ToolRegistry.get("get_provenance_records")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 9 }));
    assert.match((result.content[0] as { text: string }).text, /no provenance records yet/);
  });
});

describe("compare_experiments", () => {
  test("fetches name (from /experiments/{id}) and metrics (from /results) for each id in parallel", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/experiments/5") {
        return jsonResponse({ id: 5, name: "exp A", configuration_id: 7, status: "completed", progress: 100, created_by: 4 });
      }
      if (parsed.pathname === "/api/experiments/5/results") {
        return jsonResponse({
          id: 5,
          status: "completed",
          results_json: JSON.stringify({
            summary: { poisoned_count: 4, suspect_count: 20, avg_score: 0.31, threshold: 0.5 },
            total_scored_samples: 20,
            metadata: { dataset_name: "suspect.npz", threshold_method: "kmeans", runtime_seconds: 42.7 },
          }),
          provenance_records: [],
        });
      }
      if (parsed.pathname === "/api/experiments/6") {
        return jsonResponse({ id: 6, name: "exp B", configuration_id: 7, status: "completed", progress: 100, created_by: 4 });
      }
      if (parsed.pathname === "/api/experiments/6/results") {
        return jsonResponse({
          id: 6,
          status: "completed",
          results_json: JSON.stringify({
            summary: { poisoned_count: 7, suspect_count: 20, avg_score: 0.42, threshold: 0.5 },
            total_scored_samples: 20,
            metadata: { dataset_name: "suspect.npz", threshold_method: "kmeans", runtime_seconds: 39.1 },
          }),
          provenance_records: [],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const tool = ToolRegistry.get("compare_experiments")!;
    const result = await tool.handler(tool.schema.parse({ experiment_ids: [5, 6] }));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /#5 \| exp A \| suspect\.npz \| kmeans \| 0\.50 \| 4\/20 \| 0\.310 \| 42\.7/);
    assert.match(text, /#6 \| exp B \| suspect\.npz \| kmeans \| 0\.50 \| 7\/20 \| 0\.420 \| 39\.1/);
    // 8 fetches: 2 ids x (experiment + results).
    assert.equal(fetchMock.mock.callCount(), 4);
  });
});
