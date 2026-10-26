import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ToolRegistry, registerTool, textResult, errorResult } from "../../src/tools/registry.js";

describe("ToolRegistry", () => {
  test("registerTool adds an entry retrievable by name", () => {
    registerTool({
      name: "unit_test_tool_a",
      description: "A test tool",
      schema: z.object({ x: z.number() }),
      handler: async (args) => textResult(`x=${args.x}`),
    });

    const tool = ToolRegistry.get("unit_test_tool_a");
    assert.ok(tool);
    assert.equal(tool!.name, "unit_test_tool_a");
  });

  test("registering the same tool name twice throws", () => {
    registerTool({
      name: "unit_test_tool_b",
      description: "first",
      schema: z.object({}),
      handler: async () => textResult("ok"),
    });

    assert.throws(
      () =>
        registerTool({
          name: "unit_test_tool_b",
          description: "second",
          schema: z.object({}),
          handler: async () => textResult("ok"),
        }),
      /Duplicate tool registration/
    );
  });

  test("enabled() gates visibility but the tool remains callable when found by name", () => {
    registerTool({
      name: "unit_test_tool_gated",
      description: "gated tool",
      schema: z.object({}),
      enabled: () => false,
      handler: async () => textResult("ok"),
    });

    const tool = ToolRegistry.get("unit_test_tool_gated");
    assert.ok(tool);
    assert.equal(tool!.enabled?.(), false);
  });
});

describe("textResult / errorResult", () => {
  test("textResult produces a single text content block with no isError", () => {
    const result = textResult("hello");
    assert.deepEqual(result, { content: [{ type: "text", text: "hello" }] });
  });

  test("errorResult sets isError true", () => {
    const result = errorResult("boom");
    assert.deepEqual(result, { content: [{ type: "text", text: "boom" }], isError: true });
  });
});
