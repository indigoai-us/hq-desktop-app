import { describe, expect, it } from 'vitest';
import {
  attachmentStackItems,
  attachmentTypeBadge,
  formatAttachmentSize,
  isFileShareMessage,
  isFolderAttachment,
  type MessageAttachment,
} from './messageAttachments';

function att(name: string, over: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: `att_${name}`,
    vaultPath: `indigo/files/${name}`,
    name,
    companyUid: 'cmp_indigo',
    ...over,
  };
}

describe('isFileShareMessage', () => {
  it('requires messageKind file_share and at least one attachment', () => {
    expect(isFileShareMessage({ messageKind: 'file_share', attachments: [att('a.md')] })).toBe(
      true,
    );
    expect(isFileShareMessage({ messageKind: 'file_share', attachments: [] })).toBe(false);
    expect(isFileShareMessage({ messageKind: 'text', attachments: [att('a.md')] })).toBe(false);
    expect(isFileShareMessage({})).toBe(false);
  });
});

describe('attachmentStackItems', () => {
  it('shows all items when there are four or fewer', () => {
    expect(attachmentStackItems([1]).overflow).toBe(0);
    expect(attachmentStackItems([1, 2, 3, 4]).visible).toEqual([1, 2, 3, 4]);
    expect(attachmentStackItems([1, 2, 3, 4]).overflow).toBe(0);
  });

  it('caps visible tiles at four and reports the remainder', () => {
    const seven = [1, 2, 3, 4, 5, 6, 7];
    expect(attachmentStackItems(seven)).toEqual({ visible: [1, 2, 3, 4], overflow: 3 });
  });
});

describe('isFolderAttachment', () => {
  it('detects kind folder and a trailing slash on vaultPath', () => {
    expect(isFolderAttachment(att('docs', { kind: 'folder', vaultPath: 'indigo/docs' }))).toBe(
      true,
    );
    expect(isFolderAttachment(att('docs', { vaultPath: 'indigo/docs/' }))).toBe(true);
    expect(isFolderAttachment(att('q1.md'))).toBe(false);
  });
});

describe('attachmentTypeBadge', () => {
  it('prefers a short file extension', () => {
    expect(attachmentTypeBadge(att('q1.md'))).toBe('MD');
    expect(attachmentTypeBadge(att('shot.png'))).toBe('PNG');
  });

  it('falls back to MIME kind then FILE', () => {
    expect(attachmentTypeBadge(att('noext', { contentType: 'application/pdf' }))).toBe('PDF');
    expect(attachmentTypeBadge(att('noext', { kind: 'image/png' }))).toBe('IMG');
    expect(attachmentTypeBadge(att('noext'))).toBe('FILE');
  });

  it('labels a folder as FOLDER instead of FILE', () => {
    expect(attachmentTypeBadge(att('briefs', { kind: 'folder' }))).toBe('FOLDER');
    expect(attachmentTypeBadge(att('briefs', { vaultPath: 'indigo/briefs/' }))).toBe('FOLDER');
  });
});

describe('formatAttachmentSize', () => {
  it('returns an empty string when size is missing', () => {
    expect(formatAttachmentSize(undefined)).toBe('');
  });

  it('formats bytes, kilobytes, and megabytes', () => {
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(2048)).toBe('2.0 KB');
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
