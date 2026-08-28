import type { AdapterResult, Json } from "@hq/platform";
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
  if (err instanceof Error && err.message) return err.message;
  return `Could not upload ${fileName}`;
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
    );
    if (!signed.ok) {
      throw new Error(
        /failed to fetch|networkerror|^load failed$/i.test(signed.message ?? "")
          ? `Could not upload ${file.name}`
          : signed.message || "Could not prepare the upload",
      );
    }
    const target = presignUrlFromResult(signed.value);
    if (!target) throw new Error("Upload URL missing");
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
