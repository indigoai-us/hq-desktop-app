/**
 * PKCE primitives — Web-standard crypto only (crypto.getRandomValues +
 * crypto.subtle + btoa), so they run identically in Node (>=18), the browser,
 * and Tauri's webview. NO Node Buffer.
 */

/** base64url-encode raw bytes (no padding), matching Cognito/PKCE expectations. */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Random base64url string (PKCE verifier / CSRF state). */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

/** S256 code challenge for a PKCE verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}
