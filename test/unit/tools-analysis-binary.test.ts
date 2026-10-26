import { test, describe, beforeEach, afterEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

// src/config.ts is a frozen singleton evaluated at import time and its default
// output directory is the user's real Downloads folder. Static imports are
// hoisted above any assignment, so every src/ import below is deferred until
// after POISONDASH_OUTPUT_DIR points somewhere disposable.
const SCRATCH_OUTPUT_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), "poisondash-mcp-out-"));
process.env.POISONDASH_OUTPUT_DIR = SCRATCH_OUTPUT_DIR;

const { config } = await import("../../src/config.js");
const { resolveOutputPath } = await import("../../src/tools/analysis.js");
const { ToolRegistry } = await import("../../src/tools/registry.js");
const { __resetAuthStateForTests } = await import("../../src/auth.js");

assert.equal(config.outputDir, SCRATCH_OUTPUT_DIR, "test setup must not target the real Downloads folder");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Directory symlinks need elevation on Windows; junctions do not. */
function linkDirectory(target: string, linkPath: string): boolean {
  try {
    fsSync.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

let fetchMock: ReturnType<typeof mock.fn>;

beforeEach(() => {
  __resetAuthStateForTests({ token: "tok" });
  fetchMock = mock.method(globalThis, "fetch");
});

afterEach(() => {
  mock.restoreAll();
});

after(async () => {
  await fs.rm(SCRATCH_OUTPUT_DIR, { recursive: true, force: true });
});

describe("resolveOutputPath (path-traversal guard)", () => {
  const base = path.join(os.tmpdir(), "poisondash-mcp-test-base");

  test("defaults to <base>/<defaultName> when no output_path is given", async () => {
    const resolved = await resolveOutputPath(base, undefined, "default.npz");
    assert.equal(resolved, path.join(await fs.realpath(base), "default.npz"));
  });

  test("a plain relative filename resolves inside base", async () => {
    const resolved = await resolveOutputPath(base, "mine.npz", "default.npz");
    assert.equal(resolved, path.join(await fs.realpath(base), "mine.npz"));
  });

  test("a relative subdirectory resolves inside base", async () => {
    const resolved = await resolveOutputPath(base, "subdir/mine.npz", "default.npz");
    assert.equal(resolved, path.join(await fs.realpath(base), "subdir", "mine.npz"));
  });

  test("an absolute path inside base is allowed", async () => {
    await fs.mkdir(base, { recursive: true });
    const inside = path.join(await fs.realpath(base), "abs.npz");
    const resolved = await resolveOutputPath(base, inside, "default.npz");
    assert.equal(resolved, inside);
  });

  test("'../' traversal escaping base throws", async () => {
    await assert.rejects(
      () => resolveOutputPath(base, "../../etc/passwd", "default.npz"),
      /escap|outside/i
    );
  });

  test("an absolute path outside base throws", async () => {
    const outside = path.join(os.tmpdir(), "poisondash-mcp-test-OUTSIDE", "evil.npz");
    await assert.rejects(() => resolveOutputPath(base, outside, "default.npz"), /escap|outside/i);
  });

  test("output_path equal to base itself (no filename) throws", async () => {
    await assert.rejects(() => resolveOutputPath(base, ".", "default.npz"));
  });

  test("a symlinked directory inside base cannot be used to escape it", async (t) => {
    // The lexical check passes here -- "link/x.npz" contains no "..", and
    // resolves under base as a string -- so only a realpath-based containment
    // check catches it.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "poisondash-mcp-link-"));
    const linkBase = path.join(root, "outdir");
    const outside = path.join(root, "OUTSIDE");
    await fs.mkdir(linkBase);
    await fs.mkdir(outside);

    if (!linkDirectory(outside, path.join(linkBase, "escape"))) {
      t.skip("filesystem links not permitted in this environment");
      return;
    }

    await assert.rejects(
      () => resolveOutputPath(linkBase, "escape/proof.npz", "default.npz"),
      /escap|outside/i
    );
    assert.equal(fsSync.existsSync(path.join(outside, "proof.npz")), false);
    await fs.rm(root, { recursive: true, force: true });
  });

  test("a symlink whose target is inside base is still allowed", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "poisondash-mcp-link-ok-"));
    const linkBase = path.join(root, "outdir");
    const real = path.join(linkBase, "real");
    await fs.mkdir(real, { recursive: true });

    if (!linkDirectory(real, path.join(linkBase, "alias"))) {
      t.skip("filesystem links not permitted in this environment");
      return;
    }

    const resolved = await resolveOutputPath(linkBase, "alias/ok.npz", "default.npz");
    assert.equal(resolved, path.join(await fs.realpath(real), "ok.npz"));
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("get_sample_image", () => {
  test("wraps the base64 PNG in an image content block alongside a text block", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/experiments/5/sample/3");
      return jsonResponse({ image: "iVBORw0KGgo=", sample_index: 3, width: 32, height: 32 });
    });
    const tool = ToolRegistry.get("get_sample_image")!;
    const result = await tool.handler(tool.schema.parse({ experiment_id: 5, sample_index: 3 }));
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, "text");
    assert.match((result.content[0] as { text: string }).text, /Sample 3 \(32x32\)/);
    assert.equal(result.content[1].type, "image");
    assert.equal((result.content[1] as { data: string }).data, "iVBORw0KGgo=");
    assert.equal((result.content[1] as { mimeType: string }).mimeType, "image/png");
  });
});

