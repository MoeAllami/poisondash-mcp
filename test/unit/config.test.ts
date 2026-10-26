import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";

const ENV_KEYS = [
  "POISONDASH_API_URL",
  "POISONDASH_EMAIL",
  "POISONDASH_PASSWORD",
  "POISONDASH_TOKEN",
  "POISONDASH_ADMIN",
  "POISONDASH_OUTPUT_DIR",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("config", () => {
  test("defaults when nothing is set", () => {
    const cfg = loadConfig();
    assert.equal(cfg.apiUrl, "http://localhost:8321");
    assert.equal(cfg.email, undefined);
    assert.equal(cfg.password, undefined);
    assert.equal(cfg.token, undefined);
    assert.equal(cfg.adminToolsEnabled, false);
    assert.equal(cfg.outputDir, path.join(os.homedir(), "Downloads"));
  });

  test("trims a trailing slash from POISONDASH_API_URL", () => {
    process.env.POISONDASH_API_URL = "http://example.com:9000/";
    const cfg = loadConfig();
    assert.equal(cfg.apiUrl, "http://example.com:9000");
  });

  test("reads credentials and token from env", () => {
    process.env.POISONDASH_EMAIL = "a@b.com";
    process.env.POISONDASH_PASSWORD = "secret";
    process.env.POISONDASH_TOKEN = "tok123";
    const cfg = loadConfig();
    assert.equal(cfg.email, "a@b.com");
    assert.equal(cfg.password, "secret");
    assert.equal(cfg.token, "tok123");
  });

  test("POISONDASH_ADMIN=true enables admin tools, case-insensitively", () => {
    process.env.POISONDASH_ADMIN = "True";
    assert.equal(loadConfig().adminToolsEnabled, true);
  });

  test("POISONDASH_ADMIN unset or anything else disables admin tools", () => {
    process.env.POISONDASH_ADMIN = "yes";
    assert.equal(loadConfig().adminToolsEnabled, false);
  });

  test("POISONDASH_OUTPUT_DIR overrides the default and is resolved to an absolute path", () => {
    process.env.POISONDASH_OUTPUT_DIR = "relative/dir";
    const cfg = loadConfig();
    assert.equal(cfg.outputDir, path.resolve("relative/dir"));
    assert.ok(path.isAbsolute(cfg.outputDir));
  });
});
