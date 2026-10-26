import { config, type ServerConfig } from "./config.js";

/**
 * Token lifecycle for the PoisonDash API.
 *
 * Credentials come from the environment only. POISONDASH_TOKEN and
 * POISONDASH_EMAIL/POISONDASH_PASSWORD are mutually exclusive: a preset token
 * and a login credential can belong to different accounts, and silently
 * swapping one for the other mid-session would let operations continue as a
 * different (possibly more privileged) user after the first token expired.
 * When both are supplied the token wins and the credentials are discarded
 * with a warning, so the session's identity never changes underneath the
 * caller.
 *
 * Refresh policy: tokens expire at ACCESS_TOKEN_EXPIRE_MINUTES (60 min on
 * the backend default). On a 401:
 *   - credentials configured -> re-login once, retry the request once, then
 *     surface the login failure verbatim if that re-login was rejected.
 *   - token-only mode -> cannot refresh; drop the dead token and report that
 *     re-authentication is required. No retry-loop.
 */

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

interface AuthState {
  token: string | undefined;
  email: string | undefined;
  password: string | undefined;
}

/** Exported for tests: applies the token-wins rule to an arbitrary config
 * without needing to reload the frozen config singleton. */
export function resolveInitialState(
  source: Pick<ServerConfig, "token" | "email" | "password">,
  onConflict: (message: string) => void = (m) => console.error(m)
): AuthState {
  const hasCredentials = source.email !== undefined && source.password !== undefined;
  if (source.token !== undefined) {
    if (hasCredentials) {
      onConflict(
        "[poisondash-research] Both POISONDASH_TOKEN and POISONDASH_EMAIL/POISONDASH_PASSWORD are " +
          "set. Using the token; the credentials are ignored so an expiring token cannot silently " +
          "switch the session to a different account. Set only one."
      );
    }
    return { token: source.token, email: undefined, password: undefined };
  }
  return { token: undefined, email: source.email, password: source.password };
}

const state: AuthState = resolveInitialState(config);

/** True once a token is available (preset, or produced by a login). */
export function hasToken(): boolean {
  return state.token !== undefined;
}

/** True if a 401 can be recovered by re-logging in. */
export function canRefresh(): boolean {
  return state.email !== undefined && state.password !== undefined;
}

export function getToken(): string {
  if (state.token === undefined) {
    throw new AuthError(
      "Not authenticated. Set POISONDASH_EMAIL/POISONDASH_PASSWORD or POISONDASH_TOKEN in the " +
        "server's environment and restart it."
    );
  }
  return state.token;
}

/** In-flight login shared by every caller, so a burst of requests that all
 * need a token produces one login rather than one per request. */
let pendingLogin: Promise<string> | null = null;

function loginOnce(): Promise<string> {
  if (pendingLogin === null) {
    pendingLogin = login(state.email as string, state.password as string).finally(() => {
      pendingLogin = null;
    });
  }
  return pendingLogin;
}

/**
 * Token for an outgoing request, logging in on demand if none is held yet.
 *
 * Authentication is deliberately lazy: `initialize` and `tools/list` need no
 * backend at all, so the server must answer them before it has talked to the
 * API. That makes the startup login a warm-up rather than a precondition, and
 * leaves the first tool call responsible for obtaining a token if the warm-up
 * has not finished (or never ran).
 */
export async function ensureToken(): Promise<string> {
  if (state.token !== undefined) {
    return state.token;
  }
  if (!canRefresh()) {
    throw new AuthError(
      "Not authenticated. Set POISONDASH_EMAIL/POISONDASH_PASSWORD or POISONDASH_TOKEN in the " +
        "server's environment and restart it."
    );
  }
  return loginOnce();
}

/**
 * POST /api/auth/login as application/x-www-form-urlencoded (OAuth2
 * password-grant form: the field name is `username`, holding the email).
 * Uses a bare fetch rather than the shared client -- this endpoint doesn't
 * carry a bearer token, and routing it through the client would recreate
 * the very refresh loop this function implements.
 */
export async function login(email: string, password: string): Promise<string> {
  const body = new URLSearchParams();
  body.set("username", email);
  body.set("password", password);

  // The timeout stays armed through the body read, not just the headers: the
  // token payload is small and fully buffered, so a peer that sends headers and
  // then stalls would otherwise block the login forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(`${config.apiUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      const reason =
        (err as Error).name === "AbortError"
          ? `no response within ${config.timeoutMs}ms`
          : (err as Error).message;
      throw new AuthError(`Could not reach PoisonDash API at ${config.apiUrl}: ${reason}`);
    }

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const parsed = (await response.json()) as { detail?: string };
        if (parsed.detail) detail = parsed.detail;
      } catch {
        // response body wasn't JSON -- fall back to statusText
      }
      throw new AuthError(`Login failed (${response.status}): ${detail}`);
    }

    let data: { access_token: string; token_type: string };
    try {
      data = (await response.json()) as { access_token: string; token_type: string };
    } catch (err) {
      // The timer covers the body too, so an abort here means the peer sent
      // headers and then stopped writing.
      throw new AuthError(
        err instanceof Error && err.name === "AbortError"
          ? `Login response from ${config.apiUrl} stalled: no body within ${config.timeoutMs}ms`
          : `Login response from ${config.apiUrl} was not valid JSON: ${(err as Error).message}`
      );
    }
    state.token = data.access_token;
    return data.access_token;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Log in ahead of the first tool call so it doesn't pay the login latency.
 * Runs after the transport is connected, so a slow or unreachable backend
 * delays only the first authenticated call rather than `initialize`.
 */
export async function bootstrapAuth(): Promise<void> {
  if (state.token !== undefined) {
    return;
  }
  if (canRefresh()) {
    try {
      await loginOnce();
    } catch (err) {
      // Don't crash the server over a bad startup login -- surface it lazily
      // when a tool actually needs the token.
      console.error(`[poisondash-research] startup login failed: ${(err as Error).message}`);
    }
    return;
  }
  console.error(
    "[poisondash-research] No POISONDASH_TOKEN or POISONDASH_EMAIL/POISONDASH_PASSWORD set. " +
      "Auth-requiring tools will fail until the server is restarted with credentials."
  );
}

export type RefreshOutcome =
  | { ok: true }
  | { ok: false; reason: "no-credentials" }
  | { ok: false; reason: "rejected"; error: Error };

/**
 * Called by the client on a 401. Either produces a fresh token or clears the
 * dead one so the next call fails fast at `getToken` instead of firing another
 * request that is already known to be unauthorized. The rejection reason is
 * returned rather than collapsed to a boolean: "no credentials configured" and
 * "the configured credentials were refused" need different messages, and the
 * caller cannot tell them apart otherwise.
 */
export async function tryRefresh(): Promise<RefreshOutcome> {
  if (!canRefresh()) {
    state.token = undefined;
    return { ok: false, reason: "no-credentials" };
  }
  try {
    await loginOnce();
    return { ok: true };
  } catch (err) {
    state.token = undefined;
    return { ok: false, reason: "rejected", error: err as Error };
  }
}

/** Test-only: reset module state between unit tests. */
export function __resetAuthStateForTests(overrides: Partial<AuthState> = {}): void {
  state.token = overrides.token;
  state.email = overrides.email;
  state.password = overrides.password;
}