describe("get_sanitized_dataset", () => {
  test("refuses to overwrite an existing file without overwrite:true", async () => {
    const filename = `mcp-test-existing-${process.pid}.npz`;
    const destination = path.join(config.outputDir, filename);
    await fs.writeFile(destination, "already here");

    try {
      fetchMock.mock.mockImplementation(async () => {
        throw new Error("fetch should not be called when the overwrite guard trips first");
      });
      const tool = ToolRegistry.get("get_sanitized_dataset")!;
      const result = await tool.handler(tool.schema.parse({ experiment_id: 5, output_path: filename }));
      assert.equal(result.isError, true);
      assert.match((result.content[0] as { text: string }).text, /already exists/);
      // The guard is an exclusive create, so the original content must survive.
      assert.equal(await fs.readFile(destination, "utf8"), "already here");
    } finally {
      await fs.unlink(destination).catch(() => {});
    }
  });

  test("overwrite:true replaces an existing file", async () => {
    const filename = `mcp-test-replace-${process.pid}.npz`;
    const destination = path.join(config.outputDir, filename);
    await fs.writeFile(destination, "stale content");

    try {
      fetchMock.mock.mockImplementation(
        async () => new Response(new TextEncoder().encode("fresh-npz"), { status: 200 })
      );
      const tool = ToolRegistry.get("get_sanitized_dataset")!;
      const result = await tool.handler(
        tool.schema.parse({ experiment_id: 5, output_path: filename, overwrite: true })
      );
      assert.notEqual(result.isError, true);
      assert.equal(await fs.readFile(destination, "utf8"), "fresh-npz");
    } finally {
      await fs.unlink(destination).catch(() => {});
    }
  });

  test("end-to-end: downloads, writes the file under config.outputDir, and reports counts", async () => {
    const filename = `mcp-test-write-${process.pid}.npz`;
    const destination = path.join(config.outputDir, filename);
    const original = new TextEncoder().encode("fake-npz-bytes");

    try {
      fetchMock.mock.mockImplementation(async (url: string) => {
        const parsed = new URL(url);
        assert.equal(parsed.pathname, "/api/experiments/5/sanitized-dataset");
        return new Response(original, {
          status: 200,
          headers: {
            "X-Original-Sample-Count": "20",
            "X-Removed-Sample-Count": "4",
            "X-Kept-Sample-Count": "16",
            "X-Threshold": "0.5",
          },
        });
      });

      const tool = ToolRegistry.get("get_sanitized_dataset")!;
      const result = await tool.handler(tool.schema.parse({ experiment_id: 5, output_path: filename }));
      const text = (result.content[0] as { text: string }).text;
      assert.match(text, new RegExp(`Saved sanitized dataset to .*${filename}`));
      assert.match(text, /Original samples: 20/);
      assert.match(text, /Removed \(score >= threshold\): 4/);
      assert.match(text, /Kept: 16/);
      assert.match(text, /Effective threshold: 0\.5/);

      const written = await fs.readFile(destination);
      assert.deepEqual([...written], [...original]);
    } finally {
      await fs.unlink(destination).catch(() => {});
    }
  });

  test("streams a body larger than one chunk without truncating it", async () => {
    const filename = `mcp-test-stream-${process.pid}.npz`;
    const destination = path.join(config.outputDir, filename);
    // Several MB delivered as many chunks: exercises the streaming path rather
    // than a single in-memory buffer.
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const chunkCount = 64;

    try {
      fetchMock.mock.mockImplementation(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < chunkCount; i += 1) controller.enqueue(chunk);
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      });

      const tool = ToolRegistry.get("get_sanitized_dataset")!;
      const result = await tool.handler(tool.schema.parse({ experiment_id: 5, output_path: filename }));
      assert.notEqual(result.isError, true);

      const stat = await fs.stat(destination);
      assert.equal(stat.size, chunk.length * chunkCount);
      assert.match((result.content[0] as { text: string }).text, new RegExp(`${stat.size} bytes`));
    } finally {
      await fs.unlink(destination).catch(() => {});
    }
  });

  test("a 400 from the backend (not completed / no scores) surfaces as an ApiError", async () => {
    fetchMock.mock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ detail: "Experiment has no per-sample scores to sanitize against" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
    );
    const filename = `mcp-test-fail-${process.pid}.npz`;

    const tool = ToolRegistry.get("get_sanitized_dataset")!;
    await assert.rejects(() => tool.handler(tool.schema.parse({ experiment_id: 5, output_path: filename })));

    // Neither the reservation nor a partial file may be left behind on failure.
    await assert.rejects(() => fs.access(path.join(config.outputDir, filename)));
    await assert.rejects(() => fs.access(path.join(config.outputDir, `${filename}.part`)));
  });
});

