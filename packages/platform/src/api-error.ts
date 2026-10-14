/**
 * One place that turns an HQ API failure into product copy (QA-080).
 *
 * Transport errors from the Rust HTTP client arrive as text like
 * `Network error: error sending request for url (https://hqapi…/v1/…)`. That
 * text belongs in the log, never on screen. `friendlyApiError` classifies a
 * failure into one of four plain sentences, logs the raw text through
 * `console.error` (the desktop log sink), and passes through server sentences
 * that are already written for people (plan limits, validation messages).
 */

export const API_ERROR_COPY = {
  offline: "Couldn't reach HQ. Check your connection and try again.",
  server: "HQ is having trouble right now. Try again in a minute.",
  signedOut: "You're signed out. Sign in again.",
  forbidden: "You don't have access to this.",
} as const;

export type ApiErrorKind = keyof typeof API_ERROR_COPY;

interface FailureLike {
  code?: string | null;
  message?: string | null;
  status?: number | null;
}

const TRANSPORT =
  /network error|error sending request|failed to fetch|fetch failed|load failed|timed out|timeout|connection (refused|reset|closed)|dns error|transport error|offline|econn|enotfound/i;
const SIGNED_OUT = /not signed in|signed out|unauthori[sz]ed|token (expired|missing)|no session/i;
const FORBIDDEN = /forbidden|access denied|not a member/i;
const SERVER = /service unavailable|internal server error|bad gateway|gateway timeout|internal error/i;
/** Raw text that must never reach the screen, even when unclassified. */
const RAW_LEAK = /https?:\/\/|\b(GET|POST|PUT|PATCH|DELETE) \/|reqwest|hyper::|\bstatus=\d/i;

function statusOf(input: FailureLike): number | null {
  if (typeof input.status === "number") return input.status;
  const match = /^http-(\d{3})$/.exec(input.code ?? "");
  return match ? Number(match[1]) : null;
}

function normalize(input: unknown): FailureLike {
  if (typeof input === "string") return { message: input };
  if (input instanceof Error) return { message: input.message };
  if (input && typeof input === "object") return input as FailureLike;
  return {};
}

/** Classify a failure; null means the message is safe to show as-is. */
export function classifyApiError(input: unknown): ApiErrorKind | null {
  const failure = normalize(input);
  const message = failure.message ?? "";
  const status = statusOf(failure);
  if (status === 401 || SIGNED_OUT.test(message)) return "signedOut";
  if (status === 403 || FORBIDDEN.test(message)) return "forbidden";
  if ((status !== null && status >= 500) || SERVER.test(message)) return "server";
  if (failure.code === "network" || TRANSPORT.test(message)) return "offline";
  if (RAW_LEAK.test(message)) return "server";
  return null;
}

/**
 * Plain-language sentence for an API failure. The raw text is logged, never
 * dropped. `fallback` is used when there is no message at all.
 */
export function friendlyApiError(
  input: unknown,
  fallback: string = API_ERROR_COPY.server,
  context = "hq-api",
): string {
  const failure = normalize(input);
  const raw = (failure.message ?? "").trim();
  const kind = classifyApiError(failure);
  if (kind || raw) {
    console.error(`[${context}] api error`, {
      code: failure.code ?? null,
      status: statusOf(failure),
      message: raw,
    });
  }
  if (kind) return API_ERROR_COPY[kind];
  return raw || fallback;
}

/**
 * Adapter-level scrub for hq-pro calls: transport failures and 5xx responses
 * become plain copy at the source, so no surface can render the raw text.
 * 4xx refusals keep the server's sentence (plan limits, validation), which
 * callers inspect and render on purpose.
 */
export function scrubTransportFailure<
  F extends { ok: false; code?: string; message?: string },
>(failure: F, context = "hq-api"): F {
  const status = statusOf(failure);
  if (status !== null && status < 500) return failure;
  const kind = classifyApiError(failure);
  if (kind !== "offline" && kind !== "server") return failure;
  return {
    ...failure,
    code: kind === "offline" ? "network" : failure.code,
    message: friendlyApiError(failure, API_ERROR_COPY[kind], context),
  };
}
