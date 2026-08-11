import { describe, expect, it } from 'vitest';
import {
  fromV4Route,
  getDesktopSecondarySidebar,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { getV4SidebarModel, V4_NAV_ITEMS } from '../../src/desktop-alt/v4/model';
import type { Workspace } from '../../src/lib/workspaces';
import { readRepoFile } from './harness';

const indigo: Workspace = {
  slug: 'indigo',
  displayName: 'Indigo',
  kind: 'company',
  state: 'synced',
  cloudUid: 'cmp_1',
  bucketName: 'bucket',
  hasLocalFolder: true,
  localPath: '/tmp/HQ/companies/indigo',
  membershipStatus: 'active',
  role: 'member',
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

describe('DESKTOP-016: Messages is a first-class desktop destination', () => {
  it('places Messages next to Inbox and maps both route entry points directly', () => {
    expect(V4_NAV_ITEMS.slice(0, 2)).toEqual([
      { id: 'inbox', label: 'Inbox' },
      { id: 'messages', label: 'Messages' },
    ]);
    expect(getV4SidebarModel({ kind: 'messages' }, [indigo]).nav.find((row) => row.active)?.id)
      .toBe('messages');

    expect(resolvePendingDesktopRoute('messages')).toEqual({ mode: 'internal', route: { kind: 'messages' } });
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'messages' });
    // Notifications remain the chronology/feed destination.
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ mode: 'internal', route: { kind: 'inbox' } });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'inbox' });
    expect(getDesktopSecondarySidebar({ kind: 'messages' }, [indigo])).toBeNull();
  });

  it('mounts the real Messages shell full-height with no page/card wrapper', () => {
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    const shell = readRepoFile('src/components/messaging/MessagesShell.svelte');

    expect(app).toContain(
      "import MessagesShell from '../components/messaging/MessagesShell.svelte';",
    );
    expect(app).toMatch(
      /\{:else if route\.kind === 'messages'\}\s*<MessagesShell embedded=\{true\}\s*\/>/,
    );
    expect(app).not.toMatch(
      /\{:else if route\.kind === 'messages'\}\s*<div class="page">/,
    );
    expect(shell).toContain('embedded?: boolean');
    expect(shell).toContain('class:embedded');
    expect(shell).toContain('data-window="messages"');
    expect(shell).toMatch(
      /\.messages-window\.embedded\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?background:\s*transparent;/,
    );
    expect(shell).toContain(
      "invoke(embedded ? 'mark_messages_viewed' : 'messages_window_ready')",
    );
  });

  it('routes message-person handoffs without consuming the target before the shell mounts', () => {
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    const pending = readRepoFile('src/lib/pendingConversation.ts');

    expect(app).toMatch(
      /function handleMessagePerson\(\): void\s*\{[\s\S]*?navigate\(\{ kind: 'messages' \}\);[\s\S]*?\}/,
    );
    expect(app).not.toMatch(
      /function handleMessagePerson\(\): void\s*\{[\s\S]*?takePendingConversation\(\)/,
    );
    expect(pending).toContain('desktop Messages destination');
  });

  it('exposes sidebar and command access without duplicating an Inbox jump card', () => {
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    const inbox = readRepoFile('src/desktop-alt/pages/InboxPage.svelte');

    expect(app).toContain("id: 'command-go-messages'");
    expect(app).toContain("label: 'Go to Messages'");
    expect(app).toContain("action: () => navigate({ kind: 'messages' })");
    // US-012: InboxPage now receives the in-shell navigate glue.
    expect(app).toContain('<InboxPage onnavigate={navigate} />');
    expect(inbox).not.toContain('onopenmessages');
  });

  it('keeps the dedicated native Messages window mounted as a supported fallback', () => {
    const main = readRepoFile('src/main.ts');
    expect(main).toContain(
      "import MessagesShell from './components/messaging/MessagesShell.svelte';",
    );
    expect(main).toContain("else if (windowLabel === 'messages')");
    expect(main).toContain('Component = MessagesShell as unknown as typeof App');
  });
});
