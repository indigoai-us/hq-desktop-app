/**
 * Same-origin hop for chat attachment bytes.
 *
 * Browser → this route → presigned S3 PUT. Vault buckets have no CORS, so a
 * direct browser PUT fails with "Failed to fetch". The hop remains
 * cookie-authenticated on the web origin and only forwards to HTTPS S3 hosts.
 *
 * This SvelteKit server route is web-only: the desktop build uses
 * adapter-static when TAURI is set, so desktop uploads use native commands.
 * Its inbound bound must therefore match the web client's
 * validateWebChatAttachment limit. Do not harmonize this with
 * chat-attachment-bytes: that route bounds an S3 response, where the web
 * request cap is irrelevant, so its 25 MiB ceiling is correct.
 */

import type { RequestHandler } from "./$types";
import { WEB_CHAT_ATTACHMENT_MAX_BYTES } from "@hq/ui";
import { ID_TOKEN_COOKIE } from "$lib/server/auth";
import {
  isAllowedS3PresignUrl,
  s3UploadHeadersFrom,
} from "$lib/server/s3-presign-url";

function jsonError(status: number, error: string, code: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function headerByteLength(request: Request): number | null {
  const raw = request.headers.get("content-length")?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return null;
  const bytes = Number(raw);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

async function readBounded(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer as ArrayBuffer;
}

export const PUT: RequestHandler = async ({ request, cookies }) => {
  const idToken = cookies.get(ID_TOKEN_COOKIE);
  if (!idToken) {
    return jsonError(401, "Unauthenticated", "UNAUTHENTICATED");
  }

  const target = (request.headers.get("x-hq-upload-url") ?? "").trim();
  if (!isAllowedS3PresignUrl(target)) {
    return jsonError(
      400,
      "Upload URL is not a vault object",
      "UPLOAD_URL_INVALID",
    );
  }

  if (
    (headerByteLength(request) ?? 0) > WEB_CHAT_ATTACHMENT_MAX_BYTES
  ) {
    return jsonError(413, "Upload is too large", "PAYLOAD_TOO_LARGE");
  }

  const headers = s3UploadHeadersFrom(request.headers);
  const body = await readBounded(request, WEB_CHAT_ATTACHMENT_MAX_BYTES);
  if (!body) {
    return jsonError(413, "Upload is too large", "PAYLOAD_TOO_LARGE");
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "PUT",
      headers,
      body,
    });
  } catch {
    return jsonError(502, "Upload upstream failed", "UPLOAD_UNREACHABLE");
  }

  return new Response(null, {
    status: upstream.status,
    headers: { "cache-control": "no-store" },
  });
};
