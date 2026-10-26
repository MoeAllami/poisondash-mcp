import { config } from "./config.js";
import { AuthError, ensureToken, tryRefresh } from "./auth.js";

/** A non-2xx response from the API, carrying the parsed `detail` if present. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown, fallbackMessage: string) {
    super(`API error ${status}: ${describeDetail(detail) ?? fallbackMessage}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** FastAPI reports errors as `{"detail": ...}` where the value is a string for
 * raised HTTPExceptions but an array of per-field objects for 422 validation
 * failures. Stringify anything that isn't already a string so a validation
 * error doesn't render as "[object Object]". */
function describeDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === "string") return detail.length > 0 ? detail : undefined;
  if (typeof detail === "object" && "detail" in (detail as Record<string, unknown>)) {
    const inner = (detail as Record<string, unknown>).detail;
    return typeof inner === "string" ? inner : JSON.stringify(inner);
  }
  return JSON.stringify(detail);
}

export interface ApiFetchOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

function buildUrl(path: string, query?: ApiFetchOptions["query"]): string {
  // Concatenated rather than resolved against a base: `new URL("/api/x", base)`
  // discards any path prefix the base carries, which silently breaks a backend
  // mounted behind a reverse-proxy sub-path.
  const url = new URL(config.apiUrl + (path.startsWith("/") ? path : `/${path}`));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

/**
 * A response plus the disposer for its timeout.
 *
 * The timeout has to outlive the headers for anything whose body we intend to
 * read into memory: a peer that sends headers and then stalls would otherwise
 * hang the call forever. It must *not* outlive the headers for a streamed
 * download, where a slow multi-gigabyte transfer is legitimate. So the timer is
 * released explicitly by whoever knows which case they are in.
 */
interface Attempt {
  response: Response;
  release: () => void;
}

async function doFetch(path: string, options: ApiFetchOptions): Promise<Attempt> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await ensureToken()}` };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const release = () => clearTimeout(timer);

  try {
    const response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? "GET",
      headers,
      body,
      signal: controller.signal,
    });
    return { response, release };
  } catch (err) {
    release();
    const reason =
      (err as Error).name === "AbortError"
        ? `no response within ${config.timeoutMs}ms`
        : (err as Error).message;
    throw new Error(`Could not reach PoisonDash API at ${config.apiUrl}${path}: ${reason}`);
  }
}

/** An abort that fires after headers arrived means the body stalled. Say so,
 * rather than surfacing a bare DOMException with no context. */
function describeBodyFailure(err: unknown, path: string): Error {
  if (err instanceof Error && err.name === "AbortError") {
    return new Error(
      `Could not reach PoisonDash API at ${config.apiUrl}${path}: response headers arrived but the ` +
        `body did not complete within ${config.timeoutMs}ms`
    );
  }
  return err as Error;
}

/** One request, retried once through a re-login if the token had expired. */
async function attempt(path: string, options: ApiFetchOptions): Promise<Attempt> {
  const first = await doFetch(path, options);
  if (first.response.status !== 401) {
    return first;
  }
  // Discard the unauthorized body rather than leaving the stream dangling for
  // the duration of the re-login.
  await first.response.body?.cancel().catch(() => {});
  first.release();
  const outcome = await tryRefresh();
  if (!outcome.ok) {
    throw new AuthError(
      outcome.reason === "no-credentials"
        ? "Token expired and no credentials are configured to refresh it. Restart the server " +
          "with POISONDASH_EMAIL/POISONDASH_PASSWORD set."
        : `Token expired and re-authentication was rejected: ${outcome.error.message}`
    );
  }
  return doFetch(path, options);
}

/**
 * Raw fetch variant returning the Response itself -- needed for binary
 * downloads (get_sanitized_dataset) and for reading response headers.
 * On a 401 this attempts one silent re-login/retry under the same refresh
 * policy as apiFetch; callers still need to check `response.ok` themselves.
 *
 * On success the timeout covers the wait for headers only, because the caller
 * streams the body to disk and a large export is expected to take a while.
 * A non-2xx body is a different case -- it is small, this function reads it,
 * and reading it untimed would hang on a peer that sends status headers and
 * then stops writing -- so those are consumed and raised while the timer is
 * still armed.
 */
export async function apiFetchRaw(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { response, release } = await attempt(path, options);
  if (!response.ok) {
    try {
      await throwApiError(response, path);
    } catch (err) {
      throw describeBodyFailure(err, path);
    } finally {
      release();
    }
  }
  release();
  return response;
}

/** Throws a typed ApiError for a non-2xx Response, parsing `detail` if present.
 * Shared by apiFetch and any caller of apiFetchRaw (e.g. get_sanitized_dataset)
 * that needs the same error-shape handling for a binary endpoint. */
export async function throwApiError(response: Response, path = ""): Promise<never> {
  // Read the body exactly once. Calling response.json() first and falling back
  // to response.text() cannot work: a failed json() has already consumed the
  // stream, so the text fallback throws and the body is lost.
  let raw: string;
  try {
    raw = await response.text();
  } catch (err) {
    // A stalled error body is a timeout, not an unreadable payload -- don't
    // disguise it as a detail-less ApiError.
    if (err instanceof Error && err.name === "AbortError") {
      throw describeBodyFailure(err, path);
    }
    throw new ApiError(response.status, undefined, response.statusText);
  }

  let detail: unknown = raw.length > 0 ? raw : undefined;
  if (raw.length > 0) {
    try {
      detail = JSON.parse(raw);
    } catch {
      // Not JSON (a proxy error page, a bare string) -- keep the raw text.
    }
  }
  throw new ApiError(response.status, detail, response.statusText);
}

/**
 * Typed JSON client. Resolves the path against config.apiUrl, attaches the
 * bearer token, JSON-encodes the body, and throws a typed ApiError on any
 * non-2xx response. Handles the 401 refresh-once-then-surface policy.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { response, release } = await attempt(path, options);

  // The timeout stays armed until the body has been consumed. A JSON payload
  // is small and fully buffered, so a peer that sends headers and then stops
  // writing would hang this call indefinitely otherwise.
  try {
    if (!response.ok) {
      await throwApiError(response, path);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (text.length === 0) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  } catch (err) {
    throw describeBodyFailure(err, path);
  } finally {
    release();
  }
}
