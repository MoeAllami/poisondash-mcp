import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import "../../src/tools/generation.js";
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

describe("start_generation", () => {
  test("POSTs the full request body with defaults applied", async () => {
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).pathname, "/api/generate");
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body as string);
      assert.equal(body.name, "poisoned-1");
      assert.equal(body.attack_type, "lc");
      assert.equal(body.base_dataset, "cifar10"); // default
      assert.equal(body.poison_ratio, 10); // default
      assert.equal(body.clean_model_id, 8);
      return jsonResponse({ id: 10, name: "poisoned-1", generation_status: "pending" }, 202);
    });

    const tool = ToolRegistry.get("start_generation")!;
    const args = tool.schema.parse({ name: "poisoned-1", attack_type: "lc", clean_model_id: 8 });
    const result = await tool.handler(args);
    assert.match((result.content[0] as { text: string }).text, /dataset #10 "poisoned-1"/);
    assert.match((result.content[0] as { text: string }).text, /get_generation_status/);
  });

  test("rejects an invalid device string via the zod schema", () => {
    const tool = ToolRegistry.get("start_generation")!;
    assert.throws(() =>
      tool.schema.parse({ name: "x", attack_type: "sa", source_class: 1, device: "gpu0" })
    );
  });

  test("rejects an unknown attack_type via the zod schema", () => {
    const tool = ToolRegistry.get("start_generation")!;
    assert.throws(() => tool.schema.parse({ name: "x", attack_type: "bogus" }));
  });
});

describe("get_generation_status", () => {
  test("formats progress and surfaces generation_error", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/generate/10/status");
      return jsonResponse({ id: 10, generation_status: "failed", generation_progress: 40, generation_error: "OOM" });
    });
    const tool = ToolRegistry.get("get_generation_status")!;
    const result = await tool.handler(tool.schema.parse({ dataset_id: 10 }));
    assert.match((result.content[0] as { text: string }).text, /Dataset 10: failed \(40%\) -- OOM/);
  });
});

describe("cancel_generation", () => {
  test("POSTs to the cancel endpoint and returns the backend's detail message", async () => {
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).pathname, "/api/generate/10/cancel");
      assert.equal(init.method, "POST");
      return jsonResponse({ detail: "Cancellation requested" });
    });
    const tool = ToolRegistry.get("cancel_generation")!;
    const result = await tool.handler(tool.schema.parse({ dataset_id: 10 }));
    assert.equal((result.content[0] as { text: string }).text, "Cancellation requested");
  });
});
