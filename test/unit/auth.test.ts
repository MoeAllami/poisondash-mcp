import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  AuthError,
  getToken,
  hasToken,
  canRefresh,
  login,
  bootstrapAuth,
  resolveInitialState,
  tryRefresh,
  __resetAuthStateForTests,
} from "../../src/auth.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof mock.fn>;

beforeEach(() => {
  __resetAuthStateForTests();
  fetchMock = mock.method(globalThis, "fetch");
});

afterEach(() => {
  mock.restoreAll();
});

describe("getToken / hasToken", () => {
  test("throws AuthError when no token is set", () => {
    assert.equal(hasToken(), false);
    assert.throws(() => getToken(), AuthError);
  });

  test("returns the token once set", () => {
    __resetAuthStateForTests({ token: "abc" });
    assert.equal(hasToken(), true);
    assert.equal(getToken(), "abc");
  });
});

describe("login", () => {
  test("posts form-encoded credentials and caches the returned token", async () => {
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      assert.equal(url, "http://localhost:8321/api/auth/login");
      assert.equal(init.method, "POST");
      assert.equal(
        (init.headers as Record<string, string>)["Content-Type"],
        "application/x-www-form-urlencoded"
      );
      const params = new URLSearchParams(init.body as string);
      assert.equal(params.get("username"), "a@b.com");
      assert.equal(params.get("password"), "pw");
      return jsonResponse(200, { access_token: "tok-xyz", token_type: "bearer" });
    });

    const token = await login("a@b.com", "pw");
    assert.equal(token, "tok-xyz");
    assert.equal(getToken(), "tok-xyz");
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  test("throws AuthError with the backend detail on a failed login", async () => {
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse(401, { detail: "Incorrect email or password" })
    );

    await assert.rejects(
      () => login("a@b.com", "wrong"),
      (err: unknown) => {
        assert.ok(err instanceof AuthError);
        assert.match((err as Error).message, /Incorrect email or password/);
        return true;
      }
    );
  });

  test("wraps network failures in AuthError", async () => {
    fetchMock.mock.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });

    await assert.rejects(() => login("a@b.com", "pw"), AuthError);
  });
});

describe("bootstrapAuth", () => {
  test("does nothing (no fetch) when POISONDASH_TOKEN is already set", async () => {
    __resetAuthStateForTests({ token: "preset-token" });
    await bootstrapAuth();
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(getToken(), "preset-token");
  });

  test("logs in immediately when credentials are set and no token is present", async () => {
    __resetAuthStateForTests({ email: "a@b.com", password: "pw" });
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse(200, { access_token: "fresh-token", token_type: "bearer" })
    );
    await bootstrapAuth();
    assert.equal(getToken(), "fresh-token");
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  test("does not throw when neither token nor credentials are set", async () => {
    __resetAuthStateForTests();
    await assert.doesNotReject(() => bootstrapAuth());
    assert.equal(hasToken(), false);
  });

  test("swallows a failed startup login rather than crashing", async () => {
    __resetAuthStateForTests({ email: "a@b.com", password: "wrong" });
    fetchMock.mock.mockImplementation(async () => jsonResponse(401, { detail: "nope" }));
    await assert.doesNotReject(() => bootstrapAuth());
    assert.equal(hasToken(), false);
  });
});

describe("resolveInitialState (token vs credentials)", () => {
  test("credentials alone are retained for refresh", () => {
    const state = resolveInitialState({ token: undefined, email: "a@b.com", password: "pw" });
    assert.deepEqual(state, { token: undefined, email: "a@b.com", password: "pw" });
  });

  test("a token alone is used with no refresh credentials", () => {
    const state = resolveInitialState({ token: "tok", email: undefined, password: undefined });
    assert.deepEqual(state, { token: "tok", email: undefined, password: undefined });
  });

  test("token wins over credentials and the credentials are discarded", () => {
    // Retaining both would let an expiring token silently hand the session to
    // whichever account the credentials belong to.
    const warnings: string[] = [];
    const state = resolveInitialState(
      { token: "tok", email: "someone-else@b.com", password: "pw" },
      (m) => warnings.push(m)
    );
    assert.equal(state.token, "tok");
    assert.equal(state.email, undefined);
    assert.equal(state.password, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Set only one/);
  });

  test("no warning is emitted when only one mechanism is configured", () => {
    const warnings: string[] = [];
    resolveInitialState({ token: "tok", email: undefined, password: undefined }, (m) => warnings.push(m));
    resolveInitialState({ token: undefined, email: "a@b.com", password: "pw" }, (m) => warnings.push(m));
    assert.equal(warnings.length, 0);
  });
});

describe("canRefresh / tryRefresh", () => {
  test("tryRefresh re-logs in and updates the token when credentials are configured", async () => {
    __resetAuthStateForTests({ token: "stale", email: "a@b.com", password: "pw" });
    assert.equal(canRefresh(), true);
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse(200, { access_token: "renewed", token_type: "bearer" })
    );
    const outcome = await tryRefresh();
    assert.deepEqual(outcome, { ok: true });
    assert.equal(getToken(), "renewed");
  });

  test("token-only mode reports no-credentials and drops the dead token", async () => {
    __resetAuthStateForTests({ token: "stale" });
    const outcome = await tryRefresh();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, "no-credentials");
    assert.equal(fetchMock.mock.callCount(), 0);
    // The stale token 401'd, so keeping it would only produce more doomed
    // requests; the next call should fail fast at getToken instead.
    assert.equal(hasToken(), false);
  });

  test("rejected credentials report the underlying login failure", async () => {
    __resetAuthStateForTests({ token: "stale", email: "a@b.com", password: "rotated" });
    fetchMock.mock.mockImplementation(async () =>
      jsonResponse(401, { detail: "Incorrect email or password" })
    );
    const outcome = await tryRefresh();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, "rejected");
    assert.match(
      outcome.ok === false && outcome.reason === "rejected" ? outcome.error.message : "",
      /Incorrect email or password/
    );
    assert.equal(hasToken(), false);
  });
});
