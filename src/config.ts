import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Environment-driven configuration for the server.
 *
 * Every backend endpoint requires a valid token (enforced by the backend's
 * auth dependency) -- there is no anonymous access. This module
 * never throws on missing or malformed auth config: the server still starts,
 * and auth-requiring tools surface a clear error at call time instead. That
 * keeps `tools/list` usable even before credentials are wired up.
 */

const DEFAULT_API_URL = "http://localhost:8321";
const DEFAULT_TIMEOUT_MS = 60_000;

function warn(message: string): void {
  console.error(`[poisondash-research] ${message}`);
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * A base URL may carry a path prefix (e.g. behind a reverse proxy at
 * `https://host/poisondash`). `buildUrl` concatenates rather than resolving
 * against a base, so the prefix survives; all this needs to do is reject a
 * value that isn't a usable absolute http(s) URL.
 */
function resolveApiUrl(): string {
  const raw = process.env.POISONDASH_API_URL?.trim();
  if (!raw) {
    return DEFAULT_API_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    warn(`POISONDASH_API_URL is not a valid URL (${raw}); falling back to ${DEFAULT_API_URL}.`);
    return DEFAULT_API_URL;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    warn(
      `POISONDASH_API_URL must be http or https (got ${parsed.protocol}); falling back to ${DEFAULT_API_URL}.`
    );
    return DEFAULT_API_URL;
  }
  if (parsed.search || parsed.hash) {
    warn("POISONDASH_API_URL query string and fragment are ignored.");
  }
  return trimTrailingSlash(`${parsed.origin}${parsed.pathname}`);
}

function resolvePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(`${name} must be a positive number of milliseconds (got ${raw}); using ${fallback}.`);
    return fallback;
  }
  return Math.floor(parsed);
}

function resolveOutputDir(): string {
  const explicit = process.env.POISONDASH_OUTPUT_DIR;
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(explicit);
  }
  // Prefer the user's Downloads folder; fall back to the OS temp dir when it
  // doesn't exist (minimal containers, CI) rather than creating a stray
  // Downloads tree somewhere it doesn't belong.
  const downloads = path.join(os.homedir(), "Downloads");
  try {
    if (fs.statSync(downloads).isDirectory()) {
      return downloads;
    }
  } catch {
    // Missing or unreadable -- fall through to the temp dir.
  }
  return path.join(os.tmpdir(), "poisondash");
}

export interface ServerConfig {
  apiUrl: string;
  email: string | undefined;
  password: string | undefined;
  token: string | undefined;
  adminToolsEnabled: boolean;
  outputDir: string;
  /** Milliseconds to wait for response headers before aborting a request. */
  timeoutMs: number;
}

/** Exported (in addition to the `config` singleton below) so tests can
 * recompute configuration after mutating process.env without needing to
 * bust the module cache. */
export function loadConfig(): ServerConfig {
  return Object.freeze({
    apiUrl: resolveApiUrl(),
    email: process.env.POISONDASH_EMAIL?.trim() || undefined,
    password: process.env.POISONDASH_PASSWORD || undefined,
    token: process.env.POISONDASH_TOKEN?.trim() || undefined,
    // Cosmetic tool-visibility gate only -- see src/tools/admin.ts. Real
    // authority always comes from the logged-in user's role; a non-admin
    // token still gets 403 from the backend regardless of this flag.
    adminToolsEnabled: (process.env.POISONDASH_ADMIN || "false").toLowerCase() === "true",
    outputDir: resolveOutputDir(),
    timeoutMs: resolvePositiveInt("POISONDASH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  });
}

export const config: ServerConfig = loadConfig();
