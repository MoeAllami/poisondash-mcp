import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import "../../src/tools/analysis.js";
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

describe("analyze_score_distribution", () => {
  test("computes mean/median/std/quartiles and cutoff counts", async () => {
    const scores = [0.1, 0.2, 0.3, 0.6, 0.9];
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({
        id: 5,
        status: "completed",
        results_json: JSON.stringify({
          summary: { threshold: 0.5 },
          per_sample_scores: scores.map((s, i) => ({ sample_index: i, score: s, predicted_poisoned: s >= 0.5 })),
        }),
        provenance_records: [],
      })
    );
    const tool = ToolRegistry.get("analyze_score_distribution")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 5 }));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /5 suspect samples scored/);
    assert.match(text, /Mean: 0\.4200/);
    assert.match(text, />= 0\.5 \(stored threshold\): 2 \(40\.0%\)/);
  });

  test("an explicit threshold argument overrides the stored one and is labeled 'requested'", async () => {
    const scores = [0.1, 0.9];
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({
        id: 5,
        status: "completed",
        results_json: JSON.stringify({
          summary: { threshold: 0.5 },
          per_sample_scores: scores.map((s, i) => ({ sample_index: i, score: s, predicted_poisoned: false })),
        }),
        provenance_records: [],
      })
    );
    const tool = ToolRegistry.get("analyze_score_distribution")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 5, threshold: 0.8 }));
    assert.match((result.content[0] as { text: string }).text, />= 0\.8 \(requested threshold\): 1 \(50\.0%\)/);
  });

  test("no per-sample scores returns an isError result instead of throwing", async () => {
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse({ id: 9, status: "failed", results_json: JSON.stringify({ summary: { status: "failed" } }), provenance_records: [] })
    );
    const tool = ToolRegistry.get("analyze_score_distribution")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 9 }));
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /no per-sample scores/);
  });
});
