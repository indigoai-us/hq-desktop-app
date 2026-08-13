/**
 * US-019 — E2E closeout: harness parity + full matrix.
 *
 * Asserts the dev-harness `?view=chat` (default desktop view) is wired with
 * production-contract fixtures covering every chat-shell surface, and that
 * each sub-state is selectable via `?screen=` / `?scenario=` with the expected
 * testids / content markers present in fixtures + shipped components.
 *
 * Follows the desktop-alt e2e convention (source contracts + pure model
 * exercises against production-contract fixtures). Mount paths that require
 * the browser preview harness are covered by fixture→model parse assertions
 * and source contracts for every screen/testid.
 */

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import {
  buildChatChannels,
  buildChatContacts,
  CHANNEL_FILES_RESPONSE,
  CHAT_HARNESS_SCENARIOS,
  CHAT_HARNESS_SCREENS,
  CHAT_LAST_WEEK_CHANNEL_ID,
  CHAT_NOTIFICATIONS,
  CHAT_PAIR_UNREADS,
  CHAT_PIN_IDS,
  CHAT_PROJECT_CHANNEL_ID,
  chatNotificationsResponse,
  chatScreenOpenTarget,
  chatScreenToPendingRoute,
  COMPOSER_STATE_MESSAGES,
  HARNESS_CHAT_NOW_MS,
  PROJECT_CHANNEL_MESSAGES,
} from '../../dev-harness/chat-fixtures';
import {
  groupByDay,
  normalizeConversations,
} from '../../src/desktop-alt/chat/sidebar-model';
import {
  parseNotificationsResponse,
  mapServerType,
  formatBadgeCount,
} from '../../src/desktop-alt/chat/notifications-model';
import {
  parseSystemEvent,
  parseAttachment,
} from '../../src/components/messaging/channelMessageModels';
import {
  parseChannelFilesResponse,
  classifyAccessError,
} from '../../src/components/messaging/channelFilesModel';
import { buildCorePopoverViewModel } from '../../src/desktop-alt/v4/core-popover-model';
import { sendStatusLabel } from '../../src/components/messaging/sendStateMachine';

// ── Source contracts ─────────────────────────────────────────────────────────

describe('US-019 harness wiring (source contracts)', () => {
  const harness = readRepoFile('dev-harness/Harness.svelte');
  const mocks = readRepoFile('dev-harness/mocks/core.ts');
  const fixtures = readRepoFile('dev-harness/chat-fixtures.ts');

  it('defaults to ?view=chat and mounts the shipped DesktopApp shell', () => {
    expect(harness).toContain("params.get('view') ?? 'chat'");
    expect(harness).toContain("view === 'chat' || view === 'v2' || view === 'desktop'");
    expect(harness).toContain('data-testid="harness-chat-shell"');
    expect(harness).toContain('<DesktopApp');
    expect(readRepoFile('src/desktop-alt/DesktopApp.svelte')).toContain(
      "import ChatSidebar from './chat/ChatSidebar.svelte'",
    );
  });

  it('wires every screen + scenario catalog entry', () => {
    for (const screen of CHAT_HARNESS_SCREENS) {
      expect(fixtures).toContain(`'${screen}'`);
    }
    for (const scenario of CHAT_HARNESS_SCENARIOS) {
      expect(fixtures).toContain(`'${scenario}'`);
    }
    expect(harness).toContain('chatScreenOpenTarget');
    expect(harness).toContain('CHAT_PAIR_UNREADS');
    expect(harness).toContain('CHAT_PIN_IDS');
    expect(harness).toContain("screen === 'palette'");
    expect(harness).toContain("scenario === 'core-conflicts'");
    expect(mocks).toContain('chatScreenToPendingRoute');
    expect(mocks).toContain('buildChatChannels');
    expect(mocks).toContain('PROJECT_CHANNEL_MESSAGES');
    expect(mocks).toContain('fetch_notifications');
    expect(mocks).toContain('fetch_channel_files');
    expect(mocks).toContain("scenario === 'acl-denied'");
    expect(mocks).toContain("scenario === 'paused'");
    expect(mocks).toContain("scenario === 'no-drift'");
  });

  it('seeds pins and emits pairUnreads for the chat shell', () => {
    expect(harness).toContain('PINS_STORAGE_KEY');
    expect(harness).toContain("emit('dm:pair-unreads'");
    expect(fixtures).toContain('pairUnreads');
    expect(CHAT_PIN_IDS.length).toBeGreaterThan(0);
  });

  it('exposes a dedicated composer screen with send states', () => {
    expect(harness).toContain('data-testid="harness-composer-screen"');
    expect(harness).toContain('COMPOSER_STATE_MESSAGES');
    expect(fixtures).toContain("sendStatus: 'failed'");
    expect(fixtures).toContain("sendStatus: 'sending'");
    expect(fixtures).toContain("sendStatus: 'delivered'");
  });

  it('theme query param remains supported for light/dark', () => {
    expect(harness).toContain("params.get('theme') ?? 'dark'");
    expect(harness).toContain('dataset.forceTheme = theme');
  });
});

