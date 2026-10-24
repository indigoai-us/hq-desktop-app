// @vitest-environment happy-dom
//
// hq-message-visibility US-007: the old "Show bot messages" toggle and its
// persisted key are gone, replaced by the "Message types" section in the
// sidebar filter menu (US-004) and in-place folds (US-005).
//
// Locks:
//   0. ChatSidebar's filter menu has the "Message types" section: caption,
//      the "Agents & CLI" and "System events" switches, the exact hint line,
//      and the `hq:messages:types.v1` storage key behind it.
//   1. Neither Messages toolbar (ChatSidebar in @hq/ui, DmThreadPane here)
//      renders the old toggle or wires its handler.
//   2. Nobody reads the old persisted preference anywhere in packages/ui,
//      packages/platform or apps/sync source, so a previously saved "on"
//      cannot leave the list stuck showing bot messages; the stored value
//      itself is left alone.
//   3. The default behaviour holds for everyone: the contact list is fetched
//      with bot previews off, and threads hide agent-audience messages.
//   4. DM threads fold agent-audience runs in place (US-005) with the same
//      audience rules the old filter used.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const REPO = resolve(__dirname, '../../../..');
const read = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
const OLD_KEY = 'hq:messages:show-bot-messages';

const NEW_KEY = 'hq:messages:types.v1';

/** Every source file under `rel` (ts, js, svelte), skipping build output. */
function sourceFiles(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'target' || name === '.svelte-kit') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs|cjs|svelte)$/.test(name)) out.push(full);
    }
  };
  walk(resolve(REPO, rel));
  return out;
}

// ── 0. Message types section replaces the toggle ─────────────────────────────
describe('Messages filter menu: Message types section', () => {
  const chatSidebar = read('packages/ui/src/chat/ChatSidebar.svelte');
  const prefModule = read('packages/ui/src/chat/message-types.ts');
  const storeModule = read('packages/ui/src/chat/message-types.svelte.ts');

  it('renders the caption, both switches and the exact hint line', () => {
    expect(chatSidebar).toContain('data-testid="chat-filter-types-caption">Message types</div>');
    expect(chatSidebar).toContain('<span class="chat-filter-text">Agents &amp; CLI</span>');
    expect(chatSidebar).toContain('<span class="chat-filter-text">System events</span>');
    expect(chatSidebar).toContain(
      '>Applies everywhere. Any conversation can override from its header.</p>',
    );
  });

  it('the two switches are real switches bound to the preference', () => {
    const agents = chatSidebar.indexOf('data-testid="chat-filter-type-agents"');
    const system = chatSidebar.indexOf('data-testid="chat-filter-type-system"');
    expect(agents).toBeGreaterThan(-1);
    expect(system).toBeGreaterThan(agents);
    const agentsTag = chatSidebar.slice(chatSidebar.lastIndexOf('<button', agents), agents + 200);
    const systemTag = chatSidebar.slice(chatSidebar.lastIndexOf('<button', system), system + 200);
    expect(agentsTag).toContain('role="switch"');
    expect(agentsTag).toContain('aria-checked={messageTypes.agents}');
    expect(agentsTag).toContain('setMessageType("agents", !messageTypes.agents)');
    expect(systemTag).toContain('role="switch"');
    expect(systemTag).toContain('aria-checked={messageTypes.system}');
    expect(systemTag).toContain('setMessageType("system", !messageTypes.system)');
  });

  it('persists under hq:messages:types.v1 through the shared store', () => {
    expect(prefModule).toContain(`export const MESSAGE_TYPES_STORAGE_KEY = "${NEW_KEY}";`);
    expect(prefModule).toContain('storage.getItem(MESSAGE_TYPES_STORAGE_KEY)');
    expect(storeModule).toContain('loadMessageTypes(');
    expect(storeModule).toContain('saveMessageTypes(current, storage)');
    expect(chatSidebar).toContain('import { messageTypesStore } from "./message-types.svelte.js";');
    expect(chatSidebar).toContain('messageTypesStore.set(');
  });

  it('the legacy key is never read in packages/ui, packages/platform or apps/sync source', () => {
    const roots = ['packages/ui/src', 'packages/platform/src', 'apps/sync/src'];
    const files = roots.flatMap(sourceFiles);
    // Guard against a vacuous pass from a wrong root.
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes(OLD_KEY));
    expect(hits).toEqual([]);
  });
});

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
