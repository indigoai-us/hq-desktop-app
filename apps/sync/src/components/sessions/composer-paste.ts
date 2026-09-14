/**
 * Paste/drop intake for the sessions composer.
 *
 * Clipboard screenshots and Finder files arrive as `File`s. This module
 * classifies them, rejects oversized or unsupported items with a message the
 * composer can show without touching the draft, and unique-names generic
 * screenshot pastes so they don't collide.
 *
 * PURE: no DOM, no Tauri. The composer owns FileReader / File.text().
 */

export const MAX_PASTE_BYTES = 4 * 1024 * 1024;
export const MAX_PASTE_MB = MAX_PASTE_BYTES / (1024 * 1024);

const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

const FILE_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

const EXT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const PASTE_ACCEPT = Object.keys(EXT_TYPES)
  .map((ext) => `.${ext}`)
  .join(',');

const GENERIC_PASTE_NAME = /^(image)(\.[a-z0-9]+)?$/i;

export type PasteKind = 'image' | 'file';

export type PasteDecision =
  | { ok: true; kind: PasteKind }
  | { ok: false; error: string };

export function contentTypeForFile(file: File): string {
  const typed = file.type.trim().toLowerCase();
  if (typed) return typed;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TYPES[ext] ?? '';
}

export function isImageFile(file: File): boolean {
  const type = contentTypeForFile(file);
  return IMAGE_TYPES.has(type) || type.startsWith('image/');
}

export function isTextFile(file: File): boolean {
  const type = contentTypeForFile(file);
  if (TEXT_TYPES.has(type)) return true;
  return /\.(txt|md|csv|json)$/i.test(file.name);
}

export function filesFromDataTransfer(
  data:
    | {
        files?: FileList | File[] | null;
        items?: DataTransferItemList | DataTransferItem[] | null;
      }
    | null
    | undefined,
): File[] {
  if (!data) return [];
  const listed = data.files ? Array.from(data.files) : [];
  if (listed.length > 0) return listed;
  const items = data.items ? Array.from(data.items) : [];
  const files: File[] = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile?.();
    if (file) files.push(file);
  }
  return files;
}

export function namePastedFile(file: File, sequence: number, now = new Date()): File {
  const originalName = file.name.trim() || 'image.png';
  if (!isImageFile(file) || !GENERIC_PASTE_NAME.test(originalName)) {
    return file;
  }
  const type = contentTypeForFile(file) || 'image/png';
  const ext =
    type.split('/')[1]?.replace('jpeg', 'jpg') ||
    file.name.split('.').pop()?.toLowerCase() ||
    'png';
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return new File([file], `pasted-${stamp}-${sequence}.${ext}`, { type });
}

export function validatePastedFile(file: File): PasteDecision {
  if (file.size > MAX_PASTE_BYTES) {
    return {
      ok: false,
      error: `${file.name} is too large (max ${MAX_PASTE_MB} MB).`,
    };
  }
  const type = contentTypeForFile(file);
  if (IMAGE_TYPES.has(type) || type.startsWith('image/')) {
    return { ok: true, kind: 'image' };
  }
  if (FILE_TYPES.has(type)) {
    return { ok: true, kind: 'file' };
  }
  return { ok: false, error: `${file.name} isn't a supported file type.` };
}

export function pastedFilePath(name: string): string {
  return `pasted/${name}`;
}

export function binaryFilePlaceholder(file: File): string {
  const kb = Math.max(1, Math.round(file.size / 1024));
  return `[Binary file: ${file.name} (${kb} KB)]`;
}
