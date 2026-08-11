import { describe, expect, it } from 'vitest';
import {
  dmConversationTarget,
  shareFilesRoute,
  workspaceActivityRoute,
} from './inbox-routing';

describe('US-012 inbox-routing: shareFilesRoute', () => {
  it('routes a single file share to Files preview of that path', () => {
    expect(shareFilesRoute({ paths: ['docs/a.md'] })).toEqual({
      kind: 'files',
      path: 'docs/a.md',
    });
  });

  it('uses the first non-empty path of a multi-file share', () => {
    expect(shareFilesRoute({ paths: ['', 'projects/x/prd.json', 'docs/b.md'] })).toEqual({
      kind: 'files',
      path: 'projects/x/prd.json',
    });
  });

  it('strips directory-share wildcards and lands on the directory', () => {
    expect(shareFilesRoute({ paths: ['projects/client-redesign/*'] })).toEqual({
      kind: 'files',
      path: 'projects/client-redesign',
    });
    expect(shareFilesRoute({ paths: ['projects/client-redesign/**'] })).toEqual({
      kind: 'files',
      path: 'projects/client-redesign',
    });
  });

  it('whole-vault and empty shares fall back to the Files root', () => {
    expect(shareFilesRoute({ paths: ['*'] })).toEqual({ kind: 'files' });
    expect(shareFilesRoute({ paths: ['**'] })).toEqual({ kind: 'files' });
    expect(shareFilesRoute({ paths: [] })).toEqual({ kind: 'files' });
    expect(shareFilesRoute({ paths: ['   '] })).toEqual({ kind: 'files' });
  });
});

describe('US-012 inbox-routing: workspaceActivityRoute', () => {
  it('routes workspace events to the company overview (US-021)', () => {
    expect(workspaceActivityRoute('indigo')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'overview',
    });
  });

  it('degrades to Inbox when the event carries no company', () => {
    expect(workspaceActivityRoute('')).toEqual({ kind: 'inbox' });
    expect(workspaceActivityRoute('  ')).toEqual({ kind: 'inbox' });
  });
});

describe('US-012 inbox-routing: dmConversationTarget', () => {
  it('maps the DM sender onto a conversation target', () => {
    expect(
      dmConversationTarget({
        fromPersonUid: ' per_123 ',
        fromEmail: 'maya@example.com',
        fromDisplayName: 'Maya Chen',
      }),
    ).toEqual({
      personUid: 'per_123',
      email: 'maya@example.com',
      displayName: 'Maya Chen',
    });
  });

  it('tolerates legacy rows with missing attribution', () => {
    expect(
      dmConversationTarget({
        fromPersonUid: undefined as unknown as string,
        fromEmail: undefined as unknown as string,
        fromDisplayName: undefined as unknown as string,
      }),
    ).toEqual({ personUid: '', email: '', displayName: '' });
  });
});
