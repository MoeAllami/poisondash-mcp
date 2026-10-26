import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { apiFetch, apiFetchRaw, ApiError } from "../../src/client.js";
import { AuthError, __resetAuthStateForTests } from "../../src/auth.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

let fetchMock: ReturnType<typeof mock.fn>;

beforeEach(() => {
  fetchMock = mock.method(globalThis, "fetch");
});

afterEach(() => {
  mock.restoreAll();
});

describe("apiFetch happy path", () => {
  test("resolves the URL, attaches the bearer token, and parses JSON", async () => {
    __resetAuthStateForTests({ token: "tok-1" });
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      assert.equal(url, "http://localhost:8321/api/dashboard/summary");
      assert.equal((init.headers as Record<string, string>)["Authorization"], "Bearer tok-1");
      return jsonResponse(200, { total_datasets: 3 });
    });

    const result = await apiFetch<{ total_datasets: number }>("/api/dashboard/summary");
    assert.equal(result.total_datasets, 3);
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  test("appends query params and skips undefined values", async () => {
    __resetAuthStateForTests({ token: "tok-1" });
    fetchMock.mock.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("skip"), "0");
      assert.equal(parsed.searchParams.get("limit"), "20");
      assert.equal(parsed.searchParams.has("type"), false);
      return jsonResponse(200, { datasets: [], total: 0 });
    });

    await apiFetch("/api/datasets", { query: { skip: 0, limit: 20, type: undefined } });
  });

  test("JSON-encodes the request body and sets Content-Type", async () => {
    __resetAuthStateForTests({ token: "tok-1" });
    fetchMock.mock.mockImplementation(async (_url: string, init: RequestInit) => {
      assert.equal((init.headers as Record<string, string>)["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(init.body as string), { name: "exp-1" });
      return jsonResponse(201, { id: 1, name: "exp-1" });
    });

    await apiFetch("/api/experiments", { method: "POST", body: { name: "exp-1" } });
  });

  test("returns undefined for a 204 No Content response", async () => {
    __resetAuthStateForTests({ token: "tok-1" });
    fetchMock.mock.mockImplementation(async () => new Response(null, { status: 204 }));
    const result = await apiFetch("/api/auth/change-password", { method: "POST" });
    assert.equal(result, undefined);
  });
});

describe("apiFetch error handling", () => {
  test("throws ApiError with the parsed detail on a non-2xx JSON response", async () => {
    __resetAuthStateForTests({ token: "tok-1" });
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse(404, { detail: "Dataset not found" })
    );

    await assert.rejects(
      () => apiFetch("/api/datasets/999"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 404);
        assert.match((err as Error).message, /Dataset not found/);
        return true;
      }
    );
  });

  test("falls back to raw text when the error body isn't JSON", async () => {
    __resetAuthStateForTests({ token: "tok-1" });
    fetchMock.mock.mockImplementation(
      async () => new Response("upstream exploded", { status: 500 })
    );

    await assert.rejects(
      () => apiFetch("/api/experiments/1/run", { method: "POST" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        // The body must be read exactly once: attempting json() first consumes
        // the stream, so a text() fallback afterwards can only ever fail and
        // the message silently loses everything the backend said.
        assert.equal((err as ApiError).detail, "upstream exploded");
        assert.match((err as Error).message, /upstream exploded/);
        return true;
      }
    );
  });

  test("renders a 422 validation body instead of [object Object]", async () => {
    __resetAuthStateForTests({ token: "tok-1" });
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse(422, { detail: [{ loc: ["body", "seed"], msg: "input should be less than 2147483648" }] })
    );

    await assert.rejects(
      () => apiFetch("/api/config", { method: "POST", body: {} }),
      (err: unknown) => {
        assert.match((err as Error).message, /input should be less than 2147483648/);
        assert.doesNotMatch((err as Error).message, /\[object Object\]/);
        return true;
      }
    );
  });

  test("an empty error body still produces a usable message", async () => {
    __resetAuthStateForTests({ token: "tok-1" });
    fetchMock.mock.mockImplementation(async () => new Response(null, { status: 502, statusText: "Bad Gateway" }));

    await assert.rejects(
      () => apiFetch("/api/dashboard/summary"),
      (err: unknown) => {
        assert.match((err as Error).message, /API error 502: Bad Gateway/);
        return true;
      }
    );
  });
});