// ── Per-screen testid contracts (shipped components) ─────────────────────────

describe('US-019 per-screen testid contracts', () => {
  it('sidebar: scope pill, filter, LAST WEEK, connection requests, pins chrome', () => {
    const sidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
    for (const id of [
      'chat-sidebar',
      'chat-scope-pill',
      'chat-filter',
      'chat-filter-popover',
      'chat-search',
      'chat-last-week',
      'chat-connection-requests',
      'chat-unread-badge',
      'chat-dm-avatar',
      'chat-group-avatar',
    ]) {
      expect(sidebar).toContain(`data-testid="${id}"`);
    }
  });

  it('timeline: system events, run-complete, file card, composer send states', () => {
    const conversation = readRepoFile('src/components/messaging/Conversation.svelte');
    const systemLine = readRepoFile('src/components/messaging/SystemEventLine.svelte');
    const runCard = readRepoFile('src/components/messaging/RunCompleteCard.svelte');
    const fileCard = readRepoFile('src/components/messaging/FileAttachmentCard.svelte');
    expect(systemLine).toContain('data-testid="system-event-line"');
    expect(runCard).toContain('data-testid="run-complete-card"');
    expect(fileCard).toContain('data-testid="file-attachment-card"');
    expect(conversation).toContain('data-testid="send-failed"');
    expect(conversation).toContain('data-testid="send-status"');
    expect(conversation).toContain('data-testid="composer-send"');
  });

  it('board + files tabs expose project-tab testids', () => {
    const board = readRepoFile('src/desktop-alt/chat/BoardTab.svelte');
    const files = readRepoFile('src/components/messaging/ChannelFilesTab.svelte');
    expect(board).toContain('data-testid="project-tab-board"');
    expect(board).toContain('data-testid="board-columns"');
    expect(board).toContain('data-testid="board-card"');
    expect(files).toContain('data-testid="project-tab-files"');
    expect(files).toContain('data-testid="channel-files-list"');
    expect(files).toContain('data-testid="channel-files-denied"');
  });

  it('DM / group DM headers and notifications / core / meetings / library / palette', () => {
    const messagesShell = readRepoFile('src/components/messaging/MessagesShell.svelte');
    const channelView = readRepoFile('src/components/messaging/ChannelView.svelte');
    const notif = readRepoFile('src/desktop-alt/chat/NotificationsView.svelte');
    const core = readRepoFile('src/desktop-alt/v4/CorePopover.svelte');
    const meetings = readRepoFile('src/desktop-alt/pages/MeetingsPage.svelte');
    const library = readRepoFile('src/desktop-alt/chat/LibraryOverlay.svelte');
    const palette = readRepoFile('src/desktop-alt/components/CommandPalette.svelte');
    const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');

    expect(messagesShell).toContain('data-testid="dm-header"');
    expect(channelView).toContain("isGroup ? 'group-dm-header' : 'channel-header'");
    expect(channelView).toContain('data-testid="group-dm-title"');
    expect(channelView).toContain('data-testid="project-channel-tabs"');
    expect(notif).toContain('data-testid="notifications-view"');
    expect(notif).toContain('data-testid="notifications-row"');
    expect(notif).toContain('data-testid="notifications-mark-all-read"');
    expect(core).toContain('data-testid="core-popover"');
    expect(core).toContain('data-testid="core-popover-rescue-card"');
    expect(core).toContain('data-testid="core-popover-drift-count"');
    // G6: pill testid is state-derived (detected vs undetected core).
    expect(core).toContain("'core-popover-no-drift'");
    expect(core).toContain("'core-popover-core-undetected'");
    expect(core).toContain('data-testid="core-popover-app-update"');
    expect(core).toContain('data-testid="core-popover-paused"');
    expect(meetings).toContain('data-testid="desktop-alt-meetings"');
    expect(meetings).toContain('data-testid="meetings-tab-upcoming"');
    expect(library).toContain('data-testid="library-overlay"');
    expect(library).toContain('data-testid="library-overlay-nav"');
    expect(palette).toContain('data-testid="command-palette"');
    expect(titleBar).toContain('data-testid="titlebar-core-pill"');
    expect(titleBar).toContain('data-testid="titlebar-meetings"');
    expect(titleBar).toContain('data-testid="titlebar-notifications"');
  });
});

