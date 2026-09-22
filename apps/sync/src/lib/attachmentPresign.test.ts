import { describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from './messageAttachments';
import {
  companySlugForAttachment,
  filesRouteForAttachment,
  isInlineAttachmentPreview,
  loadAttachmentPreview,
  presignAttachmentGet,
} from './attachmentPresign';

function att(name: string, over: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: `att_${name}`,
    vaultPath: `indigo/files/${name}`,
    name,
    companyUid: 'cmp_indigo',
    ...over,
  };
}

describe('companySlugForAttachment', () => {
  it('maps a company uid through the membership list the Files view uses', () => {
    expect(
      companySlugForAttachment(att('a.md'), [
        { uid: 'cmp_other', slug: 'other' },
        { cloudUid: 'cmp_indigo', slug: 'indigo' },
      ]),
    ).toBe('indigo');
  });

  it('uses an already-friendly slug and HQ-relative vault paths', () => {
    expect(companySlugForAttachment(att('a.md', { companyUid: 'indigo' }))).toBe('indigo');
    expect(
      companySlugForAttachment(
        att('a.md', {
          companyUid: 'cmp_unknown',
          vaultPath: 'companies/indigo/knowledge/a.md',
        }),
      ),
    ).toBe('indigo');
    expect(companySlugForAttachment(att('a.md'))).toBe('indigo');
  });
});

describe('filesRouteForAttachment', () => {
  it('builds files:<slug>:<path> from the attachment vault path', () => {
    expect(filesRouteForAttachment(att('archive.zip'))).toBe(
      'files:indigo:indigo/files/archive.zip',
    );
  });
});

describe('isInlineAttachmentPreview', () => {
  it('inlines images, pdfs, and text/markdown, but not zip', () => {
    expect(isInlineAttachmentPreview(att('shot.png'))).toBe(true);
    expect(isInlineAttachmentPreview(att('spec.pdf'))).toBe(true);
    expect(isInlineAttachmentPreview(att('notes.md'))).toBe(true);
    expect(isInlineAttachmentPreview(att('readme.txt'))).toBe(true);
    expect(isInlineAttachmentPreview(att('archive.zip'))).toBe(false);
  });
});

describe('presignAttachmentGet', () => {
  it('requests a GET presign through the native hop and never throws the URL', async () => {
    const invoke = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ results: [{ url: 'https://vault.test/secret' }] }),
    }));
    await expect(
      presignAttachmentGet('cmp_indigo', 'indigo/files/shot.png', { invoke }),
    ).resolves.toEqual({ ok: true, url: 'https://vault.test/secret' });
    expect(invoke).toHaveBeenCalledWith('hq_pro_fetch', {
      url: '/v1/files/presign',
      method: 'POST',
      body: JSON.stringify({
        company: 'cmp_indigo',
        op: 'get',
        key: 'indigo/files/shot.png',
      }),
    });
  });
});

describe('loadAttachmentPreview', () => {
  it('skips the network for unsupported types such as zip', async () => {
    const invoke = vi.fn();
    await expect(loadAttachmentPreview(att('archive.zip'), { invoke })).resolves.toEqual({
      kind: 'unsupported',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns image bytes as an object URL', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'hq_pro_fetch') {
        return {
          status: 200,
          body: JSON.stringify({ results: [{ url: 'https://vault.test/shot.png' }] }),
        };
      }
      return {
        status: 200,
        contentType: 'image/png',
        body: [137, 80, 78, 71],
      };
    });
    const preview = await loadAttachmentPreview(att('shot.png'), { invoke });
    expect(preview.kind).toBe('image');
    if (preview.kind === 'image') {
      expect(preview.contentType).toBe('image/png');
      expect(preview.objectUrl.startsWith('blob:')).toBe(true);
      URL.revokeObjectURL(preview.objectUrl);
    }
    expect(invoke).toHaveBeenCalledWith('vault_s3_get', {
      url: 'https://vault.test/shot.png',
      maxBytes: 2 * 1024 * 1024,
    });
  });
});
