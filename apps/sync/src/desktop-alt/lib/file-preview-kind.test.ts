import { describe, expect, it } from 'vitest';
import { filePreviewKind, isImagePreviewPath, isPdfPreviewPath } from './file-preview-kind';

describe('filePreviewKind', () => {
  it('classifies markdown, images, pdf, and text', () => {
    expect(filePreviewKind('companies/x/knowledge/a.md')).toBe('markdown');
    expect(filePreviewKind('assets/hq/aleena-avatar.png')).toBe('image');
    expect(filePreviewKind('assets/logo.JPG')).toBe('image');
    expect(filePreviewKind('assets/hq/HQ.svg')).toBe('image');
    expect(filePreviewKind('docs/spec.pdf')).toBe('pdf');
    expect(filePreviewKind('src/foo.ts')).toBe('text');
    expect(filePreviewKind('config.yaml')).toBe('text');
    expect(filePreviewKind('.env')).toBe('text');
  });

  it('helpers match kinds', () => {
    expect(isImagePreviewPath('a.png')).toBe(true);
    expect(isPdfPreviewPath('a.pdf')).toBe(true);
    expect(isImagePreviewPath('a.md')).toBe(false);
  });
});
