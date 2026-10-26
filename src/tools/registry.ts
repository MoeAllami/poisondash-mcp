import type { ZodObject, ZodRawShape } from "zod";

/**
 * Content block a tool handler can return. Mirrors the subset of the MCP
 * `CallToolResult.content` union this server actually produces: text and
 * base64-embedded images (see get_sample_image).
 */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolCallResult {
  content: ToolContent[];
  isError?: boolean;
}

/**
 * Behavioural hints published in `tools/list`. These matter because of how the
 * protocol defines the absent case: `readOnlyHint` defaults to false and
 * `destructiveHint` defaults to true, so a tool that ships no annotations is
 * advertised as a destructive write. Every read-only tool here sets
 * readOnlyHint so clients don't gate a plain listing behind a write
 * confirmation.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  schema: ZodObject<Shape>;
  annotations?: ToolAnnotations;
  /** Only registered (visible in tools/list) when this returns true. Defaults to always-visible. */
  enabled?: () => boolean;
  handler: (args: Record<string, unknown>) => Promise<ToolCallResult>;
}

/** Global map every tool module self-registers into on import. */
export const ToolRegistry = new Map<string, ToolDefinition>();

export function registerTool<Shape extends ZodRawShape>(def: ToolDefinition<Shape>): void {
  if (ToolRegistry.has(def.name)) {
    throw new Error(`Duplicate tool registration: ${def.name}`);
  }
  ToolRegistry.set(def.name, def as ToolDefinition);
}

/** Tools currently exposed to clients, i.e. minus any whose gate is closed. */
export function visibleTools(): ToolDefinition[] {
  return [...ToolRegistry.values()].filter((tool) => (tool.enabled ? tool.enabled() : true));
}

export function textResult(text: string): ToolCallResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): ToolCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
