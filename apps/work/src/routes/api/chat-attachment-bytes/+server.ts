/**
 * Same-origin hop for reading chat attachment bytes (text / CSV / download).
 * Browser fetch() of a presigned S3 GET needs CORS; this hop does not.
 */

import type { RequestHandler } from "./$types";
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

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: "GET" });
  } catch {
    return jsonError(502, "File upstream failed", "SOURCE_UNREACHABLE");
  }

  const contentType =
    upstream.headers.get("content-type") ?? "application/octet-stream";
  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
};
