import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_CHARS,
  MAX_ATTACHMENTS,
  MAX_CONTEXT_CHARS,
  addAttachment,
  attachmentFromMeeting,
  attachmentFromPath,
  attachmentFromSignal,
  attachmentFromVault,
  attachmentLabel,
  composeWithContext,
  contextChars,
  contextSizeLabel,
  exceedsContextBudget,
  formatContextBlock,
  hqRelativePath,
  removeAttachment,
  shortDate,
  signalKindLabel,
  splitContextBlocks,
  type LoadedAttachment,
} from './context-attachments';

const loaded = (overrides: Partial<LoadedAttachment> = {}): LoadedAttachment => ({
  kind: 'meeting',
  title: 'Weekly sync',
  path: '/Users/x/HQ/companies/indigo/sources/meetings/x.md',
  subtitle: '2026-09-01',
  text: 'Notes from the meeting.',
  truncated: false,
  ...overrides,
});

describe('the block format', () => {
  it('wraps the text in an hq-context element with source, HQ-relative path and title', () => {
    expect(formatContextBlock(loaded(), '/Users/x/HQ')).toBe(
      '<hq-context source="meeting" path="companies/indigo/sources/meetings/x.md" title="Weekly sync">\n' +
        'Notes from the meeting.\n' +
        '</hq-context>',
    );
  });

  it('notes truncation inside the block', () => {
    const block = formatContextBlock(loaded({ truncated: true, text: 'head…\n\n' }), '/Users/x/HQ');
    expect(block).toBe(
      '<hq-context source="meeting" path="companies/indigo/sources/meetings/x.md" title="Weekly sync">\n' +
        'head…\n(truncated)\n</hq-context>',
    );
  });

  it('escapes attribute values and keeps an absolute path when the root is unknown', () => {
    const block = formatContextBlock(loaded({ title: 'Q&A "notes" <1>' }));
    expect(block).toContain('title="Q&amp;A &quot;notes&quot; &lt;1&gt;"');
    expect(block).toContain('path="/Users/x/HQ/companies/indigo/sources/meetings/x.md"');
  });

  it('places every block AFTER the user text, in order', () => {
    const message = composeWithContext(
      'What did we decide?  ',
      [loaded(), loaded({ kind: 'signal', title: 'Ship it', path: '/Users/x/HQ/companies/indigo/signals/s.md', text: 'yes' })],
      '/Users/x/HQ',
    );
    expect(message.startsWith('What did we decide?\n\n<hq-context source="meeting"')).toBe(true);
    expect(message.indexOf('source="meeting"')).toBeLessThan(message.indexOf('source="signal"'));
    expect(message.endsWith('</hq-context>')).toBe(true);
    expect(composeWithContext('plain', [])).toBe('plain');
  });

  it('splits a recorded turn back into the words and the tags', () => {
    const message = composeWithContext('Summarise', [loaded()], '/Users/x/HQ');
    expect(splitContextBlocks(message)).toEqual({
      text: 'Summarise',
      attachments: [
        { kind: 'meeting', title: 'Weekly sync', path: 'companies/indigo/sources/meetings/x.md' },
      ],
    });
    // Unescaped on the way back.
    const fancy = composeWithContext('x', [loaded({ title: 'Q&A "notes"' })]);
    expect(splitContextBlocks(fancy).attachments[0]?.title).toBe('Q&A "notes"');
    // A turn with no block is untouched.
    expect(splitContextBlocks('hello')).toEqual({ text: 'hello', attachments: [] });
  });

  it('relativises paths under the HQ root only', () => {
    expect(hqRelativePath('/Users/x/HQ/companies/a.md', '/Users/x/HQ/')).toBe('companies/a.md');
    expect(hqRelativePath('/elsewhere/a.md', '/Users/x/HQ')).toBe('/elsewhere/a.md');
    expect(hqRelativePath('/Users/x/HQ/a.md', '')).toBe('/Users/x/HQ/a.md');
  });
});

