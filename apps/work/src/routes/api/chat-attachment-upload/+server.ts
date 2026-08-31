/**
 * Same-origin hop for chat attachment bytes.
 *
 * Browser → this route → presigned S3 PUT. Vault buckets have no CORS, so a
 * direct browser PUT fails with "Failed to fetch". The hop remains
 * cookie-authenticated on the web origin and only forwards to HTTPS S3 hosts.
 */

import type { RequestHandler } from "./$types";
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

  const headers = s3UploadHeadersFrom(request.headers);
  const body = await request.arrayBuffer();
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
