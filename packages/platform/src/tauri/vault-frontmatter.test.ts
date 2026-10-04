import { describe, expect, it } from 'vitest';

import { createSyncPlatformAdapter } from './sync-adapter.js';

describe('sync adapter vault frontmatter reads', () => {
  it('maps the auth session and bounded frontmatter commands with their arguments', async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'get_auth_session') {
          return {
            accountId: 'cognito-account-a',
            generation: 1,
            status: 'active',
            reason: null,
          };
        }
        return '---\nchannel: meeting\n---\n';
      },
      fetch: (() => {
        throw new Error('the adapter must not use window.fetch');
      }) as unknown as typeof globalThis.fetch,
    });

    const authSession = await adapter.identity.getAuthSession!();
    const frontmatter = await adapter.files.vault!.readFrontmatter(
      'personal/sources/meetings/legacy.md',
    );

    expect(authSession).toEqual({
      ok: true,
      value: {
        accountId: 'cognito-account-a',
        generation: 1,
        status: 'active',
        reason: null,
      },
    });
    expect(frontmatter).toEqual({
      ok: true,
      value: '---\nchannel: meeting\n---\n',
    });
    expect(calls).toEqual([
      { command: 'get_auth_session', args: undefined },
      {
        command: 'read_vault_note_frontmatter',
        args: { path: 'personal/sources/meetings/legacy.md' },
      },
    ]);
  });
});
