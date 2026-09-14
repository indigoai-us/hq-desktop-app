import { describe, expect, it } from 'vitest';
import {
  MAX_PASTE_BYTES,
  binaryFilePlaceholder,
  filesFromDataTransfer,
  isImageFile,
  isTextFile,
  namePastedFile,
  pastedFilePath,
  validatePastedFile,
} from './composer-paste';

function file(name: string, type: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('filesFromDataTransfer', () => {
  it('prefers the files list', () => {
    const png = file('shot.png', 'image/png');
    expect(filesFromDataTransfer({ files: [png], items: [] })).toEqual([png]);
  });

  it('falls back to items when files is empty (WebKit paste)', () => {
    const pdf = file('notes.pdf', 'application/pdf');
    expect(
      filesFromDataTransfer({
        files: [],
        items: [{ kind: 'file', getAsFile: () => pdf } as DataTransferItem],
      }),
    ).toEqual([pdf]);
  });

  it('returns nothing when the clipboard has no files', () => {
    expect(filesFromDataTransfer({ files: [], items: [] })).toEqual([]);
    expect(filesFromDataTransfer(null)).toEqual([]);
  });
});

describe('validatePastedFile', () => {
  it('accepts images and common files', () => {
    expect(validatePastedFile(file('a.png', 'image/png'))).toEqual({ ok: true, kind: 'image' });
    expect(validatePastedFile(file('a.pdf', 'application/pdf'))).toEqual({ ok: true, kind: 'file' });
    expect(validatePastedFile(file('a.txt', 'text/plain'))).toEqual({ ok: true, kind: 'file' });
  });

  it('classifies by extension when type is empty', () => {
    expect(validatePastedFile(file('shot.webp', ''))).toEqual({ ok: true, kind: 'image' });
    expect(validatePastedFile(file('notes.md', ''))).toEqual({ ok: true, kind: 'file' });
  });

  it('rejects unsupported types without consuming the file', () => {
    expect(validatePastedFile(file('virus.exe', 'application/x-msdownload'))).toEqual({
      ok: false,
      error: "virus.exe isn't a supported file type.",
    });
  });

  it('rejects oversized pastes with a size message', () => {
    const huge = file('big.png', 'image/png', MAX_PASTE_BYTES + 1);
    expect(validatePastedFile(huge)).toEqual({
      ok: false,
      error: 'big.png is too large (max 4 MB).',
    });
  });
});

describe('namePastedFile', () => {
  it('unique-names generic screenshot pastes', () => {
    const named = namePastedFile(file('image.png', 'image/png'), 2, new Date('2026-09-10T12:00:00Z'));
    expect(named.name).toBe('pasted-2026-09-10T12-00-00-2.png');
    expect(named.type).toBe('image/png');
  });

  it('leaves real filenames alone', () => {
    const original = file('logo.png', 'image/png');
    expect(namePastedFile(original, 1).name).toBe('logo.png');
  });
});

describe('helpers', () => {
  it('detects images vs text vs binary placeholders', () => {
    expect(isImageFile(file('a.png', 'image/png'))).toBe(true);
    expect(isTextFile(file('a.txt', 'text/plain'))).toBe(true);
    expect(isTextFile(file('a.pdf', 'application/pdf'))).toBe(false);
    expect(pastedFilePath('notes.pdf')).toBe('pasted/notes.pdf');
    expect(binaryFilePlaceholder(file('notes.pdf', 'application/pdf', 2048))).toBe(
      '[Binary file: notes.pdf (2 KB)]',
    );
  });
});
