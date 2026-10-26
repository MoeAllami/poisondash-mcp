import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import "../../src/tools/dashboard.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { __resetAuthStateForTests } from "../../src/auth.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const STORAGE_INFO = {
  used_bytes: 4096,
  cap_bytes: 5_000_000_000,
  remaining_bytes: 4_999_995_904,
  user_used_bytes: 1024,
  user_quota_bytes: 1_000_000_000,
  user_remaining_bytes: 999_998_976,
};

/** Routes the two calls get_dashboard_summary makes, so a test can vary the
 * summary payload without restating the storage response every time. */
function routeDashboard(summary: unknown, storage: unknown = STORAGE_INFO) {
  return async (url: string) => {
    const { pathname } = new URL(url);
    if (pathname === "/api/dashboard/summary") return jsonResponse(summary);
    if (pathname === "/api/datasets/storage/info") return jsonResponse(storage);
    throw new Error(`unexpected request: ${pathname}`);
  };
}

let fetchMock: ReturnType<typeof mock.fn>;

beforeEach(() => {
  __resetAuthStateForTests({ token: "tok" });
  fetchMock = mock.method(globalThis, "fetch");
});

afterEach(() => {
  mock.restoreAll();
});

describe("get_dashboard_summary", () => {
  test("formats counts, both storage scopes, and the latest analysis", async () => {
    fetchMock.mock.mockImplementation(
      routeDashboard({
        total_datasets: 3,
        total_models: 1,
        total_experiments: 2,
        recent_datasets: [{ id: 7, name: "suspect.npz", type: "dataset", approval_status: "pending" }],
        recent_experiments: [{ id: 5, name: "exp A", status: "completed" }],
        storage_used_bytes: 4096,
        storage_cap_bytes: 5_000_000_000,
        latest_analysis: {
          status: "completed",
          clean_count: 15,
          suspect_count: 20,
          poisoned_count: 4,
          total_samples: 35,
          avg_score: 0.31,
          score_distribution: [1, 2, 3],
          last_run: "2026-07-31T00:00:00",
        },
      })
    );

    const tool = ToolRegistry.get("get_dashboard_summary")!;
    const result = await tool.handler({});
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Datasets: 3 \| Models: 1 \| Experiments: 2/);
    assert.match(text, /#7 suspect\.npz/);
    assert.match(text, /#5 exp A \(completed\)/);
    assert.match(text, /Avg score: 0\.310/);
    assert.equal(fetchMock.mock.callCount(), 2);
  });

  test("scores against the suspect set, not suspect + clean", async () => {
    // summary.total_samples is suspect_count + clean_count. Using it as the
    // denominator understates the detection rate and double-counts the clean
    // reference set that is reported separately on the next line.
    fetchMock.mock.mockImplementation(
      routeDashboard({
        total_datasets: 0,
        total_models: 0,
        total_experiments: 1,
        recent_datasets: [],
        recent_experiments: [],
        storage_used_bytes: 0,
        storage_cap_bytes: 5_000_000_000,
        latest_analysis: {
          status: "completed",
          clean_count: 5000,
          suspect_count: 5000,
          poisoned_count: 500,
          total_samples: 10000,
          avg_score: 0.42,
          score_distribution: [],
          last_run: null,
        },
      })
    );

    const tool = ToolRegistry.get("get_dashboard_summary")!;
    const text = ((await tool.handler({})).content[0] as { text: string }).text;
    assert.match(text, /Poisoned: 500\/5000 suspect samples/);
    assert.match(text, /detection rate 10\.0%/);
    assert.match(text, /Clean reference set: 5000/);
    assert.doesNotMatch(text, /500\/10000/);
  });

  test("reports the caller's own storage separately from the installation total", async () => {
    // /api/dashboard/summary's storage_used_bytes comes from the global
    // get_storage_usage(), so it cannot answer "how much have I used".
    fetchMock.mock.mockImplementation(
      routeDashboard(
        {
          total_datasets: 0,
          total_models: 0,
          total_experiments: 0,
          recent_datasets: [],
          recent_experiments: [],
          storage_used_bytes: 3_000_000_000,
          storage_cap_bytes: 5_000_000_000,
          latest_analysis: null,
        },
        {
          used_bytes: 3_000_000_000,
          cap_bytes: 5_000_000_000,
          remaining_bytes: 2_000_000_000,
          user_used_bytes: 12_000_000,
          user_quota_bytes: 1_000_000_000,
          user_remaining_bytes: 988_000_000,
        }
      )
    );

    const tool = ToolRegistry.get("get_dashboard_summary")!;
    const text = ((await tool.handler({})).content[0] as { text: string }).text;
    assert.match(text, /Your storage: 11\.4 MB \/ 953\.7 MB/);
    assert.match(text, /Installation storage \(all users\): 2\.8 GB \/ 4\.7 GB/);
  });

  test("handles latest_analysis: null without crashing", async () => {
    fetchMock.mock.mockImplementation(
      routeDashboard({
        total_datasets: 0,
        total_models: 0,
        total_experiments: 0,
        recent_datasets: [],
        recent_experiments: [],
        storage_used_bytes: 0,
        storage_cap_bytes: 5_000_000_000,
        latest_analysis: null,
      })
    );

    const tool = ToolRegistry.get("get_dashboard_summary")!;
    const result = await tool.handler({});
    assert.match((result.content[0] as { text: string }).text, /No completed\/running analysis yet/);
  });
});
