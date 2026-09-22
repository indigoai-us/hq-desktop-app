import { describe, expect, it } from 'vitest';
import {
  attachmentStackItems,
  attachmentTypeBadge,
  isFileShareMessage,
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
});
