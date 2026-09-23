/**
 * Presigned GET for a message attachment, plus the Files-route helper.
 *
 * Bytes are fetched at view time through the existing native hop
 * (`hq_pro_fetch` → POST /v1/files/presign, then `vault_s3_get`). The
 * presigned URL is held in memory for that request only — never logged,
 * persisted, or returned to UI callers except as an object URL / text.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import {
  attachmentPreviewKind,
  looksLikeCompanyUid,
  MAX_CHANNEL_FILE_PREVIEW_BYTES,
  presignUrlFromResult,
  files as filesUi,
} from '@hq/ui';
import { isFolderAttachment, type MessageAttachment } from './messageAttachments';

export const MAX_ATTACHMENT_PREVIEW_BYTES = MAX_CHANNEL_FILE_PREVIEW_BYTES;

/** Shown when an older attachment row has no company vault to presign against. */
export const ATTACHMENT_MISSING_COMPANY = 'This file has no company assigned.';

export type InvokeFn = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export interface AttachmentPresignDeps {
  invoke?: InvokeFn;
}

export type AttachmentPreviewView =
  | { kind: 'image'; objectUrl: string; contentType: string }
  | { kind: 'pdf'; objectUrl: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

interface NativeHqProResponse {
  status: number;
  body: string;
}

interface VaultGetResult {
  status: number;
  contentType: string;
  body: number[];
}

function invokeFn(deps?: AttachmentPresignDeps): InvokeFn {
  return deps?.invoke ?? (tauriInvoke as InvokeFn);
}

/** True when this attachment should render inline (image / pdf / text / markdown). */
export function isInlineAttachmentPreview(attachment: MessageAttachment): boolean {
  if (isFolderAttachment(attachment)) return false;
  const name = attachment.name;
  if (filesUi.filePreviewKind(name) === 'unknown') return false;
  const kind = attachmentPreviewKind({
    name,
    contentType: attachment.contentType ?? '',
    kind: attachment.kind,
  });
  return kind === 'image' || kind === 'pdf' || kind === 'text' || kind === 'markdown';
}

/**
 * Resolve a Files-view slug from `companyUid`, matching how Files mode maps
 * memberships (`cloudUid`/`uid` → `slug`). When only a uid is available,
 * fall back to an HQ-relative vault path (`companies/<slug>/…`) or the first
 * path segment if it is already a slug.
 */
export function companySlugForAttachment(
  attachment: MessageAttachment,
  companies: ReadonlyArray<{
    uid?: string;
    cloudUid?: string | null;
    slug: string;
  }> = [],
): string {
  const uid = (attachment.companyUid ?? '').trim();
  const match = companies.find((row) => row.uid === uid || row.cloudUid === uid);
  if (match?.slug) return match.slug;
  if (uid && !looksLikeCompanyUid(uid)) return uid;

  const vaultPath = attachment.vaultPath.trim().replace(/\\/g, '/');
  const hqSlug = filesUi.companySlugForHqPath(vaultPath);
  if (hqSlug) return hqSlug;

  const first = vaultPath.split(/[/:]/)[0]?.trim() ?? '';
  if (first && !looksLikeCompanyUid(first)) return first;
  return uid;
}

export type AttachmentCompany = {
  uid?: string;
  cloudUid?: string | null;
  slug: string;
};

function vaultPathHasParentSegment(path: string): boolean {
  return path.split('/').some((segment) => segment === '..');
}

function folderCompanySlug(
  attachment: MessageAttachment,
  companies?: ReadonlyArray<AttachmentCompany>,
): string {
  const uid = (attachment.companyUid ?? '').trim();
  if (!uid) return '';
  if (companies && companies.length > 0) {
    const match = companies.find(
      (row) => row.uid === uid || row.cloudUid === uid || row.slug === uid,
    );
    return (match?.slug ?? '').trim();
  }
  return companySlugForAttachment(attachment, companies).trim();
}

/** Wire string consumed by `parseDesktopRoute` / `open_desktop_alt_window`. */
export function filesRouteForAttachment(
  attachment: MessageAttachment,
  companies?: ReadonlyArray<AttachmentCompany>,
): string | null {
  const path = (attachment.vaultPath ?? '').trim().replace(/\\/g, '/');
  const folder = isFolderAttachment(attachment);
  if (!(attachment.companyUid ?? '').trim()) return null;
  const slug = folder
    ? folderCompanySlug(attachment, companies)
    : companySlugForAttachment(attachment, companies).trim();
  if (!slug) return null;
  if (vaultPathHasParentSegment(path)) return null;
  if (path.startsWith('/') && path !== '/') return null;
  if (folder && !path) return null;
  const filesPath = folder && path === '/' ? slug : path;
  if (!filesPath) return null;
  return `files:${slug}:${filesPath}`;
}

function failureMessage(status: number): string {
  if (status === 401 || status === 403) return "You don't have access to this file.";
  if (status === 404) return 'This file is no longer available.';
  return "Couldn't load this file.";
}

/**
 * Request a presigned GET. The URL stays inside this module; callers receive
 * either `{ ok: true }` with a fetchable hop already consumed, or an error.
 * Use {@link loadAttachmentPreview} for UI.
 */
export async function presignAttachmentGet(
  companyUid: string,
  vaultPath: string,
  deps?: AttachmentPresignDeps,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const company = companyUid.trim();
  const key = vaultPath.trim();
  if (!company || !key) {
    return { ok: false, message: ATTACHMENT_MISSING_COMPANY };
  }
  const invoke = invokeFn(deps);
  let response: NativeHqProResponse;
  try {
    response = (await invoke('hq_pro_fetch', {
      url: '/v1/files/presign',
      method: 'POST',
      body: JSON.stringify({ company, op: 'get', key }),
    })) as NativeHqProResponse;
  } catch {
    return { ok: false, message: "Couldn't reach the file service." };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, message: failureMessage(response.status) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch {
    return { ok: false, message: 'This file is no longer available.' };
  }
  const signed = presignUrlFromResult(parsed);
  const url = signed?.url?.trim() ?? '';
  if (!url) return { ok: false, message: 'This file is no longer available.' };
  return { ok: true, url };
}

function objectUrlFromBytes(bytes: Uint8Array, contentType: string): string {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return URL.createObjectURL(new Blob([copy.buffer], { type: contentType }));
}

/**
 * Fetch attachment bytes at view time. Presigned URLs never leave this
 * function as a return value except inside a short-lived object URL.
 */
export async function loadAttachmentPreview(
  attachment: MessageAttachment,
  deps?: AttachmentPresignDeps,
): Promise<AttachmentPreviewView> {
  if (!isInlineAttachmentPreview(attachment)) return { kind: 'unsupported' };

  const companyUid = (attachment.companyUid ?? '').trim();
  const vaultPath = (attachment.vaultPath ?? '').trim();
  if (!companyUid || !vaultPath) {
    return { kind: 'error', message: ATTACHMENT_MISSING_COMPANY };
  }

  const signed = await presignAttachmentGet(companyUid, vaultPath, deps);
  if (!signed.ok) return { kind: 'error', message: signed.message };

  const invoke = invokeFn(deps);
  let result: VaultGetResult;
  try {
    result = (await invoke('vault_s3_get', {
      url: signed.url,
      maxBytes: MAX_ATTACHMENT_PREVIEW_BYTES,
    })) as VaultGetResult;
  } catch (error) {
    const detail = error instanceof Error ? error.message.toLowerCase() : '';
    if (/too.?large|exceeds.*byte|read limit|size limit/.test(detail)) {
      return { kind: 'error', message: 'This file is too large to preview safely.' };
    }
    return { kind: 'error', message: "Couldn't load this file." };
  }

  if (result.status < 200 || result.status >= 300) {
    return { kind: 'error', message: failureMessage(result.status) };
  }

  const bytes = Uint8Array.from(result.body);
  if (bytes.byteLength > MAX_ATTACHMENT_PREVIEW_BYTES) {
    return { kind: 'error', message: 'This file is too large to preview safely.' };
  }

  const contentType = (result.contentType || attachment.contentType || '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase();
  const previewKind = filesUi.filePreviewKind(attachment.name);

  if (previewKind === 'image' || (contentType.startsWith('image/') && contentType !== 'image/svg+xml')) {
    const mime = contentType.startsWith('image/') ? contentType : 'image/png';
    return {
      kind: 'image',
      objectUrl: objectUrlFromBytes(bytes, mime),
      contentType: mime,
    };
  }

  if (previewKind === 'pdf' || contentType === 'application/pdf') {
    return {
      kind: 'pdf',
      objectUrl: objectUrlFromBytes(bytes, 'application/pdf'),
    };
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'unsupported' };
  }

  if (previewKind === 'markdown') return { kind: 'markdown', text };
  return { kind: 'text', text };
}
