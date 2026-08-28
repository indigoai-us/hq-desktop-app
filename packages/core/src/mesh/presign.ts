/**
 * SigV4 query-presign of a `wss://{endpoint}/mqtt` URL for AWS IoT Core.
 *
 * Mirrors the proven hq-console implementation
 * (src/lib/realtime/notifications-mqtt.ts):
 *
 * THE IoT WSS GOTCHA: the request is signed WITHOUT `X-Amz-Security-Token`,
 * then the session token is appended to the final URL AFTER the signature is
 * computed. Including the token in the canonical query breaks the broker
 * handshake.
 *
 * No AWS SDK dependency — SHA-256/HMAC run through an injectable async crypto
 * seam whose default implementation is WebCrypto (`globalThis.crypto.subtle`),
 * which works in browsers, Node >= 20, and vitest. The clock is injectable so
 * fixed-vector tests are deterministic.
 */

const IOT_SERVICE = "iotdevicegateway";
const CANONICAL_URI = "/mqtt";
const ALGORITHM = "AWS4-HMAC-SHA256";

/** Short-lived STS credentials as vended by hq-pro. */
export interface MeshCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO8601 expiry. */
  expiration?: string;
}

/** Injectable crypto seam (async so WebCrypto works everywhere). */
export interface SigV4Crypto {
  sha256Hex(data: string): Promise<string>;
  hmac(key: Uint8Array | string, data: string): Promise<Uint8Array>;
}

const encoder = new TextEncoder();

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? encoder.encode(input) : input;
}

/** Lowercase hex of raw bytes. */
export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Default SigV4Crypto backed by WebCrypto (browser + Node 20+). */
export const subtleSigV4Crypto: SigV4Crypto = {
  async sha256Hex(data: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      toBytes(data) as BufferSource,
    );
    return hex(new Uint8Array(digest));
  },
  async hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "raw",
      toBytes(key) as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await globalThis.crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      toBytes(data) as BufferSource,
    );
    return new Uint8Array(sig);
  },
};

/**
 * RFC-3986 strict encode (encodeURIComponent leaves `!*'()` unescaped, which
 * AWS SigV4 requires encoded).
 */
export function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Format a Date as the SigV4 `YYYYMMDDTHHMMSSZ` amz-date. */
export function amzDateOf(now: Date): string {
  return now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace(/Z?$/, "Z");
}

/**
 * SigV4 query-presign a `wss://{endpoint}/mqtt` URL for AWS IoT Core.
 *
 * Pure function of its inputs: injectable clock (`now`) and crypto make it
 * deterministic for fixed-vector regression tests.
 */
export async function presignIotWssUrl(
  creds: MeshCredentials,
  endpoint: string,
  region: string,
  now: Date = new Date(),
  cryptoImpl: SigV4Crypto = subtleSigV4Crypto,
): Promise<string> {
  const amzDate = amzDateOf(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${IOT_SERVICE}/aws4_request`;

  // Canonical query — sorted: Algorithm, Credential, Date, SignedHeaders.
  // NOTE: X-Amz-Security-Token is deliberately NOT part of the signed query.
  const canonicalQuery =
    `X-Amz-Algorithm=${rfc3986Encode(ALGORITHM)}` +
    `&X-Amz-Credential=${rfc3986Encode(`${creds.accessKeyId}/${scope}`)}` +
    `&X-Amz-Date=${rfc3986Encode(amzDate)}` +
    `&X-Amz-SignedHeaders=host`;

  const canonicalHeaders = `host:${endpoint}\n`;
  const canonicalRequest = [
    "GET",
    CANONICAL_URI,
    canonicalQuery,
    canonicalHeaders,
    "host",
    await cryptoImpl.sha256Hex(""),
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    await cryptoImpl.sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await cryptoImpl.hmac(
    `AWS4${creds.secretAccessKey}`,
    dateStamp,
  );
  const kRegion = await cryptoImpl.hmac(kDate, region);
  const kService = await cryptoImpl.hmac(kRegion, IOT_SERVICE);
  const kSigning = await cryptoImpl.hmac(kService, "aws4_request");
  const signature = hex(await cryptoImpl.hmac(kSigning, stringToSign));

  let url = `wss://${endpoint}${CANONICAL_URI}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  // Session token appended AFTER signing (IoT-specific gotcha).
  if (creds.sessionToken) {
    url += `&X-Amz-Security-Token=${rfc3986Encode(creds.sessionToken)}`;
  }
  return url;
}
