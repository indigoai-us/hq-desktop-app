import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-003 — Desktop: unified conversation sidebar (source contracts).
 *
 * Locks the chat-first shell: ChatSidebar is the primary surface, titlebar
 * carries chat-era chrome, and the new chat/ files follow Corey's hard UI
 * rules (no card radii, weight ≤ 500, monochrome, no emoji chrome).
 */

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
const chatSidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
const sidebarModel = readRepoFile('src/desktop-alt/chat/sidebar-model.ts');
const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');

describe('US-003: unified conversation sidebar — shell integration', () => {
  it('mounts ChatSidebar as the primary desktop-alt sidebar surface', () => {
    expect(desktopApp).toContain("import ChatSidebar from './chat/ChatSidebar.svelte'");
    expect(desktopApp).toContain('<ChatSidebar');
    expect(desktopApp).toContain('oncommand={handleOpenCommandPalette}');
    expect(desktopApp).toContain("onnavigateMessages={() => navigate({ kind: 'messages' })}");
    // Files mode still uses the dedicated files sidebar.
    expect(desktopApp).toContain('<FilesModeSidebar');
    // US-018: V4Sidebar retired entirely — ChatSidebar is the only primary mount.
    expect(desktopApp).not.toContain('<V4Sidebar');
    expect(desktopApp).not.toContain('V4Sidebar');
  });

  it('wires titlebar meetings / notifications stubs to real routes', () => {
    expect(desktopApp).toContain("onopenMeetings={() => navigate({ kind: 'meetings' })}");
    // US-012: bell opens the dedicated notifications feed (NOTIF store).
    expect(desktopApp).toContain('onopenNotifications={openNotifications}');
    expect(desktopApp).toContain("navigate({ kind: 'notifications' })");
  });
});

describe('US-003: ChatSidebar structure', () => {
  it('exposes scope dropdown, new-message, search, filter, pinned/day groups, history, footer', () => {
    expect(chatSidebar).toContain('data-testid="chat-sidebar"');
    expect(chatSidebar).toContain('data-testid="chat-scope-pill"');
    expect(chatSidebar).toContain('data-testid="chat-scope-menu"');
    expect(chatSidebar).toContain('data-testid="chat-scope-option"');
    expect(chatSidebar).toContain('All companies');
    expect(chatSidebar).toContain('buildScopeOptions');
    expect(chatSidebar).not.toContain('cycleScope');
    expect(chatSidebar).toContain('data-testid="chat-new-message"');
    expect(chatSidebar).toContain('data-testid="chat-search"');
    expect(chatSidebar).toContain('data-testid="chat-filter"');
    expect(chatSidebar).toContain('data-testid="chat-filter-popover"');
    expect(chatSidebar).toContain('data-testid="chat-last-week"');
    expect(chatSidebar).toContain('data-testid="chat-show-history"');
    expect(chatSidebar).toContain('data-testid="chat-user-card"');
    expect(chatSidebar).toContain('data-testid="chat-user-menu"');
    expect(chatSidebar).toContain('Pinned');
    expect(chatSidebar).toContain('Show all history…');
    expect(chatSidebar).toContain('SYNCED');
    expect(chatSidebar).toContain('Settings');
    expect(chatSidebar).toContain('Sign out');
  });

  it('documents company-scope hotkeys Cmd+0 / 1–5 / P', () => {
    expect(chatSidebar).toContain('scopeFromHotkey');
    expect(sidebarModel).toContain("if (k === '0') return 'all'");
    expect(sidebarModel).toContain("if (k === 'p') return 'personal'");
    expect(sidebarModel).toContain('/^[1-5]$/');
    expect(chatSidebar).toContain("window.addEventListener('keydown', onKeyDown, true)");
  });

  it('renders channel # glyph, DM avatar, group member-count, numeric badge + DM dot', () => {
    expect(chatSidebar).toContain('chat-glyph');
    expect(chatSidebar).toContain('data-testid="chat-dm-avatar"');
    expect(chatSidebar).toContain('data-testid="chat-group-avatar"');
    expect(chatSidebar).toContain('data-testid="chat-unread-badge"');
    expect(chatSidebar).toContain('data-testid="chat-unread-dot"');
    // Channel open clears server unread via existing path.
    expect(chatSidebar).toContain("invoke('mark_channel_read'");
    expect(chatSidebar).toContain('clearChannelUnread');
    // DMs clear local dots + numeric pair unread, then mark_dm_thread_read.
    expect(chatSidebar).toContain('clearDmDot');
    expect(chatSidebar).toContain('clearPairUnread');
    expect(chatSidebar).toContain("invoke('mark_dm_thread_read'");
  });

  it('loads list_contacts + list_channels (cache-first) and opens command palette via oncommand', () => {
    expect(chatSidebar).toContain("invoke<ContactsResponse>('list_contacts')");
    expect(chatSidebar).toContain("invoke<ChannelsResponse | null>('list_channels')");
    expect(chatSidebar).toContain('loadConversationCache');
    expect(chatSidebar).toContain('saveConversationCache');
    expect(chatSidebar).toContain('oncommand?.()');
    expect(chatSidebar).toContain("Sort");
    expect(chatSidebar).toContain('Recent');
    expect(chatSidebar).toContain('Projects');
    expect(chatSidebar).toContain('People');
  });

  it('filter popover includes SORT + SHOW + PEOPLE', () => {
    const css = normalize(chatSidebar);
    expect(css).toContain('Sort');
    expect(css).toContain('Show');
    expect(chatSidebar).toContain("sortMode = 'recent'");
    expect(chatSidebar).toContain("sortMode = 'type'");
    expect(chatSidebar).toContain("showFilter = 'all'");
    expect(chatSidebar).toContain("showFilter = 'projects'");
    expect(chatSidebar).toContain("showFilter = 'dms'");
  });
});

