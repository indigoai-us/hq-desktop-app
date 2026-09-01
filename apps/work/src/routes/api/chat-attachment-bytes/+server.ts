/**
 * Same-origin hop for reading chat attachment bytes (text / CSV / download).
 * Browser fetch() of a presigned S3 GET needs CORS; this hop does not.
 */

import type { RequestHandler } from "./$types";
import { MAX_CHAT_ATTACHMENT_BYTES } from "@hq/ui";
import { ID_TOKEN_COOKIE } from "$lib/server/auth";
import { isAllowedS3PresignUrl } from "$lib/server/s3-presign-url";

function jsonError(status: number, error: string, code: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function headerByteLength(response: Response): number | null {
  const raw = response.headers.get("content-length")?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return null;
  const bytes = Number(raw);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function requestedByteLimit(request: Request): number {
  const raw = request.headers.get("x-hq-max-bytes")?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return MAX_CHAT_ATTACHMENT_BYTES;
  const requested = Number(raw);
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return MAX_CHAT_ATTACHMENT_BYTES;
  }
  return Math.min(requested, MAX_CHAT_ATTACHMENT_BYTES);
}

async function readBounded(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const GET: RequestHandler = async ({ request, cookies }) => {
  const idToken = cookies.get(ID_TOKEN_COOKIE);
  if (!idToken) {
    return jsonError(401, "Unauthenticated", "UNAUTHENTICATED");
  }

  const target = (request.headers.get("x-hq-source-url") ?? "").trim();
  if (!isAllowedS3PresignUrl(target)) {
    return jsonError(
      400,
      "File URL is not a vault object",
      "SOURCE_URL_INVALID",
    );
  }

  const controller = new AbortController();
  let upstream: Response;
  try {
    upstream = await fetch(target, { method: "GET", signal: controller.signal });
  } catch {
    return jsonError(502, "File upstream failed", "SOURCE_UNREACHABLE");
  }

  const maxBytes = requestedByteLimit(request);
  if ((headerByteLength(upstream) ?? 0) > maxBytes) {
    controller.abort();
    return jsonError(413, "File is too large", "SOURCE_TOO_LARGE");
  }

  const contentType =
    upstream.headers.get("content-type") ?? "application/octet-stream";
  let body: Uint8Array | null;
  try {
    body = await readBounded(upstream, maxBytes, controller);
  } catch {
    return jsonError(502, "File upstream failed", "SOURCE_UNREACHABLE");
  }
  if (!body) {
    return jsonError(413, "File is too large", "SOURCE_TOO_LARGE");
  }
  return new Response(body.buffer as ArrayBuffer, {
    status: upstream.status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
};
