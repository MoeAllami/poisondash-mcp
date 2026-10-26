import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import "../../src/tools/datasets.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { __resetAuthStateForTests } from "../../src/auth.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof mock.fn>;

beforeEach(() => {
  __resetAuthStateForTests({ token: "tok" });
  fetchMock = mock.method(globalThis, "fetch");
});

afterEach(() => {
  mock.restoreAll();
});

describe("list_datasets", () => {
  test("passes type/skip/limit as query params and lists rows", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/api/datasets");
      assert.equal(parsed.searchParams.get("type"), "dataset");
      assert.equal(parsed.searchParams.get("limit"), "20");
      assert.equal(parsed.searchParams.get("skip"), "0");
      return jsonResponse({
        datasets: [
          {
            id: 7,
            name: "suspect.npz",
            type: "dataset",
            file_size_bytes: 4490,
            approval_status: "pending",
            attack_type: null,
            base_dataset: null,
            poison_ratio: null,
            created_at: "2026-07-31T00:00:00",
          },
        ],
        total: 1,
      });
    });

    const tool = ToolRegistry.get("list_datasets")!;
    const args = tool.schema.parse({ type: "dataset" });
    const result = await tool.handler(args);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /#7 suspect\.npz \[dataset\]/);
    assert.match(text, /pending/);
  });

  test("reports an empty result set without listing rows", async () => {
    fetchMock.mock.mockImplementation(async () => jsonResponse({ datasets: [], total: 0 }));
    const tool = ToolRegistry.get("list_datasets")!;
    const result = await tool.handler(tool.schema.parse({}));
    assert.match((result.content[0] as { text: string }).text, /No datasets\/models found/);
  });
});

describe("get_dataset", () => {
  test("formats generation status and moderation state", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/datasets/7");
      return jsonResponse({
        id: 7,
        name: "suspect.npz",
        type: "dataset",
        file_size_bytes: 4490,
        description: "test",
        approval_status: "approved",
        approval_reason: null,
        attack_type: "lc",
        base_dataset: "cifar10",
        poison_ratio: 10.0,
        generation_status: "completed",
        generation_progress: 100,
        generation_error: null,
        created_at: "2026-07-31T00:00:00",
      });
    });

    const tool = ToolRegistry.get("get_dataset")!;
    const result = await tool.handler(tool.schema.parse({ dataset_id: 7 }));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /#7 suspect\.npz \[dataset\]/);
    assert.match(text, /Approval: approved/);
    assert.match(text, /Attack: lc/);
    assert.match(text, /Generation: completed \(100%\)/);
  });

  test("propagates a 404 as an ApiError (surfaced by index.ts, not swallowed here)", async () => {
    fetchMock.mock.mockImplementation(async () => jsonResponse({ detail: "Dataset not found" }, 404));
    const tool = ToolRegistry.get("get_dataset")!;
    await assert.rejects(() => tool.handler(tool.schema.parse({ dataset_id: 999 })));
  });
});
