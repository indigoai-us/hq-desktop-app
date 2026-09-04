/**
 * Content-Security-Policy for the web shell (US-006).
 *
 * Set from hooks.server.ts on every response. The critical, easy-to-lose
 * grant is `connect-src wss://*.amazonaws.com`: CSP scheme matching only
 * widens `http:` to `https:`, never `https:` to `wss:`, so without an
 * explicit wss source the browser refuses the MQTT-over-WebSocket socket to
 * the AWS IoT ATS endpoint and realtime silently degrades (see the
 * hq-console post-mortem the csp-realtime-wss test was ported from). The
 * grant stays scoped to AWS — never a blanket `wss:`. Web hq-pro REST is
 * direct, so connect-src also permits the configured public API origin.
 */

import { env } from "$env/dynamic/public";

const COGNITO_HOSTED_UI =
  "https://vault-indigo-hq-prod.auth.us-east-1.amazoncognito.com";
const COGNITO_IDP = "https://cognito-idp.us-east-1.amazonaws.com";
const COGNITO_IDENTITY = "https://cognito-identity.us-east-1.amazonaws.com";
const DEV_DEFAULT_API_URL = "https://hqapi.hq.computer";

export function hqProConnectOrigin(
  configured = env.PUBLIC_HQ_PRO_API_URL,
  dev = import.meta.env.DEV,
): string | null {
  const value = configured?.trim() || (dev ? DEV_DEFAULT_API_URL : "");
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Build the production CSP header value. */
export function buildCsp(apiUrl?: string): string {
  const hqProOrigin = hqProConnectOrigin(apiUrl);
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // SvelteKit hydrates via an inline init script; 'unsafe-inline' keeps the
    // shell functional without per-response nonce plumbing.
    "script-src": ["'self'", "'unsafe-inline'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    // blob: is the composer’s local image thumb. https: is the same grant
    // desktop uses so vault/S3 attachment previews render in the shared
    // message component.
    "img-src": ["'self'", "data:", "blob:", "https:"],
    // PDF iframe preview of a presigned vault object.
    "frame-src": ["'self'", "blob:", "https:"],
    "object-src": ["'self'", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      ...(hqProOrigin ? [hqProOrigin] : []),
      // MQTT-over-WebSocket to the AWS IoT ATS endpoint. CSP host patterns
      // allow only a leading wildcard, so this is the tightest expression
      // covering `{prefix}-ats.iot.{region}.amazonaws.com`.
      "wss://*.amazonaws.com",
      // Direct S3 PUT/GET for chat attachment bytes (presigned URLs).
      "https://*.amazonaws.com",
      "https://*.s3.amazonaws.com",
      "https://*.s3.us-east-1.amazonaws.com",
      COGNITO_HOSTED_UI,
      COGNITO_IDP,
      COGNITO_IDENTITY,
    ],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'", COGNITO_HOSTED_UI],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}