describe('US-003: titlebar chat-era chrome', () => {
  it('renders HQ wordmark, DAY · DATE, video, bell, and Core pill', () => {
    expect(titleBar).toContain('data-testid="titlebar-wordmark"');
    expect(titleBar).toContain('>HQ<');
    expect(titleBar).toContain('data-testid="titlebar-day-date"');
    expect(titleBar).toContain('titlebarDayDate');
    expect(titleBar).toContain('data-testid="titlebar-meetings"');
    expect(titleBar).toContain('data-testid="titlebar-notifications"');
    expect(titleBar).toContain('data-testid="titlebar-core-pill"');
    expect(titleBar).toContain('onopenMeetings');
    expect(titleBar).toContain('onopenNotifications');
  });
});

describe('US-003: hard UI rules on new chat files', () => {
  it('conversation rows and cards use border-radius 0 (avatars may be round)', () => {
    const css = chatSidebar;
    // Structural surfaces stay square.
    expect(css).toMatch(/\.chat-row\s*\{[\s\S]*?border-radius:\s*0/);
    expect(css).toMatch(/\.chat-popover\s*\{[\s\S]*?border-radius:\s*0/);
    expect(css).toMatch(/\.chat-modal\s*\{[\s\S]*?border-radius:\s*0/);
    expect(css).toMatch(/\.chat-user-card\s*\{[\s\S]*?border-radius:\s*0/);
    expect(css).toMatch(/\.chat-collapse-row\s*\{[\s\S]*?border-radius:\s*0/);
    // Avatar exception: circular monograms only.
    expect(css).toMatch(/\.chat-avatar\s*\{[\s\S]*?border-radius:\s*50%/);
  });

  it('never uses font-weight above 500 in chat sidebar styles', () => {
    const weights = [...chatSidebar.matchAll(/font-weight:\s*([0-9]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(weights.length).toBeGreaterThan(0);
    for (const w of weights) {
      expect(w, `font-weight ${w} exceeds 500`).toBeLessThanOrEqual(500);
    }
    expect(chatSidebar).not.toMatch(/font-weight:\s*(bold|bolder|600|700|800|900)/i);
  });

  it('stays monochrome (no accent rails / rainbow) aside from the SYNCED status dot', () => {
    // No colored edge rails or accent bars in the new component.
    expect(chatSidebar).not.toMatch(/border-left:\s*[0-9]+px\s+solid\s+#(f|e|c|a|9)/i);
    expect(chatSidebar).not.toMatch(/--v4-brand-accent/);
    // Status dot may use semantic success green.
    expect(chatSidebar).toContain('background: var(--v4-ok)');
    // No emoji in UI chrome strings.
    expect(chatSidebar).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(sidebarModel).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('unread rows use weight 500 (not 600+)', () => {
    expect(chatSidebar).toMatch(
      /\.chat-row\.unread \.chat-row-title\s*\{[\s\S]*?font-weight:\s*500/,
    );
  });
});

describe('US-003: pure model surface', () => {
  it('exports day grouping, scope filters, pins, and absent-safe DM unread', () => {
    expect(sidebarModel).toContain('export function groupByDay');
    expect(sidebarModel).toContain('export function filterByCompanyScope');
    expect(sidebarModel).toContain('export function filterByShow');
    expect(sidebarModel).toContain('export function sortConversations');
    expect(sidebarModel).toContain('export function loadPins');
    expect(sidebarModel).toContain('export function normalizeDm');
    // US-011: numeric pair unread when present; legacy dot when absent.
    expect(sidebarModel).toContain('hasServerUnread');
    expect(sidebarModel).toContain('export function applyPairUnreads');
    expect(sidebarModel).toContain("PINS_STORAGE_KEY = 'hq.chat.pins'");
    expect(sidebarModel).toContain('LAST WEEK');
  });
});
