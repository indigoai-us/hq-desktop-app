import {
  approvedPlanUpgradeUrl,
  hqProErrorFromRecord,
  isPlanLimitCode,
  type AdapterResult,
  type Json,
  type VaultPutIntegrity,
} from "@hq/platform";
import {
  attachmentKindForContentType,
  buildChatAttachmentVaultPath,
  contentTypeForFile,
  newAttachmentId,
  sanitizeAttachmentName,
  type ChatAttachmentWire,
} from "./chat-attachments.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function presignUrlFromResult(raw: unknown): {
  url: string;
  headers: Record<string, string>;
} | null {
  const body = asRecord(raw);
  const results = Array.isArray(body?.results) ? body.results : [];
  const first = asRecord(results[0]);
  const url = typeof first?.url === "string" ? first.url : "";
  if (!url) return null;
  const headersRaw = asRecord(first?.headers) ?? {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headersRaw)) {
    if (typeof value === "string") headers[key] = value;
  }
  return { url, headers };
}

/**
 * An attachment upload the server refused. A plan-limit refusal carries the
 * server's upgrade link so the composer can render it next to the sentence.
 * This is an expected product state: it is shown, never reported to Sentry.
 */
export class ChatAttachmentUploadError extends Error {
  readonly upgradeUrl?: string;
  readonly planLimit: boolean;

  constructor(
    message: string,
    options: { upgradeUrl?: string | null; planLimit?: boolean } = {},
  ) {
    super(message);
    this.name = "ChatAttachmentUploadError";
    const upgradeUrl = approvedPlanUpgradeUrl(options.upgradeUrl);
    if (upgradeUrl) this.upgradeUrl = upgradeUrl;
    this.planLimit = Boolean(options.planLimit);
  }
}

/**
 * The approved upgrade link carried by a failed upload or send, or null.
 * Duck-typed so an error that crossed a module boundary still yields its link.
 */
export function uploadErrorUpgradeUrl(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  return approvedPlanUpgradeUrl((err as { upgradeUrl?: unknown }).upgradeUrl);
}

/**
 * hq-pro refuses a single key inside a 200 presign batch with
 * `{ key, op, error, code, upgradeUrl? }` (the personal-scope plan skip, and
 * any per-item refusal). Returns the readable refusal, or null when the first
 * result is not a refusal.
 */
export function presignItemRefusal(raw: unknown): {
  message: string;
  upgradeUrl?: string;
  planLimit: boolean;
} | null {
  const body = asRecord(raw);
  const results = Array.isArray(body?.results) ? body.results : [];
  const first = asRecord(results[0]);
  if (!first || typeof first.url === "string") return null;
  if (typeof first.error !== "string" && typeof first.code !== "string") {
    return null;
  }
  const parsed = hqProErrorFromRecord(first, {
    code: "presign-refused",
    message: "Could not prepare the upload",
  });
  return {
    message: parsed.message,
    planLimit: parsed.planLimit,
    ...(parsed.upgradeUrl ? { upgradeUrl: parsed.upgradeUrl } : {}),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * SHA-256 of a file, in the two forms hq-pro's presign needs. Vault buckets
 * have S3 Object Lock, which rejects any PUT without a signed checksum.
 */
export async function fileIntegrity(file: Blob): Promise<VaultPutIntegrity> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
  );
  return {
    checksumSha256: bytesToBase64(digest),
    contentSha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}

export type PutChatAttachment = (
  url: string,
  headers: Record<string, string>,
  file: File,
) => Promise<Response>;

/**
 * Direct S3 PUT. Vault buckets have no CORS, so browsers fail this with
 * "Failed to fetch". Web hosts should pass {@link PutChatAttachment} that
 * hops through a same-origin proxy instead.
 */
export async function putChatAttachmentDirect(
  url: string,
  headers: Record<string, string>,
  file: File,
): Promise<Response> {
  return fetch(url, { method: "PUT", headers, body: file });
}

function uploadFailureMessage(err: unknown, fileName: string): string {
  if (
    err instanceof Error &&
    /failed to fetch|networkerror|^load failed$/i.test(err.message)
  ) {
    return `Could not upload ${fileName}`;
  }
  if (err instanceof Error && err.message) {
    return formatUploadServerError(err.message, fileName);
  }
  return `Could not upload ${fileName}`;
}

/** Friendly prefix, then the server's error text verbatim. */
export function formatUploadServerError(
  serverMessage: string,
  fileName: string,
): string {
  const text = serverMessage.trim();
  if (!text || /failed to fetch|networkerror|^load failed$/i.test(text)) {
    return `Could not upload ${fileName}`;
  }
  if (text.startsWith("Could not upload ") || text.startsWith("Couldn't attach ")) {
    return text;
  }
  return `Could not upload ${fileName}: ${text}`;
}

export async function uploadChatAttachments(opts: {
  files: File[];
  companyUid: string;
  scope: "chan" | "dm";
  scopeId: string;
  presignPut: (
    companyUid: string,
    key: string,
    contentType: string,
    integrity: VaultPutIntegrity,
  ) => Promise<AdapterResult<Json>>;
  /** Override the byte PUT (web same-origin proxy). Default is a direct S3 fetch. */
  putObject?: PutChatAttachment;
}): Promise<ChatAttachmentWire[]> {
  const uploaded: ChatAttachmentWire[] = [];
  const putObject = opts.putObject ?? putChatAttachmentDirect;
  for (const file of opts.files) {
    const id = newAttachmentId();
    const contentType = contentTypeForFile(file);
    const vaultPath = buildChatAttachmentVaultPath({
      scope: opts.scope,
      scopeId: opts.scopeId,
      fileId: id,
      name: file.name,
    });
    const signed = await opts.presignPut(
      opts.companyUid,
      vaultPath,
      contentType,
      await fileIntegrity(file),
    );
    if (!signed.ok) {
      throw new ChatAttachmentUploadError(
        formatUploadServerError(
          signed.message || "Could not prepare the upload",
          file.name,
        ),
        { upgradeUrl: signed.upgradeUrl, planLimit: isPlanLimitCode(signed.code) },
      );
    }
    const target = presignUrlFromResult(signed.value);
    if (!target) {
      const refusal = presignItemRefusal(signed.value);
      if (refusal) {
        throw new ChatAttachmentUploadError(
          formatUploadServerError(refusal.message, file.name),
          refusal,
        );
      }
      throw new Error("Upload URL missing");
    }
    let put: Response;
    try {
      put = await putObject(target.url, target.headers, file);
    } catch (err) {
      throw new Error(uploadFailureMessage(err, file.name));
    }
    if (!put.ok) {
      throw new Error(`Upload failed for ${file.name}`);
    }
    uploaded.push({
      id,
      vaultPath,
      companyUid: opts.companyUid,
      name: sanitizeAttachmentName(file.name),
      contentType,
      sizeBytes: file.size,
      kind: attachmentKindForContentType(contentType),
    });
  }
  return uploaded;
}
