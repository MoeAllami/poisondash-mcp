#!/usr/bin/env node
/**
 * Unit-test entry point (`npm test`).
 *
 * The file list is built here rather than passed as a shell glob because
 * neither end of that works portably: npm runs scripts through cmd.exe on
 * Windows, which does not expand globs at all, and bash only expands `**`
 * when globstar happens to be enabled. Node's own test runner can't cover
 * for it either -- pointing it at a directory discovers `.js` files only,
 * so every `.test.ts` here would be silently skipped. Enumerating the
 * directory is the one approach that behaves the same everywhere.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const unitDir = path.join(testRoot, "unit");

const files = readdirSync(unitDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(unitDir, name));

if (files.length === 0) {
  console.error(`No unit tests found in ${unitDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  cwd: path.dirname(testRoot),
});

process.exit(result.status ?? 1);
