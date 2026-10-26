import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

// config.ts is a frozen singleton read at import time, so the short timeout has
// to be in place before any src/ module loads -- hence the deferred imports.
process.env.POISONDASH_TIMEOUT_MS = "150";

const { config } = await import("../../src/config.js");
const { apiFetch, apiFetchRaw } = await import("../../src/client.js");
const { AuthError, login, __resetAuthStateForTests } = await import("../../src/auth.js");

assert.equal(config.timeoutMs, 150, "test setup must shorten the request timeout");

/**
 * A response whose headers have arrived but whose body never completes, wired
 * to the caller's abort signal the way a real stalled peer behaves. Without
 * this the mock would resolve instantly and the timeout path would never run.
 */
function stalledBody(signal: AbortSignal | undefined, init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Emit a byte so the response is unmistakably "open", then never finish.
      controller.enqueue(new TextEncoder().encode("{"));
      signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        controller.error(err);
      });
    },
  });
  return new Response(body, init);
}

let fetchMock: ReturnType<typeof mock.fn>;

beforeEach(() => {
  __resetAuthStateForTests({ token: "tok" });
  fetchMock = mock.method(globalThis, "fetch");
});

afterEach(() => {
  mock.restoreAll();
});

describe("body-stall timeouts", () => {
  test("a successful JSON response whose body stalls fails with a timeout", async () => {
    fetchMock.mock.mockImplementation(async (_url: string, init: RequestInit) =>
      stalledBody(init.signal ?? undefined, { status: 200 })
    );

    await assert.rejects(
      () => apiFetch("/api/dashboard/summary"),
      (err: unknown) => {
        assert.match((err as Error).message, /body did not complete within 150ms/);
        // Not a bare DOMException: the caller should be told what stalled.
        assert.notEqual((err as Error).name, "AbortError");
        return true;
      }
    );
  });

  test("an error response whose body stalls fails with a timeout", async () => {
    fetchMock.mock.mockImplementation(async (_url: string, init: RequestInit) =>
      stalledBody(init.signal ?? undefined, { status: 500 })
    );

    await assert.rejects(
      () => apiFetch("/api/experiments/1/run", { method: "POST" }),
      /body did not complete within 150ms/
    );
  });

  test("a stalled error body on the raw download endpoint does not hang", async () => {
    // This path releases the timer early on success so a multi-gigabyte export
    // isn't cut off -- but a non-2xx body is read here, so it must stay timed.
    fetchMock.mock.mockImplementation(async (_url: string, init: RequestInit) =>
      stalledBody(init.signal ?? undefined, { status: 400 })
    );

    await assert.rejects(
      () => apiFetchRaw("/api/experiments/1/sanitized-dataset"),
      /body did not complete within 150ms/
    );
  });

  test("a stalled login body fails with a clear AuthError", async () => {
    __resetAuthStateForTests();
    fetchMock.mock.mockImplementation(async (_url: string, init: RequestInit) =>
      stalledBody(init.signal ?? undefined, { status: 200 })
    );

    await assert.rejects(
      () => login("a@b.com", "pw"),
      (err: unknown) => {
        assert.ok(err instanceof AuthError);
        assert.match((err as Error).message, /stalled: no body within 150ms/);
        return true;
      }
    );
  });

  test("a successful raw download is NOT capped once headers arrive", async () => {
    // The counterpart guarantee: a slow but healthy export must survive past
    // the timeout, so the timer is released for 2xx on this path only.
    fetchMock.mock.mockImplementation(async (_url: string, init: RequestInit) =>
      stalledBody(init.signal ?? undefined, { status: 200 })
    );

    const response = await apiFetchRaw("/api/experiments/1/sanitized-dataset");
    assert.equal(response.ok, true);
    await new Promise((r) => setTimeout(r, 300)); // well past the 150ms timeout
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    assert.deepEqual([...value!], [..."{"].map((c) => c.charCodeAt(0)));
    await reader.cancel();
  });
});
