import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import { getDesktopLandingRoute } from '../../src/desktop-alt/route';
import {
  groupByDay,
  normalizeConversations,
  type DmContactInput,
} from '../../src/desktop-alt/chat/sidebar-model';
import type { Channel } from '../../src/lib/channels';

/**
 * Design-gap audit fix wave (G1–G8, S1–S4) — regressions built from the REAL
 * failure shapes the audit captured against production data (not idealized
 * harness fixtures). Each block names the gap it locks.
 */

const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
const chatSidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
const channelView = readRepoFile('src/components/messaging/ChannelView.svelte');
const conversation = readRepoFile('src/components/messaging/Conversation.svelte');
const composeMessage = readRepoFile('src/components/messaging/ComposeMessage.svelte');
const corePopover = readRepoFile('src/desktop-alt/v4/CorePopover.svelte');
const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
const desktopCss = readRepoFile('src/desktop-alt/styles/desktop-alt.css');
const rustMessages = readRepoFile('../../crates/hq-desktop-core/src/messages.rs');

describe('G1: default landing is a conversation, never the project-overview page', () => {
  it('landing route resolves to Messages regardless of workspace/last-visited state', () => {
    expect(getDesktopLandingRoute([], null)).toEqual({ kind: 'messages' });
  });

  it('DesktopApp still seeds from the landing helper (single source of truth)', () => {
    expect(desktopApp).toContain('getDesktopLandingRoute(cachedWorkspaces, initialLastCompanySlug)');
  });
});

describe('G2: real-data timestamps drive sidebar day grouping', () => {
  it('Rust Channel wire shape carries lastActivityAt / lastMessageAt', () => {
    // Root cause: these fields were undeclared on the Rust struct, so serde
    // dropped them and every channel reached the UI with epoch-0 activity.
    expect(rustMessages).toContain('pub last_activity_at: Option<String>');
    expect(rustMessages).toContain('pub last_message_at: Option<String>');
  });

  it('106-row real shape: mixed timestamps do NOT collapse into one LAST WEEK fold', () => {
    const now = new Date(2026, 7, 12, 15, 0).getTime();
    const day = (n: number) => new Date(now - n * 86_400_000).toISOString();
    const channels: Channel[] = [
      { channelId: 'c1', name: 'hq-dev', scope: 'company', lastActivityAt: day(0) },
      { channelId: 'c2', name: 'vyg-dev', scope: 'company', lastMessageAt: day(1) },
      { channelId: 'c3', name: 'general', scope: 'company', lastActivityAt: day(10) },
    ];
    const contacts: DmContactInput[] = [
      { personUid: 'prs_a', displayName: 'Jacob Posel', lastDmAt: day(0) },
    ];
    const grouped = groupByDay(normalizeConversations(channels, contacts), now);
    expect(grouped.sections.length).toBeGreaterThanOrEqual(2);
    expect(grouped.sections[0]!.label.startsWith('TODAY')).toBe(true);
    expect(grouped.lastWeek.map((r) => r.id)).toEqual(['ch:c3']);
  });
});

describe('G3: people directory stays out of the sidebar', () => {
  it('contacts without a conversation (incl. raw agt_* ids) are not conversation rows', () => {
    const contacts: DmContactInput[] = [
      { personUid: 'agt_01kwcayv2bgw9za9993', displayName: '' },
      { personUid: 'prs_alan', displayName: 'Alan Saura' },
    ];
    expect(normalizeConversations([], contacts)).toHaveLength(0);
    expect(
      normalizeConversations([], contacts, { includeContactsWithoutConversation: true }),
    ).toHaveLength(2);
  });

  it('ChatSidebar routes the full directory only into the new-message typeahead', () => {
    expect(chatSidebar).toContain('includeContactsWithoutConversation: true');
    expect(chatSidebar).toContain('filterTypeahead(directoryRows, newMessageQuery)');
  });
});

describe('G4: single click opens a conversation (stash before awaited IPC)', () => {
  it('stashes the open target synchronously before any await in openRow', () => {
    const openRow = chatSidebar.slice(
      chatSidebar.indexOf('async function openRow'),
      chatSidebar.indexOf('function openConnectionRequests'),
    );
    const dmStash = openRow.indexOf('requestConversation(');
    const dmAwait = openRow.indexOf("await invoke('mark_dm_thread_read'");
    const chStash = openRow.indexOf('requestChannelOpen(');
    const chAwait = openRow.indexOf("await invoke('mark_channel_read'");
    expect(dmStash).toBeGreaterThan(-1);
    expect(chStash).toBeGreaterThan(-1);
    expect(dmStash).toBeLessThan(dmAwait);
    expect(chStash).toBeLessThan(chAwait);
  });
});

