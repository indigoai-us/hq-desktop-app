import { describe, expect, it } from 'vitest';
import {
  formatAttachmentSize,
  parseAttachment,
  parseSystemEvent,
  shouldHideSystemMessage,
} from './channelMessageModels';

describe('parseSystemEvent', () => {
  it('maps known line types to render models with default titles', () => {
    for (const type of ['run_started', 'run_progress', 'pr_opened', 'deploy', 'file_added'] as const) {
      const model = parseSystemEvent({
        v: 1,
        type,
        meshThreadId: 'th',
        meshEventId: 'ev',
      });
      expect(model).not.toBeNull();
      expect(model?.kind).toBe('line');
      if (model?.kind === 'line') {
        expect(model.type).toBe(type);
        expect(model.title.length).toBeGreaterThan(0);
      }
    }
  });

  it('prefers provided title/summary on line events', () => {
    const model = parseSystemEvent({
      v: 1,
      type: 'deploy',
      meshThreadId: 'th',
      meshEventId: 'ev',
      title: 'Staging live',
      summary: 'v2.4.1',
    });
    expect(model).toEqual({
      kind: 'line',
      type: 'deploy',
      title: 'Staging live',
      summary: 'v2.4.1',
    });
  });

  it('maps run_complete to a card with optional action URLs', () => {
    const withUrls = parseSystemEvent({
      v: 1,
      type: 'run_complete',
      meshThreadId: 'th',
      meshEventId: 'ev',
      title: 'Build finished',
      summary: 'All green',
      previewUrl: 'https://example.com/preview',
      diffUrl: 'https://example.com/diff',
    });
    expect(withUrls).toEqual({
      kind: 'run_complete',
      title: 'Build finished',
      summary: 'All green',
      previewUrl: 'https://example.com/preview',
      diffUrl: 'https://example.com/diff',
    });

    const withoutUrls = parseSystemEvent({
      v: 1,
      type: 'run_complete',
      meshThreadId: 'th',
      meshEventId: 'ev',
      title: 'Done',
    });
    expect(withoutUrls).toEqual({
      kind: 'run_complete',
      title: 'Done',
      summary: null,
      previewUrl: null,
      diffUrl: null,
    });
  });

  it('returns null for unknown type, wrong v, or malformed payload', () => {
    expect(parseSystemEvent(null)).toBeNull();
    expect(parseSystemEvent(undefined)).toBeNull();
    expect(parseSystemEvent('run_started')).toBeNull();
    expect(parseSystemEvent([])).toBeNull();
    expect(parseSystemEvent({ v: 1, type: 'totally_unknown', meshThreadId: 't', meshEventId: 'e' })).toBeNull();
    expect(parseSystemEvent({ v: 2, type: 'run_started', meshThreadId: 't', meshEventId: 'e' })).toBeNull();
    expect(parseSystemEvent({ v: 1 })).toBeNull(); // missing type
    expect(parseSystemEvent({ type: 'run_started' })).not.toBeNull(); // absent v tolerated as v1
  });

  it('tolerates extra unknown keys on known types', () => {
    const model = parseSystemEvent({
      v: 1,
      type: 'pr_opened',
      meshThreadId: 'th',
      meshEventId: 'ev',
      title: 'PR #12',
      futureField: { nested: true },
    });
    expect(model?.kind).toBe('line');
  });
});

describe('shouldHideSystemMessage', () => {
  it('hides system-kind messages with unknown/missing events', () => {
    expect(shouldHideSystemMessage({ messageKind: 'system', systemEvent: { v: 1, type: 'nope' } })).toBe(
      true,
    );
    expect(shouldHideSystemMessage({ messageKind: 'system' })).toBe(true);
    expect(
      shouldHideSystemMessage({
        messageKind: 'system',
        systemEvent: { v: 1, type: 'run_started', meshThreadId: 't', meshEventId: 'e' },
      }),
    ).toBe(false);
    expect(shouldHideSystemMessage({ messageKind: undefined, systemEvent: null })).toBe(false);
  });
});

describe('parseAttachment / formatAttachmentSize', () => {
  it('builds a file-card model with size caption when sizeBytes present', () => {
    expect(
      parseAttachment({
        vaultPath: 'companies/acme/notes.md',
        name: 'notes.md',
        sizeBytes: 2048,
        kind: 'file',
      }),
    ).toEqual({
      vaultPath: 'companies/acme/notes.md',
      name: 'notes.md',
      sizeLabel: '2.0 KB',
      kind: 'file',
      caption: 'FILES · 2.0 KB',
    });
  });

  it('omits size from caption when sizeBytes/kind missing', () => {
    const model = parseAttachment({
      vaultPath: 'companies/acme/brief.pdf',
      name: 'brief.pdf',
    });
    expect(model).toEqual({
      vaultPath: 'companies/acme/brief.pdf',
      name: 'brief.pdf',
      sizeLabel: null,
      kind: null,
      caption: 'FILES',
    });
  });

  it('returns null for unusable payloads', () => {
    expect(parseAttachment(null)).toBeNull();
    expect(parseAttachment({})).toBeNull();
    expect(parseAttachment({ vaultPath: '', name: '' })).toBeNull();
  });

  it('formats byte sizes across units', () => {
    expect(formatAttachmentSize(null)).toBeNull();
    expect(formatAttachmentSize(-1)).toBeNull();
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(1024)).toBe('1.0 KB');
    expect(formatAttachmentSize(12 * 1024 * 1024)).toBe('12 MB');
  });
});