// ── Fixture shape contracts (render models) ──────────────────────────────────

describe('US-019 production-contract fixtures', () => {
  it('sidebar: pinned + day groups + LAST WEEK from fixtures', () => {
    const now = Date.now();
    const channels = buildChatChannels(now);
    const contacts = buildChatContacts(now);
    expect(channels.some((c) => c.channelId === CHAT_PROJECT_CHANNEL_ID)).toBe(true);
    expect(channels.some((c) => c.channelId === CHAT_LAST_WEEK_CHANNEL_ID)).toBe(true);
    expect(channels.some((c) => c.scope === 'project')).toBe(true);
    expect(channels.some((c) => c.scope === 'group')).toBe(true);
    expect(contacts.some((c) => c.personUid === 'prs_ada')).toBe(true);

    const rows = normalizeConversations(channels as never, contacts as never, {
      pinnedIds: new Set(CHAT_PIN_IDS),
      now,
    });
    const grouped = groupByDay(rows, now);
    expect(grouped.pinned.length).toBeGreaterThan(0);
    expect(grouped.sections.length).toBeGreaterThan(0);
    expect(grouped.lastWeek.some((r) => r.channelId === CHAT_LAST_WEEK_CHANNEL_ID)).toBe(
      true,
    );
    expect(CHAT_PAIR_UNREADS.pairUnreads.length).toBeGreaterThan(0);
  });

  it('channel timeline: every system event type + run-complete + file card + humans', () => {
    const types = new Set<string>();
    let humanCount = 0;
    let hasFile = false;
    let hasRunComplete = false;

    for (const msg of PROJECT_CHANNEL_MESSAGES) {
      if (msg.messageKind === 'system' && msg.systemEvent) {
        const model = parseSystemEvent(msg.systemEvent);
        expect(model, `systemEvent for ${msg.eventId}`).not.toBeNull();
        if (model?.kind === 'run_complete') hasRunComplete = true;
        else if (model) types.add(model.type);
      } else {
        humanCount += 1;
      }
      if ('attachment' in msg && msg.attachment) {
        hasFile = true;
        expect(parseAttachment(msg.attachment)).not.toBeNull();
      }
    }

    expect(types.has('run_started')).toBe(true);
    expect(types.has('run_progress')).toBe(true);
    expect(types.has('pr_opened')).toBe(true);
    expect(types.has('deploy')).toBe(true);
    expect(types.has('file_added')).toBe(true);
    expect(hasRunComplete).toBe(true);
    expect(hasFile).toBe(true);
    expect(humanCount).toBeGreaterThanOrEqual(2);
  });

  it('composer: Sending / Delivered / Failed labels', () => {
    const statuses = COMPOSER_STATE_MESSAGES.map((m) => m.sendStatus).filter(Boolean);
    expect(statuses).toContain('sending');
    expect(statuses).toContain('delivered');
    expect(statuses).toContain('failed');
    expect(sendStatusLabel('sending')).toMatch(/Sending/i);
    expect(sendStatusLabel('delivered')).toMatch(/Delivered/i);
    expect(sendStatusLabel('failed')).toMatch(/Failed/i);
  });

  it('files tab: populated list + ACL-denied classification', () => {
    const parsed = parseChannelFilesResponse(CHANNEL_FILES_RESPONSE);
    expect(parsed.files.length).toBeGreaterThanOrEqual(2);
    expect(parsed.files[0]?.vaultPath).toContain('companies/indigo');
    expect(classifyAccessError('403 Forbidden: membership denied')).toBe('denied');
  });

  it('notifications: NOTIF catalog mix parses into UI taxonomy with unread badge', () => {
    const resp = chatNotificationsResponse();
    expect(resp.unreadCount).toBeGreaterThan(0);
    expect(resp.notifications.length).toBe(CHAT_NOTIFICATIONS.length);

    const serverTypes = new Set(CHAT_NOTIFICATIONS.map((n) => n.type));
    for (const required of [
      'dm',
      'file_share',
      'connection_request',
      'membership_invite',
      'security_alert',
      'agent_channel_action_needed',
      'agent_upgrade_request',
      'agent_upgrade_decision',
      'sponsorship_request',
      'role_changed',
      'creator_application',
      'feedback_update',
    ]) {
      expect(serverTypes.has(required), `missing notification type ${required}`).toBe(true);
    }

    const parsed = parseNotificationsResponse(resp, HARNESS_CHAT_NOW_MS);
    expect(parsed.items.length).toBe(CHAT_NOTIFICATIONS.length);
    expect(parsed.unreadCount).toBe(resp.unreadCount);
    expect(formatBadgeCount(parsed.unreadCount)).toBeTruthy();

    const displayKinds = new Set(parsed.items.map((i) => i.displayKind));
    expect(displayKinds.has('dm_received')).toBe(true);
    expect(displayKinds.has('file_shared')).toBe(true);
    expect(displayKinds.has('mention')).toBe(true);
    expect(displayKinds.has('agent_finished_story')).toBe(true);
    expect(displayKinds.has('agent_review_request')).toBe(true);
    expect(displayKinds.has('infra_flag')).toBe(true);
    expect(mapServerType('totally_unknown_xyz')).toBe('generic');
  });

  it('core popover: conflicts present/empty, drift/no-drift, update, paused', () => {
    const withConflicts = buildCorePopoverViewModel({
      conflicts: [{ path: 'companies/indigo/prd.json', status: 'pending' }],
      core: { hqVersion: '15.0.16', driftCount: 2, needsRestore: true },
      appVersion: '0.10.106',
      updateAvailable: true,
      cloudPaused: false,
    });
    expect(withConflicts.conflictCount).toBe(1);
    expect(withConflicts.conflictHeader).toMatch(/conflict/i);
    expect(withConflicts.driftPill).toMatch(/drifted/i);
    expect(withConflicts.updateAvailable).toBe(true);

    const empty = buildCorePopoverViewModel({
      conflicts: [],
      core: { hqVersion: '15.0.16', driftCount: 0, needsRestore: false },
      appVersion: '0.10.106',
      updateAvailable: false,
      cloudPaused: true,
    });
    expect(empty.conflictCount).toBe(0);
    expect(empty.driftPill).toMatch(/NO DRIFT/i);
    expect(empty.cloudPaused).toBe(true);
    expect(empty.pausedNotice).toBeTruthy();
    expect(empty.syncNowAllowed).toBe(false);
  });

  it('screen → pending route and open-target map is complete for all states', () => {
    expect(chatScreenToPendingRoute('notifications')).toBe('notifications');
    expect(chatScreenToPendingRoute('meetings')).toBe('meetings');
    expect(chatScreenToPendingRoute('library')).toBe('library');
    expect(chatScreenToPendingRoute('channel')).toBe('messages');
    expect(chatScreenToPendingRoute('board')).toBe('messages');
    expect(chatScreenToPendingRoute('files')).toBe('messages');
    expect(chatScreenToPendingRoute(null)).toBe('messages');
    expect(chatScreenOpenTarget('dm').personUid).toBe('prs_ada');
    expect(chatScreenOpenTarget('group-dm').channelId).toBeTruthy();
    expect(chatScreenOpenTarget('channel').channelId).toBe(CHAT_PROJECT_CHANNEL_ID);
  });
});

