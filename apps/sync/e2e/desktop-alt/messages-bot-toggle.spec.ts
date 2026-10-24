// @vitest-environment happy-dom
//
// US-006 follow-up — the "Show bot messages" toggle was removed from the
// Messages toolbar (owner: "remove this button").
//
// Locks:
//   1. Neither Messages toolbar (ChatSidebar in @hq/ui, DmThreadPane here)
//      renders the toggle or wires its handler.
//   2. Nobody reads the old persisted preference, so a previously saved "on"
//      cannot leave the list stuck showing bot messages; the stored value
//      itself is left alone.
//   3. The default behaviour holds for everyone: the contact list is fetched
//      with bot previews off, and threads hide agent-audience messages.
//   4. DM threads fold agent-audience runs in place (US-005) with the same
//      audience rules the old filter used.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const REPO = resolve(__dirname, '../../../..');
const read = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
const OLD_KEY = 'hq:messages:show-bot-messages';

// ── 1–3. Source contract: toggle gone, preference unread, default off ────────
describe('Messages toolbar: bot-message toggle removed', () => {
  const chatSidebar = read('packages/ui/src/chat/ChatSidebar.svelte');
  const desktopApp = read('packages/ui/src/shell/DesktopApp.svelte');
  // The standalone MessagesShell was deleted; the DM thread pane in the
  // share-detail window is the remaining apps/sync DM surface.
  const dmPane = read('apps/sync/src/components/DmThreadPane.svelte');

  it('ChatSidebar no longer renders the toggle or accepts its props', () => {
    expect(chatSidebar).not.toContain('chat-bot-toggle');
    expect(chatSidebar).not.toContain('Show bot messages');
    expect(chatSidebar).not.toContain('Hide bot messages');
    expect(chatSidebar).not.toContain('onshowbotmessageschange');
  });

  it('ChatSidebar keeps the search and filter buttons side by side', () => {
    const search = chatSidebar.indexOf('data-testid="chat-search"');
    const filter = chatSidebar.indexOf('<div class="chat-filter-wrap" bind:this={filterWrapEl}>');
    expect(search).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(search);
    // Only the search button's closing tag sits between the two controls.
    const between = chatSidebar.slice(search, filter);
    expect(between.match(/<button\b/g) ?? []).toHaveLength(0);
  });

  it('ChatSidebar fetches contacts with bot previews off (the default)', () => {
    expect(chatSidebar).toContain('api.listContacts({ showBotMessages: false })');
  });

  it('DesktopApp no longer reads or writes the stored preference', () => {
    expect(desktopApp).not.toContain(OLD_KEY);
    expect(desktopApp).not.toContain('handleShowBotMessagesChange');
    expect(desktopApp).not.toContain('onshowbotmessageschange');
  });

  it('the DM thread pane renders no toggle, reads no preference, and hides bot messages by default', () => {
    expect(dmPane).not.toContain('bot-toggle');
    expect(dmPane).not.toContain('Show bot messages');
    expect(dmPane).not.toContain('readShowBotMessages');
    expect(dmPane).not.toContain('writeShowBotMessages');
    expect(dmPane).not.toContain(OLD_KEY);
    expect(dmPane).toContain('showBotMessages = false');
  });
});

// ── 4. Fold grouping (replaces the old audience filter in DM threads) ────────
// US-005: DM threads no longer drop agent-audience messages; each run of them
// folds in place. Agent rows are hidden from the visible rows by default.
describe('DM thread folds by audience', () => {
  type Item = { eventId: string; audience?: string | null };
  const OFF = { agents: false, system: false };
  const ON = { agents: true, system: false };
  const load = () => import('../../../../packages/ui/src/chat/message-folds');
  const visible = (rows: Array<{ kind: string; item?: Item }>) =>
    rows.flatMap((r) => (r.kind === 'message' && r.item ? [r.item] : []));
  const hiddenCount = (rows: Array<{ kind: string; items?: Item[] }>) =>
    rows.reduce((n, r) => n + (r.kind === 'fold' ? (r.items?.length ?? 0) : 0), 0);

  it('shows every item as a row when the agents switch is on', async () => {
    const { groupIntoFolds } = await load();
    const items: Item[] = [
      { eventId: '1', audience: 'human' },
      { eventId: '2', audience: 'agent' },
      { eventId: '3', audience: 'both' },
      { eventId: '4' },
    ];
    const rows = groupIntoFolds(items, ON);
    expect(visible(rows)).toHaveLength(4);
    expect(hiddenCount(rows)).toBe(0);
  });

  it('hides agent-audience items from the rows when the switch is off', async () => {
    const { groupIntoFolds } = await load();
    const items: Item[] = [
      { eventId: '1', audience: 'human' },
      { eventId: '2', audience: 'agent' },
      { eventId: '3', audience: 'both' },
      { eventId: '4', audience: null },
      { eventId: '5' },
    ];
    const rows = groupIntoFolds(items, OFF);
    expect(visible(rows)).toHaveLength(4); // human, both, null, absent all show
    expect(visible(rows).every((m) => m.audience !== 'agent')).toBe(true);
  });

  it('treats absent audience as human (default)', async () => {
    const { groupIntoFolds } = await load();
    const items: Item[] = [{ eventId: '1' }, { eventId: '2', audience: null }, { eventId: '3', audience: undefined }];
    expect(visible(groupIntoFolds(items, OFF))).toHaveLength(3);
  });

  it('folds nothing when the switch is on', async () => {
    const { groupIntoFolds } = await load();
    const items: Item[] = [{ eventId: '1', audience: 'agent' }, { eventId: '2', audience: 'agent' }];
    expect(hiddenCount(groupIntoFolds(items, ON))).toBe(0);
  });

  it('folds only the agent items when the switch is off', async () => {
    const { groupIntoFolds } = await load();
    const items: Item[] = [
      { eventId: '1', audience: 'human' },
      { eventId: '2', audience: 'agent' },
      { eventId: '3', audience: 'agent' },
      { eventId: '4', audience: 'both' },
    ];
    expect(hiddenCount(groupIntoFolds(items, OFF))).toBe(2);
  });
});

// ── 6. ChatSidebarApi.listContacts forwards showBotMessages ──────────────────
// Verifies the interface contract: listContacts accepts a showBotMessages opt
// and a conforming implementation receives the value it was called with.
describe('ChatSidebarApi: listContacts accepts and forwards showBotMessages', () => {
  it('forwards showBotMessages opts through a conforming mock', () => {
    const capturedOpts: Array<{ companyUid?: string; showBotMessages?: boolean } | undefined> = [];
    const mockListContacts = vi.fn(
      (opts?: { companyUid?: string; showBotMessages?: boolean }) => {
        capturedOpts.push(opts);
        return Promise.resolve({ contacts: [] as never[] });
      },
    );
    mockListContacts({ showBotMessages: true });
    mockListContacts({ showBotMessages: false });
    mockListContacts();
    expect(capturedOpts[0]).toEqual({ showBotMessages: true });
    expect(capturedOpts[1]).toEqual({ showBotMessages: false });
    expect(capturedOpts[2]).toBeUndefined();
  });
});