describe('chips', () => {
  it('labels a chip as Source · title · subtitle', () => {
    expect(attachmentLabel(loaded())).toBe('Meeting · Weekly sync · 2026-09-01');
    expect(attachmentLabel({ kind: 'vault', title: 'brief.md', path: '/p' })).toBe('File · brief.md');
  });

  it('builds chips from each row shape', () => {
    expect(
      attachmentFromMeeting({ id: 'm', title: 'Sync', date: '2026-09-01T10:00:00Z', path: '/m.md', participants: [], summary: '' }),
    ).toEqual({ kind: 'meeting', title: 'Sync', path: '/m.md', subtitle: '2026-09-01' });
    expect(
      attachmentFromSignal({ id: 's', kind: 'action_item', title: 'Do it', date: null, path: '/s.md', snippet: '' }),
    ).toEqual({ kind: 'signal', title: 'Do it', path: '/s.md', subtitle: 'action item' });
    expect(attachmentFromVault({ path: '/v/brief.md', name: 'brief.md', kind: 'file', bytes: 1, modifiedAt: null })).toEqual({
      kind: 'vault',
      title: 'brief.md',
      path: '/v/brief.md',
    });
    expect(attachmentFromPath('  companies/indigo/knowledge/a.md ')).toEqual({
      kind: 'path',
      title: 'a.md',
      path: 'companies/indigo/knowledge/a.md',
    });
    expect(shortDate('2026-09-01T10:00:00Z')).toBe('2026-09-01');
    expect(signalKindLabel('action_item')).toBe('Action items');
    expect(signalKindLabel('participant_contribution')).toBe('Participant contribution');
  });

  it('caps at four, dedupes by path, and removes by path', () => {
    let list = [] as ReturnType<typeof attachmentFromPath>[];
    for (let i = 0; i < MAX_ATTACHMENTS; i += 1) {
      const next = addAttachment(list, attachmentFromPath(`/f${i}.md`));
      expect(next.error).toBeNull();
      list = next.list;
    }
    expect(list).toHaveLength(4);
    const over = addAttachment(list, attachmentFromPath('/f9.md'));
    expect(over.list).toHaveLength(4);
    expect(over.error).toBe('At most 4 attachments per message.');
    const dupe = addAttachment(list, attachmentFromPath('/f0.md'));
    expect(dupe.list).toHaveLength(4);
    expect(dupe.error).toBeNull();
    expect(removeAttachment(list, '/f1.md').map((entry) => entry.path)).toEqual(['/f0.md', '/f2.md', '/f3.md']);
  });

  it('tracks the running size against the 24k budget', () => {
    const list = [loaded({ text: 'a'.repeat(6000) }), loaded({ path: '/b', text: 'b'.repeat(2400) })];
    expect(contextChars(list)).toBe(8400);
    expect(contextSizeLabel(list)).toBe('2 of 4 · 8.4k / 24k chars');
    expect(contextSizeLabel([])).toBe('0 of 4 · 0 / 24k chars');
    expect(exceedsContextBudget(list, 'c'.repeat(MAX_CONTEXT_CHARS - 8400))).toBe(false);
    expect(exceedsContextBudget(list, 'c'.repeat(MAX_CONTEXT_CHARS - 8400 + 1))).toBe(true);
    expect(ATTACHMENT_CHARS * MAX_ATTACHMENTS).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });
});

describe('splitContextBlocks — a recorded turn that is not a string', () => {
  it('splits null and undefined into an empty turn instead of throwing', () => {
    expect(splitContextBlocks(null)).toEqual({ text: '', attachments: [] });
    expect(splitContextBlocks(undefined)).toEqual({ text: '', attachments: [] });
  });

  it('reads an object as its JSON, so nothing is silently lost', () => {
    expect(splitContextBlocks({ text: 'hi' })).toEqual({ text: '{"text":"hi"}', attachments: [] });
  });
});
