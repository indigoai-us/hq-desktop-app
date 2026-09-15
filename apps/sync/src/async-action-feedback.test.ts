import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const channelRoster = source('./components/messaging/ChannelRoster.svelte');

describe('user-triggered async action feedback contracts', () => {
  it('keeps the channel roster mounted and retries removal for the failed member', () => {
    const removeBody = channelRoster.match(
      /async function remove\([\s\S]*?\n  \}\n\n  function memberLabel/,
    )?.[0];
    expect(removeBody).toBeTruthy();
    expect(removeBody).not.toContain('error =');
    expect(removeBody).toContain('channelId: targetChannelId');
    expect(removeBody).toContain('if (channelId !== targetChannelId) return;');
    expect(channelRoster).toContain('removeFailure.personUid === m.personUid');
    expect(channelRoster).toContain('remove(m.personUid, true)');
    expect(channelRoster).toContain('aria-busy={removing === m.personUid}');
  });

});