describe('G5: titlebar Meetings entry', () => {
  it('renders the meetings (video) bar icon wired to the Meetings view', () => {
    expect(titleBar).toContain('data-testid="titlebar-meetings"');
    expect(desktopApp).toContain("onopenMeetings={() => navigate({ kind: 'meetings' })}");
  });
});

describe('G6: Core popover honesty on real data', () => {
  it('never injects visual-QA fixtures on the live path', () => {
    expect(corePopover).toContain('useFixtures = false');
    // The titlebar mounts it without opting into fixtures.
    expect(titleBar).not.toContain('useFixtures={true}');
  });

  it('packs header count and body list share one source (model.packs)', () => {
    expect(corePopover).toContain('{#if model.packs.length === 0}');
    expect(corePopover).not.toContain('{#if packs.length === 0}');
  });

  it('undetected core renders the neutral pill, not green NO DRIFT', () => {
    expect(corePopover).toContain("'core-popover-core-undetected'");
    expect(corePopover).toContain("class:neutral={model.driftPillTone === 'neutral'}");
  });
});

describe('G7: Core pill dot tone', () => {
  it('titlebar derives the dot tone and colors attention amber via --warn', () => {
    expect(titleBar).toContain('corePillDotTone(');
    expect(titleBar).toContain("class:warn={coreDotTone === 'warn'}");
    expect(titleBar).toContain('.v4-core-dot.warn');
    expect(titleBar).toContain('color: var(--warn);');
  });
});

describe('G8: members pill + real-data status popover', () => {
  it('members pill renders on group DMs (gated only on membership)', () => {
    expect(channelView).toContain('{#if !invited}');
    expect(channelView).not.toContain('{#if !isGroup}\n      <button\n        class="member-count-btn"');
  });

  it('status popover uses real members/PRD only — no fixture fallbacks', () => {
    expect(channelView).not.toContain('CHANNEL_STATUS_FIXTURE_MEMBERS');
    expect(channelView).not.toContain('CHANNEL_STATUS_FIXTURE_PRD');
  });

  it('agent-status section renders only when agent data exists', () => {
    expect(channelView).toContain('{#if statusModel.agents.length > 0}');
    expect(channelView).not.toContain('No agents');
  });
});

describe('S1: timestamps hidden at rest, hover-revealed (mono 10px)', () => {
  it('message header time is opacity-0 at rest and revealed on hover', () => {
    const block = conversation.slice(
      conversation.indexOf('.dm-msg-header-time {'),
      conversation.indexOf('.dm-msg:hover .dm-msg-header-time') + 200,
    );
    expect(block).toContain('opacity: 0;');
    expect(block).toContain('font-size: 10px;');
    expect(block).toContain('font-family: var(--font-mono');
    expect(conversation).toContain('.dm-msg:hover .dm-msg-header-time');
  });
});

describe('S2: window surface translucency contract', () => {
  it('paints the canonical window tint behind the shell', () => {
    expect(desktopCss).toContain('rgba(250, 250, 252, 0.82)');
    expect(desktopCss).toContain('rgba(14, 14, 18, 0.86)');
    expect(desktopCss).toContain('--window-surface');
  });
});

describe('S3: scope picker rows', () => {
  it('uses 252px panel, 32px single-line rows, no scrollbar artifact', () => {
    expect(chatSidebar).toContain('width: 252px;');
    expect(chatSidebar).toContain('height: 32px;');
    expect(chatSidebar).toContain('scrollbar-width: none;');
    const row = chatSidebar.slice(
      chatSidebar.indexOf('.chat-scope-row {'),
      chatSidebar.indexOf('.chat-scope-avatar {'),
    );
    expect(row).toContain('white-space: nowrap;');
    expect(row).toContain('flex-wrap: nowrap;');
  });
});

describe('S4: no persistent "⌘↵ to send" composer hint', () => {
  it('removes the resting hint from both composers (error slot remains)', () => {
    expect(conversation).not.toContain('>⌘↵ to send<');
    expect(composeMessage).not.toContain('>⌘↵ to send<');
  });
});
