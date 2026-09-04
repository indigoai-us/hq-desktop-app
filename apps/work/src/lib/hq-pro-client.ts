/**
 * Browser-side hq-pro transport.
 *
 * The web app deliberately obtains the Cognito id_token from its authenticated
 * same-origin session once and keeps it in browser memory so every hq-pro REST
 * and realtime request can go directly to the API. This requires hq-pro CORS
 * to allow this web origin and the Authorization header. The token is never
 * placed in page data, localStorage, or a URL.
 */

const DEV_DEFAULT_API_URL = "https://hqapi.hq.computer";
let configuredHqProApiUrl: string | undefined;

export type HqProFetch = typeof globalThis.fetch;

export interface BrowserTokenProvider {
  getToken(): Promise<string | null>;
  clear(): void;
}

/** Set by a host before the shared browser transport makes its first request. */
export function configureHqProApiUrl(configured: string | undefined): void {
  configuredHqProApiUrl = configured;
}

export function hqProApiUrl(
  configured = configuredHqProApiUrl,
  dev = import.meta.env.DEV,
): string {
  const value = configured?.trim().replace(/\/+$/, "");
  if (value) return value;
  return dev ? DEV_DEFAULT_API_URL : "";
}

/** Preserve the complete browser route when an hq-pro request needs re-login. */
export function redirectToSigninWithCallback(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname.startsWith("/auth/")) return;
  const callback = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(
    `/auth/signin?callbackUrl=${encodeURIComponent(callback || "/")}`,
  );
}

function runtimeFetch(): typeof globalThis.fetch {
  return globalThis.fetch.bind(globalThis);
}

/**
 * Read the current id_token from the authenticated same-origin session.
 * The value lives only in this closure and is cleared after an upstream 401.
 */
export function createBrowserTokenProvider(options: {
  fetchImpl?: typeof globalThis.fetch;
} = {}): BrowserTokenProvider {
  const fetchImpl = options.fetchImpl ?? runtimeFetch();
  let cached: string | null = null;
  let pending: Promise<string | null> | null = null;

  return {
    async getToken(): Promise<string | null> {
      if (cached) return cached;
      if (!pending) {
        pending = fetchImpl("/api/auth/token", {
          credentials: "same-origin",
          cache: "no-store",
        })
          .then(async (res) => {
            if (res.status === 401) {
              return null;
            }
            if (!res.ok) return null;
            const body = (await res.json()) as { idToken?: unknown };
            const idToken =
              typeof body.idToken === "string" ? body.idToken.trim() : "";
            return idToken || null;
          })
          .finally(() => {
            pending = null;
          });
      }
      cached = await pending;
      return cached;
    },
    clear(): void {
      cached = null;
    },
  };
}

function directUrl(input: RequestInfo | URL, baseUrl: string): string {
  if (!baseUrl) {
    throw new Error(
      "PUBLIC_HQ_PRO_API_URL is required outside local development",
    );
  }
  const api = new URL(baseUrl);
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const target = new URL(raw, api);
  if (target.origin !== api.origin) {
    throw new Error("Authenticated hq-pro fetch only permits the configured API origin");
  }
  return target.toString();
}

/**
 * Create a fetch implementation for hq-pro. Paths are intentionally not
 * allowlisted: the browser talks straight to the versioned public API rather
 * than through a second, stale proxy routing table.
 */
export function createHqProFetch(options: {
  baseUrl?: string | (() => string);
  fetchImpl?: typeof globalThis.fetch;
  tokenProvider?: BrowserTokenProvider;
  onUnauthorized?: () => void;
} = {}): HqProFetch {
  const onUnauthorized = options.onUnauthorized ?? redirectToSigninWithCallback;
  const fetchImpl = options.fetchImpl ?? runtimeFetch();
  const tokenProvider =
    options.tokenProvider ?? createBrowserTokenProvider({ fetchImpl });

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let target: string | null = null;
    const requestWithCurrentToken = async (): Promise<Response | null> => {
      const token = await tokenProvider.getToken();
      if (!token) return null;
      target ??= directUrl(
        input,
        typeof options.baseUrl === "function"
          ? options.baseUrl()
          : (options.baseUrl ?? hqProApiUrl()),
      );
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set("authorization", `Bearer ${token}`);
      return fetchImpl(target, {
        ...init,
        headers,
        // The Cognito session belongs to the web origin; hq-pro receives only
        // its explicit Bearer and must satisfy the configured CORS policy.
        credentials: "omit",
      });
    };

    const response = await requestWithCurrentToken();
    if (!response) {
      onUnauthorized();
      return new Response(
        JSON.stringify({ error: "Unauthenticated", code: "UNAUTHENTICATED" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    if (response.status !== 401) return response;

    // A 401 can be an expired id token while the same-origin refresh cookie is
    // still valid. Clear once, obtain a fresh token, and retry this request
    // exactly once before falling back to the normal sign-in flow.
    tokenProvider.clear();
    const retry = await requestWithCurrentToken();
    if (retry && retry.status !== 401) return retry;

    onUnauthorized();
    if (retry) {
      return retry;
    }
    return new Response(
      JSON.stringify({ error: "Unauthenticated", code: "UNAUTHENTICATED" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  };
}

/** Shared app transport; its default API URL is resolved at request time. */
export const hqProFetch = createHqProFetch();