describe("temporary file handling", () => {
  test("does not write through a pre-existing file at a predictable temp name", async () => {
    // The temp file used to be `${destination}.part` opened with "w". That
    // follows symlinks on POSIX, so anything able to pre-create that name as a
    // link had the download written through to the link's target -- outside the
    // directory the path guard had just confirmed -- and the rename then left
    // the destination as that link. A randomised name created with "wx"
    // (O_CREAT|O_EXCL) refuses to follow a link and fails if the name exists.
    const filename = `mcp-test-part-${process.pid}.npz`;
    const destination = path.join(config.outputDir, filename);
    const decoy = `${destination}.part`;
    await fs.writeFile(decoy, "PRE-EXISTING");

    try {
      fetchMock.mock.mockImplementation(
        async () => new Response(new TextEncoder().encode("payload"), { status: 200 })
      );
      const tool = ToolRegistry.get("get_sanitized_dataset")!;
      const result = await tool.handler(tool.schema.parse({ experiment_id: 5, output_path: filename }));
      assert.notEqual(result.isError, true, (result.content[0] as { text: string }).text);

      // The decoy is untouched, and the download landed at the destination.
      assert.equal(await fs.readFile(decoy, "utf8"), "PRE-EXISTING");
      assert.equal(await fs.readFile(destination, "utf8"), "payload");
    } finally {
      await fs.unlink(decoy).catch(() => {});
      await fs.unlink(destination).catch(() => {});
    }
  });

  test("leaves no temporary file behind on success", async () => {
    const filename = `mcp-test-clean-${process.pid}.npz`;
    try {
      fetchMock.mock.mockImplementation(
        async () => new Response(new TextEncoder().encode("payload"), { status: 200 })
      );
      const tool = ToolRegistry.get("get_sanitized_dataset")!;
      await tool.handler(tool.schema.parse({ experiment_id: 5, output_path: filename }));
      const strays = (await fs.readdir(config.outputDir)).filter((f) => f.endsWith(".part"));
      assert.deepEqual(strays, []);
    } finally {
      await fs.unlink(path.join(config.outputDir, filename)).catch(() => {});
    }
  });
});
