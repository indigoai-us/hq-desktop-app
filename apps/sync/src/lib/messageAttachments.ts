/**
 * Vault-path file references on a DM or channel message.
 *
 * Mirrors hq-pro `MessageAttachment` (`lib/message-attachments.ts`): metadata
 * only, never file bytes. Additive and absent-safe so older servers that omit
 * `attachments` / extra keys still deserialize.
 */

export const ATTACHMENT_STACK_VISIBLE = 4;

export interface MessageAttachment {
  id: string;
  vaultPath: string;
  name: string;
  sizeBytes?: number;
  kind?: string;
  contentType?: string;
  companyUid: string;
}

/** True when a message should render as the file-share card stack. */
export function isFileShareMessage(msg: {
  messageKind?: string | null;
  attachments?: MessageAttachment[] | null;
}): boolean {
  return msg.messageKind === 'file_share' && (msg.attachments?.length ?? 0) > 0;
}

export function attachmentStackItems<T>(items: T[]): {
  visible: T[];
  overflow: number;
} {
  if (items.length <= ATTACHMENT_STACK_VISIBLE) {
    return { visible: items, overflow: 0 };
  }
  return {
    visible: items.slice(0, ATTACHMENT_STACK_VISIBLE),
    overflow: items.length - ATTACHMENT_STACK_VISIBLE,
  };
}

/** Short type badge for a tile (PDF, MD, PNG, FILE). */
export function attachmentTypeBadge(attachment: MessageAttachment): string {
  const fromName = attachment.name.split('.').pop()?.toUpperCase() ?? '';
  if (fromName && fromName.length <= 5 && fromName !== attachment.name.toUpperCase()) {
    return fromName;
  }
  const kind = (attachment.contentType ?? attachment.kind ?? '').toLowerCase();
  if (kind.startsWith('image/')) return 'IMG';
  if (kind === 'application/pdf') return 'PDF';
  return 'FILE';
}

/** Human size for picker/preview metadata. Empty when size is unknown. */
export function formatAttachmentSize(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
