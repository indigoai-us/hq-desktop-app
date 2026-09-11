/**
 * Canonical JSON + signing primitives for the "hq-meet/1" contract.
 *
 * Mirrors hq-pro `src/meetings/native/crypto.ts` @ 848a966 with two deliberate
 * differences, both forced by the host targets (WKWebView, browsers, Node):
 *
 *  - hashing and signature verification use WebCrypto (`crypto.subtle`) rather
 *    than `node:crypto`, so every function that hashes is async;
 *  - there is no signing path here. Desktop verifies envelopes it receives;
 *    private keys live behind the native host, never in the webview bundle.
 *
 * `golden/crypto-vectors.json` pins the service's own canonical strings,
 * digests and signatures so drift shows up as a failing test, not a silent
 * incompatibility.
 */

import { CallsContractError } from "./contract.js";

const utf8 = new TextEncoder();

function subtle(): SubtleCrypto {
  const webcrypto = globalThis.crypto;
  if (!webcrypto?.subtle) {
    throw new Error("WebCrypto (crypto.subtle) is required for hq-meet/1");
  }
  return webcrypto.subtle;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function isWellFormed(value: string): boolean {
  const withMethod = value as string & { isWellFormed?: () => boolean };
  if (typeof withMethod.isWellFormed === "function") {
    return withMethod.isWellFormed();
  }
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(
    value,
  );
}

/** RFC 8785 JSON subset: Unicode scalar strings and safe integers only. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!isWellFormed(value)) throw new CallsContractError("INVALID_INPUT");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonical(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  throw new CallsContractError("INVALID_INPUT");
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new CallsContractError("INVALID_INPUT");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Strict base64url decode: rejects padding and non-canonical encodings. */
export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new CallsContractError("INVALID_SIGNATURE");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  try {
    return decodeBase64(padded + padding);
  } catch {
    throw new CallsContractError("INVALID_SIGNATURE");
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function fromBase64(value: string): Uint8Array {
  try {
    return decodeBase64(value);
  } catch {
    throw new CallsContractError("INVALID_INPUT");
  }
}

export function toBase64(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

/** sha256 as lowercase hex, over raw bytes or the UTF-8 bytes of a string. */
export async function sha256(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === "string" ? utf8.encode(input) : input;
  const view = new Uint8Array(bytes);
  const digest = await subtle().digest("SHA-256", view.buffer as ArrayBuffer);
  return toHex(new Uint8Array(digest));
}

/** keyId = sha256 of the RAW Ed25519 public key bytes (base64url input). */
export async function keyId(rawKey: string): Promise<string> {
  const bytes = publicKeyBytes(rawKey);
  return sha256(bytes);
}

function publicKeyBytes(rawKey: string): Uint8Array {
  const bytes = fromBase64Url(rawKey);
  if (bytes.length !== 32 || toBase64Url(bytes) !== rawKey) {
    throw new CallsContractError("INVALID_SIGNATURE");
  }
  return bytes;
}

function withoutFields(
  value: Record<string, unknown>,
  content: boolean,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== "signature" && (!content || key !== "digest"),
    ),
  );
}

/** `hq-meet/1\0<kind>\0<canonical(envelope without signature)>` as UTF-8. */
export function signedBytes(value: Record<string, unknown>): Uint8Array {
  return utf8.encode(
    `hq-meet/1\0${String(value.kind)}\0${canonical(withoutFields(value, false))}`,
  );
}

/** The pre-image the content digest is taken over (exposed for tests). */
export function contentBytes(value: Record<string, unknown>): Uint8Array {
  return utf8.encode(
    `hq-meet/1\0content:${String(value.kind)}\0${canonical(
      withoutFields(value, true),
    )}`,
  );
}

export function contentDigest(value: Record<string, unknown>): Promise<string> {
  return sha256(contentBytes(value));
}

/**
 * Verify an envelope's Ed25519 signature and (for transcript kinds) its content
 * digest. Throws `CallsContractError("INVALID_SIGNATURE" | "DIGEST_MISMATCH")`,
 * never leaking key or payload material into the message.
 */
export async function verifyEnvelope(
  value: Record<string, unknown>,
  rawKey: string,
): Promise<void> {
  const expectedKeyId = await keyId(rawKey);
  if (value.peerKey !== expectedKeyId || typeof value.signature !== "string") {
    throw new CallsContractError("INVALID_SIGNATURE");
  }
  const signature = fromBase64Url(value.signature);
  if (signature.length !== 64 || toBase64Url(signature) !== value.signature) {
    throw new CallsContractError("INVALID_SIGNATURE");
  }
  const key = await subtle().importKey(
    "raw",
    publicKeyBytes(rawKey).buffer as ArrayBuffer,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const message = signedBytes(value);
  const valid = await subtle().verify(
    { name: "Ed25519" },
    key,
    signature.buffer as ArrayBuffer,
    message.buffer as ArrayBuffer,
  );
  if (!valid) throw new CallsContractError("INVALID_SIGNATURE");
  if (value.kind === "segment" || value.kind === "correction") {
    if (value.digest !== (await contentDigest(value))) {
      throw new CallsContractError("DIGEST_MISMATCH");
    }
  }
}

/**
 * The byte-level half of the `chunk` schema: the service decodes `data`,
 * requires a canonical base64 round-trip, and matches `byteLength` + `digest`.
 */
export async function verifyChunkBytes(value: {
  data: string;
  byteLength: number;
  digest: string;
}): Promise<void> {
  let decoded: Uint8Array;
  try {
    decoded = fromBase64(value.data);
  } catch {
    throw new CallsContractError("INVALID_INPUT");
  }
  if (
    decoded.length !== value.byteLength ||
    toBase64(decoded) !== value.data
  ) {
    throw new CallsContractError("INVALID_INPUT");
  }
  if ((await sha256(decoded)) !== value.digest) {
    throw new CallsContractError("DIGEST_MISMATCH");
  }
}
