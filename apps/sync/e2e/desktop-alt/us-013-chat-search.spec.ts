import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-013 — Desktop: search + all-history + ⌘K completeness (source contracts).
 *
 * Locks: all-history message search via `search_messages`, honest recency
 * copy, palette conversation rows, and Tauri command name parity.
 *
 * Does NOT overwrite apps/sync/__tests__/stories/US-013.test.ts (status bar /
 * old shell palette contracts).
 */

describe('US-013: chat search + all-history + ⌘K conversations', () => {
  const chatSidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
  const sidebarModel = readRepoFile('src/desktop-alt/chat/sidebar-model.ts');
  const openTarget = readRepoFile('src/desktop-alt/chat/open-target.ts');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const commandPalette = readRepoFile('src/desktop-alt/components/CommandPalette.svelte');
  const messageSearchCmd = readRepoFile('src-tauri/src/commands/message_search.rs');
  const messageSearchCore = readRepoFile(
    '../../crates/hq-desktop-core/src/message_search.rs',
  );
  const mainRs = readRepoFile('src-tauri/src/main.rs');
  const coreLib = readRepoFile('../../crates/hq-desktop-core/src/lib.rs');

  it('all-history view wires search_messages with company scope + honest copy', () => {
    expect(chatSidebar).toContain('data-testid="chat-show-history"');
    expect(chatSidebar).toContain('Show all history…');
    expect(chatSidebar).toContain('data-testid="chat-history-view"');
    expect(chatSidebar).toContain('data-testid="chat-history-search"');
    expect(chatSidebar).toContain('data-testid="chat-history-helper"');
    // Honest recency-window limitation (must include this exact phrase).
    expect(chatSidebar).toContain('Searches recent messages');
    expect(chatSidebar).toContain('about the last 1,000');
    expect(chatSidebar).toContain("invoke<MessageSearchResult>('search_messages'");
    expect(chatSidebar).toContain('searchCompanyUidFromScope');
    expect(chatSidebar).toContain('historySearchScopeLabel');
    expect(chatSidebar).toContain('openSearchHit');
    expect(chatSidebar).toContain('data-testid="chat-search-hit"');
    // Empty query keeps title-based history list.
    expect(chatSidebar).toContain('searchHistory(filteredRows, historyQuery)');
  });

  it('sidebar-model exports palette ranking + search scoping pure helpers', () => {
    expect(sidebarModel).toContain('export function rankPaletteConversations');
    expect(sidebarModel).toContain('export function conversationQueryScore');
    expect(sidebarModel).toContain('export function conversationKindLabel');
    expect(sidebarModel).toContain('export function searchCompanyUidFromScope');
    expect(sidebarModel).toContain('export function resolveSearchHitRow');
    expect(sidebarModel).toContain('export function searchHitSnippet');
    expect(sidebarModel).toContain('export interface MessageSearchHit');
  });

  it('open-target accepts optional near-hit message metadata', () => {
    expect(openTarget).toContain('export interface OpenChannelOptions');
    expect(openTarget).toContain('messageId');
    expect(openTarget).toContain('requestChannelOpen');
  });

  it('⌘K palette lists type-tagged conversations with company labels', () => {
    expect(desktopApp).toContain('paletteConversations');
    expect(desktopApp).toContain("id: `conversation-${row.id}`");
    expect(desktopApp).toContain('conversationKindLabel');
    expect(desktopApp).toContain('companyLabelFor');
    expect(desktopApp).toContain('openPaletteConversation');
    expect(desktopApp).toContain(
      '<CommandPalette commands={commandItems} onclose={() => (commandPaletteOpen = false)} />',
    );
    expect(commandPalette).toContain("label: 'CONVERSATIONS'");
    expect(commandPalette).toContain("command.id.startsWith('conversation-')");
    expect(commandPalette).toContain('conversationMatchScore');
    expect(commandPalette).toContain('lastActivityAt');
    // Existing command behavior stays intact.
    expect(commandPalette).toContain(
      'fuzzyMatch(`${command.label} ${command.detail} ${command.shortcut ?? \'\'}`, query)',
    );
    expect(commandPalette).toContain('void execute(filteredCommands[highlightedIndex])');
  });

  it('Tauri search_messages command name matches TS invoke and is registered', () => {
    expect(messageSearchCmd).toContain('pub async fn search_messages');
    expect(messageSearchCmd).toContain('/v1/notify/search');
    expect(messageSearchCmd).toContain('build_search_url');
    expect(mainRs).toContain('commands::message_search::search_messages');
    expect(chatSidebar).toContain("'search_messages'");
    expect(coreLib).toContain('pub mod message_search');
    expect(messageSearchCore).toContain('pub fn build_search_url');
    expect(messageSearchCore).toContain('pub struct SearchHit');
    expect(messageSearchCore).toContain('yesterday');
  });
});
