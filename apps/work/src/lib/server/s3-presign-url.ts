/**
 * Allowlist for the chat-attachment upload hop.
 *
 * The browser cannot PUT to vault buckets (no CORS). This server forwards
 * bytes to the presigned URL. Only HTTPS S3 hosts are accepted so the
 * hop cannot be used as an open proxy.
 */

export function isAllowedS3PresignUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "amazonaws.com" || host.endsWith(".amazonaws.com") === false) {
    return false;
  }
  return (
    host === "s3.amazonaws.com" ||
    host.startsWith("s3.") ||
    host.includes(".s3.") ||
    host.includes(".s3-")
  );
}

const FORWARDED_HEADER = /^(content-type|if-match|if-none-match|x-amz-)/i;

export function s3UploadHeadersFrom(request: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  request.forEach((value, key) => {
    if (FORWARDED_HEADER.test(key)) headers[key] = value;
  });
  return headers;
}
