import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import "../../src/tools/attacks.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { __resetAuthStateForTests } from "../../src/auth.js";

const ATTACKS = [
  {
    id: "lc",
    name: "Label-Consistent",
    supported_datasets: ["cifar10", "tinyimagenet"],
    requires_source_class: false,
    requires_clean_model: true,
    requires_pregenerated_data: false,
    description: "desc lc",
  },
  {
    id: "sa",
    name: "Sleeper Agent",
    supported_datasets: ["cifar10", "stl10"],
    requires_source_class: true,
    requires_clean_model: false,
    requires_pregenerated_data: true,
    description: "desc sa",
  },
];

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

describe("list_available_attacks", () => {
  test("returns all 4 attacks unfiltered and includes param docs", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/generate/attacks");
      return jsonResponse(ATTACKS);
    });
    const tool = ToolRegistry.get("list_available_attacks")!;
    const result = await tool.handler(tool.schema.parse({}));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /lc -- Label-Consistent/);
    assert.match(text, /sa -- Sleeper Agent/);
    assert.match(text, /Requires: clean_model_id/);
    assert.match(text, /Requires: source_class, pre-generated \.npy files/);
    assert.match(text, /Parameter reference \(client-supplied/);
  });

  test("filters client-side by base_dataset against supported_datasets", async () => {
    fetchMock.mock.mockImplementation(async () => jsonResponse(ATTACKS));
    const tool = ToolRegistry.get("list_available_attacks")!;
    const result = await tool.handler(tool.schema.parse({ base_dataset: "stl10" }));
    const text = (result.content[0] as { text: string }).text;
    assert.doesNotMatch(text, /Label-Consistent/);
    assert.match(text, /Sleeper Agent/);
  });
});
