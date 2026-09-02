// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { mount, unmount } from 'svelte';
import { agentAvatarAssets } from '@hq/ui';
import IdentityMark from './IdentityMark.svelte';

const dir = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(dir, '../../../../../packages/ui/src');
const conversation = readFileSync(join(dir, 'Conversation.svelte'), 'utf8');
const chatSidebar = readFileSync(join(uiRoot, 'chat/ChatSidebar.svelte'), 'utf8');
const desktopApp = readFileSync(join(uiRoot, 'shell/DesktopApp.svelte'), 'utf8');
const channelConversation = readFileSync(
  join(uiRoot, 'chat/messaging/ChannelConversation.svelte'),
  'utf8',
);

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
});

describe('sync messaging agent-avatar contract', () => {
  it('passes agent kind + agentUid into IdentityMark on surviving DM surfaces', () => {
    // MessagesShell is gone; pin Conversation plus the desktop workspace surfaces.
    expect(conversation).toContain(
      "kind={isAgentUid(msg.fromPersonUid) ? 'agent' : 'person'}",
    );
    expect(conversation).toContain('agentUid={msg.fromPersonUid}');
    expect(desktopApp).toContain(
      'kind={isAgentUid(selectedRow.personUid ?? "")',
    );
    expect(desktopApp).toContain('agentUid={selectedRow.personUid}');
    expect(channelConversation).toContain('agentUid={msg.fromPersonUid}');
    expect(channelConversation).toContain('kind="agent"');
    expect(chatSidebar).toContain('rowAvatar(row, avatarByUid)');
    expect(chatSidebar).toContain('data-testid="chat-dm-avatar"');
  });

  it('renders a generated avatar for an agent IdentityMark', () => {
    component = mount(IdentityMark, {
      target: host,
      props: { kind: 'agent', agentUid: 'agt_x', label: 'X' },
    });

    const img = host.querySelector('img.avatar-img');
    expect(img).not.toBeNull();
    expect(agentAvatarAssets).toContain(img?.getAttribute('src'));
  });
});
