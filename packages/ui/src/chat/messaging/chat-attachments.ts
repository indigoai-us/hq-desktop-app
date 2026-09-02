/**
 * Client helpers for chat file attachments.
 *
 * Bytes go to the company vault under `chat/attachments/{chan|dm}/{id}/…`.
 * The message row only stores metadata; retrieve is a files-presign GET.
 */

export const MAX_CHAT_ATTACHMENTS = 5;
export const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Vercel accepts at most 4.5 MB request bodies; leave boundary headroom. */
export const WEB_CHAT_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

export type ChatAttachmentValidationErrorCode =
  | "attachment-too-large"
  | "attachment-unsupported-type";

export interface ChatAttachmentValidationError {
  code: ChatAttachmentValidationErrorCode;
  message: string;
}

export type ChatAttachmentValidator = (
  file: File,
) => ChatAttachmentValidationError | null;

export type ChatAttachmentKind = "image" | "file";

export interface ChatAttachmentWire {
  id: string;
  vaultPath: string;
  companyUid: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  kind: ChatAttachmentKind;
  /** Local-only (blob: or already-presigned). Never persisted. */
  previewUrl?: string | null;
}

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const FILE_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/zip",
  "application/x-zip-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const EXT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const CHAT_ATTACHMENT_ACCEPT = Object.keys(EXT_TYPES)
  .map((ext) => `.${ext}`)
  .join(",");

export function conversationPairKey(a: string, b: string): string {
  return [a, b].sort().join("#");
}

export function dmAttachmentScopeId(pairKey: string): string {
  return pairKey.replace(/#/g, "--");
}

export function sanitizeAttachmentName(raw: string): string {
  const base = raw.trim().split(/[/\\]/).pop() ?? "file";
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 180) || "file";
}

export function contentTypeForFile(file: File): string {
  const typed = file.type.trim().toLowerCase();
  if (typed) return typed;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? "application/octet-stream";
}

export function attachmentKindForContentType(
  contentType: string,
): ChatAttachmentKind {
  const normalized = contentType.trim().toLowerCase();
  return IMAGE_TYPES.has(normalized) || normalized.startsWith("image/")
    ? "image"
    : "file";
}

/** True when a pending composer file should render an image thumbnail. */
export function isImageFile(file: File): boolean {
  return attachmentKindForContentType(contentTypeForFile(file)) === "image";
}

export function validateChatAttachment(
  file: File,
  maxBytes = MAX_CHAT_ATTACHMENT_BYTES,
): ChatAttachmentValidationError | null {
  if (file.size > maxBytes) {
    return {
      code: "attachment-too-large",
      message: `${file.name} is larger than ${maxBytes / (1024 * 1024)} MB`,
    };
  }
  const type = contentTypeForFile(file);
  if (!IMAGE_TYPES.has(type) && !FILE_TYPES.has(type)) {
    return {
      code: "attachment-unsupported-type",
      message: `${file.name} isn't a supported file type`,
    };
  }
  return null;
}

export function validateWebChatAttachment(
  file: File,
): ChatAttachmentValidationError | null {
  const error = validateChatAttachment(file, WEB_CHAT_ATTACHMENT_MAX_BYTES);
  if (error?.code !== "attachment-too-large") return error;
  return {
    ...error,
    message: `${file.name} is larger than 4 MB, the web upload limit`,
  };
}

export function chatAttachmentValidatorForPlatform(
  platform: "web" | "desktop",
): ChatAttachmentValidator {
  return platform === "web" ? validateWebChatAttachment : validateChatAttachment;
}

export function isAllowedChatAttachment(file: File): string | null {
  return validateChatAttachment(file)?.message ?? null;
}

export function buildChatAttachmentVaultPath(args: {
  scope: "chan" | "dm";
  scopeId: string;
  fileId: string;
  name: string;
}): string {
  const scopeId =
    args.scope === "dm" ? dmAttachmentScopeId(args.scopeId) : args.scopeId;
  return `chat/attachments/${args.scope}/${scopeId}/${args.fileId}-${sanitizeAttachmentName(args.name)}`;
}

export function fileTypeLabel(name: string, contentType: string): string {
  const ext = name.split(".").pop()?.toUpperCase();
  if (ext && ext.length <= 5 && ext !== name.toUpperCase()) return ext;
  if (contentType.startsWith("image/")) return "IMG";
  if (contentType === "application/pdf") return "PDF";
  return "FILE";
}

export function newAttachmentId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
