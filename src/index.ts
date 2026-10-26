#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";

import { bootstrapAuth, hasToken, AuthError } from "./auth.js";
import { ApiError } from "./client.js";
import "./tools/index.js";
import { ToolRegistry, visibleTools } from "./tools/registry.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// stdout is the MCP protocol channel -- every log line must go to stderr.
function log(message: string): void {
  console.error(`[poisondash-research] ${message}`);
}

async function main(): Promise<void> {
  const server = new Server(
    { name: "poisondash-research-pipeline", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = visibleTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.schema, { target: "jsonSchema7" }),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = ToolRegistry.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    let args: Record<string, unknown>;
    try {
      args = tool.schema.parse(request.params.arguments ?? {});
    } catch (err) {
      return {
        content: [{ type: "text", text: `Invalid arguments for ${tool.name}: ${(err as Error).message}` }],
        isError: true,
      };
    }

    try {
      return (await tool.handler(args)) as CallToolResult;
    } catch (err) {
      // Every handler failure is caught here so a bad request or a backend
      // hiccup surfaces as a tool error instead of crashing the process.
      if (err instanceof AuthError) {
        return {
          content: [{ type: "text", text: `Authentication error: ${err.message}` }],
          isError: true,
        };
      }
      if (err instanceof ApiError) {
        return {
          content: [{ type: "text", text: `${tool.name} failed: ${err.message}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `${tool.name} failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready with ${visibleTools().length} tool(s) exposed of ${ToolRegistry.size} registered`);

  // Deliberately after connect(): the startup login is a latency optimisation,
  // not a precondition. Awaiting it first would let an unreachable backend
  // stall `initialize` and `tools/list`, which need no backend at all.
  await bootstrapAuth();
  if (hasToken()) {
    log("authenticated; tokens refresh automatically on expiry");
  }
}

main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
