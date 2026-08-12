import { describe, expect, it } from 'vitest';
import {
  CHANNEL_FILES_DENIED_MESSAGE,
  CHANNEL_FILES_LIST_DENIED_MESSAGE,
  CHANNEL_FILES_EMPTY_MESSAGE,
  classifyAccessError,
  classifyFileIcon,
  classifyPreviewError,
  findFileIndexByVaultPath,
  formatFileDateLabel,
  formatUploaderCaption,
  isAgentUploader,
  mapChannelFileRow,
  normalizeVaultPath,
  parseChannelFilesResponse,
  type ChannelFileItem,
} from './channelFilesModel';

function wireRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'ev_1',
    messageEventId: 'msg_1',
    attachment: {
      vaultPath: 'companies/acme/docs/brief.md',
      name: 'brief.md',
      sizeBytes: 2048,
      kind: 'markdown',
    },
    fromUid: 'prs_maya',
    fromDisplayName: 'Maya Chen',
    createdAt: '2026-03-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('parseChannelFilesResponse', () => {
  it('maps a well-formed files list to view models', () => {
    const { files, nextCursor } = parseChannelFilesResponse({
      files: [wireRow()],
      nextCursor: 'cur_next',
    });
    expect(files).toHaveLength(1);
    expect(nextCursor).toBe('cur_next');
    const row = files[0]!;
    expect(row.key).toBe('ev_1');
    expect(row.vaultPath).toBe('companies/acme/docs/brief.md');
    expect(row.name).toBe('brief.md');
    expect(row.sizeBytes).toBe(2048);
    expect(row.kind).toBe('markdown');
    expect(row.uploaderLabel).toBe('Maya Chen');
    expect(row.isAgent).toBe(false);
    expect(row.caption).toMatch(/^MAYA CHEN · /);
    expect(row.iconKind).toBe('markdown');
  });

  it('is absent-safe for null/undefined/missing files', () => {
    expect(parseChannelFilesResponse(null)).toEqual({ files: [], nextCursor: null });
    expect(parseChannelFilesResponse(undefined)).toEqual({ files: [], nextCursor: null });
    expect(parseChannelFilesResponse({})).toEqual({ files: [], nextCursor: null });
    expect(parseChannelFilesResponse({ files: null })).toEqual({ files: [], nextCursor: null });
    expect(parseChannelFilesResponse('nope')).toEqual({ files: [], nextCursor: null });
  });

  it('drops malformed rows without throwing', () => {
    const { files } = parseChannelFilesResponse({
      files: [
        null,
        'x',
        { eventId: 'no-attachment' },
        { attachment: {} },
        { attachment: { vaultPath: '', name: '' } },
        wireRow({ eventId: 'good' }),
      ],
    });
    expect(files).toHaveLength(1);
    expect(files[0]!.key).toBe('good');
  });

  it('tolerates missing optional attachment fields', () => {
    const { files } = parseChannelFilesResponse({
      files: [
        wireRow({
          attachment: {
            vaultPath: 'companies/acme/a.txt',
            name: 'a.txt',
          },
        }),
      ],
    });
    expect(files[0]!.sizeBytes).toBeNull();
    expect(files[0]!.kind).toBeNull();
  });
});

describe('uploader / agent captions', () => {
  it('detects agent identity via agt_ / agent_ / agent: prefixes', () => {
    expect(isAgentUploader('agt_bot')).toBe(true);
    expect(isAgentUploader('agent_helper')).toBe(true);
    expect(isAgentUploader('agent:worker')).toBe(true);
    expect(isAgentUploader('prs_maya')).toBe(false);
    expect(isAgentUploader('')).toBe(false);
    expect(isAgentUploader(null)).toBe(false);
  });

  it('upper-cases UPLOADER · DATE captions including agent uploaders', () => {
    const agent = mapChannelFileRow(
      wireRow({
        fromUid: 'agt_izzy',
        fromDisplayName: 'Fleet Izzy',
        createdAt: '2026-01-05T00:00:00.000Z',
      }),
    );
    expect(agent).not.toBeNull();
    expect(agent!.isAgent).toBe(true);
    expect(agent!.caption).toMatch(/^FLEET IZZY · /);
    expect(agent!.caption).toContain(agent!.dateLabel);
    expect(agent!.dateLabel).toBe(formatFileDateLabel('2026-01-05T00:00:00.000Z'));

    expect(formatUploaderCaption('corey', 'mar 3')).toBe('COREY · MAR 3');
    expect(formatUploaderCaption('solo', '')).toBe('SOLO');
  });

  it('falls back display name from agent uid when name missing', () => {
    const row = mapChannelFileRow(
      wireRow({
        fromUid: 'agent:codex',
        fromDisplayName: '',
      }),
    );
    expect(row!.uploaderLabel).toBe('codex');
    expect(row!.isAgent).toBe(true);
  });
});

