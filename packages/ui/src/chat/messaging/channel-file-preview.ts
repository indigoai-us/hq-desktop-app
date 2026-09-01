/**
 * Host-independent, bounded file-preview policy for a project channel.
 *
 * The server remains authoritative for membership: this module supplies the
 * company UID to the presign seam and refuses an item that explicitly belongs
 * to another selected company before a request can leave the renderer.
 */
import { presignUrlFromResult } from "./upload-chat-attachments.js";
import type {
  ChannelFileItemModel,
  ChannelFilePreview,
} from "./channelTabModels.js";

export const MAX_CHANNEL_FILE_PREVIEW_BYTES = 2 * 1024 * 1024;

type PresignResult =
  | { ok: true; value: unknown }
  | { ok: false; reason?: string; code?: string; message?: string };

export interface VaultFilePreviewRequest {
  item: ChannelFileItemModel;
  /** Company of the currently selected project channel. */
  selectedCompanyUid: string | null | undefined;
  presign: (companyUid: string, key: string) => Promise<PresignResult>;
  /** Must enforce the same byte limit in native hosts before buffering. */
  get: (url: string, maxBytes: number) => Promise<Response>;
  createObjectUrl?: (blob: Blob) => string;
}

/**
 * Return the single permitted company scope for a file request. A mismatched
 * explicit item scope is never silently rewritten to the selected channel.
 */
export function fileCompanyScope(
  item: Pick<ChannelFileItemModel, "companyUid">,
  selectedCompanyUid: string | null | undefined,
): string | null {
  const itemCompany = item.companyUid?.trim() ?? "";
  const selectedCompany = selectedCompanyUid?.trim() ?? "";
  if (itemCompany && selectedCompany && itemCompany !== selectedCompany) {
    return null;
  }
  return itemCompany || selectedCompany || null;
}

function unavailable(
  state: Extract<ChannelFilePreview, { kind: "unavailable" }>["state"],
  message: string,
): ChannelFilePreview {
  return { kind: "unavailable", state, message };
}

function failurePreview(result: Exclude<PresignResult, { ok: true }>): ChannelFilePreview {
  const detail = [result.code, result.reason, result.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (/403|forbidden|denied|membership|unauth/.test(detail)) {
    return unavailable("denied", "You don't have access to this file.");
  }
  if (/404|not.?found|missing/.test(detail)) {
    return unavailable("missing", "This file is no longer available.");
  }
  if (/offline|network|timeout|5\d\d/.test(detail)) {
    return unavailable("offline", "Couldn't reach the file service. Try again when you're online.");
  }
  return unavailable("unsupported", "This file can't be previewed right now.");
}

function responseFailure(status: number): ChannelFilePreview {
  if (status === 401 || status === 403) {
    return unavailable("denied", "You don't have access to this file.");
  }
  if (status === 404) return unavailable("missing", "This file is no longer available.");
  return unavailable("offline", "Couldn't reach the file service. Try again when you're online.");
}

function thrownGetFailure(error: unknown): ChannelFilePreview {
  const detail = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/too.?large|exceeds.*byte|read limit|size limit/.test(detail)) {
    return unavailable("too-large", "This file is too large to preview safely.");
  }
  if (/403|forbidden|denied|membership|unauth/.test(detail)) {
    return unavailable("denied", "You don't have access to this file.");
  }
  if (/404|not.?found|missing/.test(detail)) {
    return unavailable("missing", "This file is no longer available.");
  }
  return unavailable("offline", "Couldn't reach the file service. Try again when you're online.");
}

function headerByteLength(response: Response): number | null {
  const raw = response.headers.get("content-length")?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return null;
  const bytes = Number(raw);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = headerByteLength(response);
  if (declared !== null && declared > maxBytes) return null;

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= maxBytes ? bytes : null;
  }

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

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizedContentType(response: Response): string {
  return (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
}

function isSafeImage(contentType: string): boolean {
  return new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
  ]).has(contentType);
}

function isTextFile(item: ChannelFileItemModel, contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    item.iconKind === "markdown" ||
    item.iconKind === "text"
  );
}

/** Fetch and classify a company-scoped preview without exposing its S3 URL. */
export async function loadVaultFilePreview(
  request: VaultFilePreviewRequest,
): Promise<ChannelFilePreview> {
  const companyUid = fileCompanyScope(request.item, request.selectedCompanyUid);
  if (!companyUid) {
    return unavailable("denied", "This file is not available in the current company.");
  }

  let signed: PresignResult;
  try {
    signed = await request.presign(companyUid, request.item.vaultPath);
  } catch {
    return unavailable("offline", "Couldn't reach the file service. Try again when you're online.");
  }
  if (!signed.ok) return failurePreview(signed);

  const url = presignUrlFromResult(signed.value)?.url;
  if (!url) {
    return unavailable("missing", "This file is no longer available.");
  }

  let response: Response;
  try {
    response = await request.get(url, MAX_CHANNEL_FILE_PREVIEW_BYTES);
  } catch (error) {
    return thrownGetFailure(error);
  }
  if (!response.ok) return responseFailure(response.status);

  let bytes: Uint8Array | null;
  try {
    bytes = await readBounded(response, MAX_CHANNEL_FILE_PREVIEW_BYTES);
  } catch {
    return unavailable("offline", "Couldn't read this file. Try again when you're online.");
  }
  if (!bytes) {
    return unavailable("too-large", "This file is too large to preview safely.");
  }

  const contentType = normalizedContentType(response);
  if (isSafeImage(contentType) || contentType === "application/pdf") {
    const createObjectUrl = request.createObjectUrl ?? URL.createObjectURL.bind(URL);
    // Copy into an ArrayBuffer-backed view; TypeScript correctly treats a
    // generic Uint8Array as possibly SharedArrayBuffer-backed, which Blob does
    // not accept. Network bytes are copied before they reach the renderer.
    const blobBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    blobBytes.set(bytes);
    const url = createObjectUrl(new Blob([blobBytes.buffer], { type: contentType }));
    return contentType === "application/pdf"
      ? { kind: "pdf", url }
      : { kind: "image", url };
  }

  if (!isTextFile(request.item, contentType)) {
    return unavailable("binary", "This binary file can't be previewed safely.");
  }
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return unavailable("binary", "This binary file can't be previewed safely.");
  }
}