describe("buildUrl", () => {
  test("preserves a path prefix on the configured base URL", async () => {
    // A base of https://host/poisondash must not be flattened to
    // https://host/api/... -- new URL("/api/x", base) would do exactly that.
    const previous = process.env.POISONDASH_API_URL;
    process.env.POISONDASH_API_URL = "https://example.test/poisondash/";
    try {
      const { loadConfig } = await import("../../src/config.js");
      const reloaded = loadConfig();
      assert.equal(reloaded.apiUrl, "https://example.test/poisondash");
    } finally {
      if (previous === undefined) delete process.env.POISONDASH_API_URL;
      else process.env.POISONDASH_API_URL = previous;
    }
  });
});

describe("apiFetch 401 refresh policy", () => {
  test("with credentials retained: re-logs in once and retries the request", async () => {
    __resetAuthStateForTests({ token: "stale", email: "a@b.com", password: "pw" });
    let call = 0;
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      call += 1;
      if (call === 1) {
        assert.equal((init.headers as Record<string, string>)["Authorization"], "Bearer stale");
        return jsonResponse(401, { detail: "Could not validate credentials" });
      }
      if (call === 2) {
        assert.equal(url, "http://localhost:8321/api/auth/login");
        return jsonResponse(200, { access_token: "renewed", token_type: "bearer" });
      }
      assert.equal((init.headers as Record<string, string>)["Authorization"], "Bearer renewed");
      return jsonResponse(200, { ok: true });
    });

    const result = await apiFetch<{ ok: boolean }>("/api/dashboard/summary");
    assert.equal(result.ok, true);
    assert.equal(fetchMock.mock.callCount(), 3);
  });

  test("token-only mode: throws AuthError immediately without retry-looping", async () => {
    __resetAuthStateForTests({ token: "stale" });
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse(401, { detail: "Could not validate credentials" })
    );

    await assert.rejects(
      () => apiFetch("/api/dashboard/summary"),
      (err: unknown) => {
        assert.ok(err instanceof AuthError);
        assert.match((err as Error).message, /no credentials are configured/);
        return true;
      }
    );
    // Exactly one attempt -- no retry loop when refresh is impossible.
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  test("rejected credentials surface the login failure, not 'no credentials'", async () => {
    // Telling someone to set the env vars they already set -- while hiding the
    // real reason -- is the failure mode this asserts against.
    __resetAuthStateForTests({ token: "stale", email: "a@b.com", password: "rotated" });
    fetchMock.mock.mockImplementation(async (url: string) =>
      String(url).includes("/api/auth/login")
        ? jsonResponse(401, { detail: "Incorrect email or password" })
        : jsonResponse(401, { detail: "Could not validate credentials" })
    );

    await assert.rejects(
      () => apiFetch("/api/dashboard/summary"),
      (err: unknown) => {
        assert.ok(err instanceof AuthError);
        assert.match((err as Error).message, /re-authentication was rejected/);
        assert.match((err as Error).message, /Incorrect email or password/);
        assert.doesNotMatch((err as Error).message, /no credentials are configured/);
        return true;
      }
    );
  });
});

describe("apiFetchRaw", () => {
  test("returns the raw Response so headers can be read (sanitized-dataset use case)", async () => {
    __resetAuthStateForTests({ token: "tok-1" });
    fetchMock.mock.mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "X-Original-Sample-Count": "100",
            "X-Removed-Sample-Count": "4",
            "X-Kept-Sample-Count": "96",
            "X-Threshold": "0.5",
          },
        })
    );

    const response = await apiFetchRaw("/api/experiments/1/sanitized-dataset");
    assert.equal(response.headers.get("X-Kept-Sample-Count"), "96");
    const buf = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...buf], [1, 2, 3]);
  });
});