describe('deep-link matching', () => {
  const files: ChannelFileItem[] = [
    mapChannelFileRow(wireRow({ eventId: 'a', attachment: { vaultPath: 'companies/x/a.md', name: 'a.md' } }))!,
    mapChannelFileRow(wireRow({ eventId: 'b', attachment: { vaultPath: 'companies/x/b.pdf', name: 'b.pdf' } }))!,
  ];

  it('finds a matching vaultPath index', () => {
    expect(findFileIndexByVaultPath(files, 'companies/x/b.pdf')).toBe(1);
    expect(findFileIndexByVaultPath(files, '  companies/x/a.md  ')).toBe(0);
  });

  it('returns -1 when the deep-link target is absent (no crash)', () => {
    expect(findFileIndexByVaultPath(files, 'companies/x/missing.md')).toBe(-1);
    expect(findFileIndexByVaultPath(files, null)).toBe(-1);
    expect(findFileIndexByVaultPath(files, '')).toBe(-1);
    expect(findFileIndexByVaultPath([], 'companies/x/a.md')).toBe(-1);
  });

  it('normalizes slashes for matching', () => {
    expect(normalizeVaultPath('companies//x/a.md')).toBe('companies/x/a.md');
    expect(normalizeVaultPath('a\\b')).toBe('a/b');
    expect(normalizeVaultPath('  ./docs/x.md  ')).toBe('docs/x.md');
  });
});

describe('access error classification', () => {
  it('classifies missing endpoint as unsupported (empty state)', () => {
    expect(classifyAccessError('Request failed (status 404)')).toBe('unsupported');
    expect(classifyAccessError('not found')).toBe('unsupported');
    expect(classifyAccessError('Unknown route /v1/notify/channels/x/files')).toBe(
      'unsupported',
    );
    expect(classifyAccessError('route error: no handler')).toBe('unsupported');
  });

  it('classifies ACL / membership / scope as denied', () => {
    expect(classifyAccessError('Request failed (status 403)')).toBe('denied');
    expect(classifyAccessError('forbidden')).toBe('denied');
    expect(classifyAccessError('company files are not authorized: "acme"')).toBe(
      'denied',
    );
    expect(classifyAccessError('membership required')).toBe('denied');
    expect(classifyAccessError('outside desktop read scope')).toBe('denied');
    expect(classifyPreviewError('access denied')).toBe('denied');
  });

  it('classifies other errors as generic', () => {
    expect(classifyAccessError('Network error: timeout')).toBe('generic');
    expect(classifyAccessError('Could not parse response')).toBe('generic');
    expect(classifyAccessError('')).toBe('generic');
  });

  it('exposes clean denied / empty copy without raw error text', () => {
    expect(CHANNEL_FILES_DENIED_MESSAGE).toBe("You don't have access to this file.");
    // List-level denial labels the whole list, so it reads plural.
    expect(CHANNEL_FILES_LIST_DENIED_MESSAGE).toBe(
      "You don't have access to these files.",
    );
    expect(CHANNEL_FILES_EMPTY_MESSAGE).toBe('No files yet');
    expect(CHANNEL_FILES_DENIED_MESSAGE).not.toMatch(/403|forbidden|Request failed/i);
    expect(CHANNEL_FILES_LIST_DENIED_MESSAGE).not.toMatch(/403|forbidden|Request failed/i);
  });
});

describe('icon classification', () => {
  it('reuses file-preview-kind for common extensions', () => {
    expect(classifyFileIcon('doc.md')).toBe('markdown');
    expect(classifyFileIcon('photo.png')).toBe('image');
    expect(classifyFileIcon('spec.pdf')).toBe('pdf');
    expect(classifyFileIcon('notes.txt')).toBe('text');
  });
});