describe('US-019 deterministic timeline content', () => {
  it('project timeline createdAt values are fixed ISO strings', () => {
    for (const msg of PROJECT_CHANNEL_MESSAGES) {
      expect(msg.createdAt).toMatch(/^2026-08-12T/);
    }
    for (const msg of COMPOSER_STATE_MESSAGES) {
      expect(msg.createdAt).toMatch(/^2026-08-12T/);
    }
  });

  it('does not use Date.now() inside project channel message fixtures', () => {
    const fixtures = readRepoFile('dev-harness/chat-fixtures.ts');
    const blockStart = fixtures.indexOf('export const PROJECT_CHANNEL_MESSAGES');
    const blockEnd = fixtures.indexOf('export const COMPOSER_STATE_MESSAGES');
    const block = fixtures.slice(blockStart, blockEnd);
    expect(block).not.toContain('Date.now()');
  });
});

// ── Visual QA round 2 regressions (popover opacity / Escape / pill count) ────

describe('visual QA round 2 source contracts', () => {
  it('popover surfaces use the fully opaque --v4-surface-solid token (no bleed-through)', () => {
    const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
    // The solid token must be a literal hex (alpha-free) in both themes.
    expect(tokens).toContain('--v4-surface-solid: #ffffff;');
    expect(tokens).toContain('--v4-surface-solid: #303030;');

    const chatSidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
    const corePopover = readRepoFile('src/desktop-alt/v4/CorePopover.svelte');
    const channelView = readRepoFile('src/components/messaging/ChannelView.svelte');
    // CorePopover exempted from the solid-surface rule: Daybook parity
    // override (prd.json decisions) gives panels Lizzie Liu's translucent
    // rgba(44,44,54,0.94)/rgba(252,252,253,0.96) chrome with
    // blur(40px) saturate(1.5) backdrop, which prevents bleed-through.
    expect(corePopover).toContain('background: var(--panel-bg');
    expect(corePopover).toContain('backdrop-filter: blur(40px) saturate(1.5)');
    for (const [name, src] of [
      ['ChatSidebar', chatSidebar],
      ['ChannelView', channelView],
    ] as const) {
      expect(src, `${name} popover must use --v4-surface-solid`).toContain(
        'var(--v4-surface-solid',
      );
      // The translucent raised token must not back a popover surface anymore.
      expect(src).not.toMatch(/Opaque surface[^\n]*\n\s*background: var\(--v4-raised/);
    }
  });

  it('status/members popover dismisses on Escape via a window-level listener', () => {
    const channelView = readRepoFile('src/components/messaging/ChannelView.svelte');
    expect(channelView).toContain('<svelte:window');
    expect(channelView).toContain("e.key !== 'Escape'");
    expect(channelView).toContain('statusOpen = false');
    expect(channelView).toContain('rosterOpen = false');
  });

  it('member pill count cannot drift from fixture-built status models', () => {
    const channelView = readRepoFile('src/components/messaging/ChannelView.svelte');
    expect(channelView).toContain('resolveMemberPillCount(members.length, statusModel, memberCount)');
    // The unconditional overwrite that caused the 6 → 5 drift is gone.
    expect(channelView).not.toContain('memberCount = statusModel.memberCount');
  });

  it('harness lands ?screen=files on the Files tab and supports ?scenario=composer-states', () => {
    const harness = readRepoFile('dev-harness/Harness.svelte');
    expect(harness).toContain("screen === 'board' || screen === 'files'");
    expect(harness).toContain('project-tab-${screen}-btn');
    expect(harness).toContain("scenario === 'composer-states'");
  });

  it('active-detection fixture detectedAt is relative to now, not hardcoded', () => {
    const mocks = readRepoFile('dev-harness/mocks/core.ts');
    expect(mocks).not.toContain("detectedAt: '2026-07-26T14:00:00.000Z'");
    expect(mocks).toContain('detectedAt: new Date(Date.now() - 12 * 60_000).toISOString()');
  });

  it('ACL-denied list copy is plural where it labels the file list', () => {
    const tab = readRepoFile('src/components/messaging/ChannelFilesTab.svelte');
    expect(tab).toContain('CHANNEL_FILES_LIST_DENIED_MESSAGE');
  });
});
