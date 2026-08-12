import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-011 — Desktop: DM + group DM V2 surfaces (source contracts).
 *
 * Locks reduced-chrome DM headers, numeric pair-unread sidebar wiring,
 * mark_dm_thread_read on open, Connection requests row + respond_dm_request,
 * and shared sendStateMachine for 1:1 DM sends.
 */

describe('US-011: DM + group DM V2 surfaces', () => {
  const chatSidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
  const sidebarModel = readRepoFile('src/desktop-alt/chat/sidebar-model.ts');
  const openTarget = readRepoFile('src/desktop-alt/chat/open-target.ts');
  const messagesShell = readRepoFile('src/components/messaging/MessagesShell.svelte');
  const channelView = readRepoFile('src/components/messaging/ChannelView.svelte');
  const requestCard = readRepoFile('src/components/messaging/DmRequestCard.svelte');
  const sendMachine = readRepoFile('src/components/messaging/sendStateMachine.ts');
  const dmNotifyCmd = readRepoFile('src-tauri/src/commands/dm_notify.rs');
  const dmNotifyCore = readRepoFile(
    '../../crates/hq-desktop-core/src/dm_notify.rs',
  );
  const mainRs = readRepoFile('src-tauri/src/main.rs');

  it('1:1 DM header is reduced chrome: "<Name> · direct message"', () => {
    expect(messagesShell).toContain('data-testid="dm-header"');
    expect(messagesShell).toContain('data-testid="dm-header-title"');
    expect(messagesShell).toContain('· direct message');
    // No tabs / members affordance on the 1:1 path (those live in ChannelView only).
    expect(messagesShell).not.toMatch(
      /selected[\s\S]{0,200}project-channel-tabs|data-testid="project-channel-tabs"/,
    );
  });

  it('group DM header is reduced chrome: members · group message; no tabs/members button', () => {
    expect(channelView).toContain('· group message');
    expect(channelView).toContain("isGroup ? 'group-dm-header' : 'channel-header'");
    expect(channelView).toContain('data-testid="group-dm-title"');
    expect(channelView).toContain('class:group-dm={isGroup}');
    // Tabs stay project-only; members button suppressed for group scope.
    expect(channelView).toContain('{#if isProject}');
    expect(channelView).toContain('data-testid="project-channel-tabs"');
    expect(channelView).toContain('{#if !isGroup}');
    expect(channelView).toContain('data-testid="channel-member-count"');
  });

  it('DM sends reuse sendStateMachine (no forked state machine)', () => {
    expect(messagesShell).toContain("from './sendStateMachine'");
    expect(messagesShell).toContain('createOutboundMessage');
    expect(messagesShell).toContain('runSend');
    expect(messagesShell).toContain('retrySend');
    expect(messagesShell).toContain('retryFailedDmSend');
    expect(messagesShell).toContain('onretrysend');
    expect(sendMachine).toContain('export async function runSend');
    expect(sendMachine).toContain("'sending'");
    expect(sendMachine).toContain("'delivered'");
    expect(sendMachine).toContain("'failed'");
  });

  it('sidebar paints numeric DM badges from pairUnreads with absent-safe fallback', () => {
    expect(sidebarModel).toContain('unreadCount?: number | null');
    expect(sidebarModel).toContain('export function applyPairUnreads');
    expect(sidebarModel).toContain('export function clearPairUnread');
    expect(sidebarModel).toContain('hasServerUnread');
    expect(chatSidebar).toContain("listen<PairUnreadsPayload>('dm:pair-unreads'");
    expect(chatSidebar).toContain('applyPairUnreads');
    expect(chatSidebar).toContain('clearPairUnread');
  });

  it('opens a DM via mark_dm_thread_read from the sidebar (canonical call site)', () => {
    expect(chatSidebar).toContain("invoke('mark_dm_thread_read'");
    expect(chatSidebar).toContain('withPersonUid: row.personUid');
    expect(dmNotifyCmd).toContain('pub async fn mark_dm_thread_read');
    expect(dmNotifyCmd).toContain('/v1/notify/thread/read');
    expect(dmNotifyCmd).toContain('withPersonUid');
    expect(mainRs).toContain('commands::dm_notify::mark_dm_thread_read');
  });

  it('Connection requests row opens shared DmRequestCard via deep link', () => {
    expect(chatSidebar).toContain('data-testid="chat-connection-requests"');
    expect(chatSidebar).toContain('Connection requests');
    expect(chatSidebar).toContain('requestDmRequestsOpen');
    expect(chatSidebar).toContain("invoke<RequestsResponse>('list_dm_requests')");
    expect(chatSidebar).toContain("listen<DmRequest>('dm:request-new'");
    expect(openTarget).toContain('OPEN_DM_REQUESTS_EVENT');
    expect(openTarget).toContain('export function requestDmRequestsOpen');
    expect(openTarget).toContain('export function takePendingDmRequests');
    expect(messagesShell).toContain('OPEN_DM_REQUESTS_EVENT');
    expect(messagesShell).toContain('takePendingDmRequests');
    expect(messagesShell).toContain('selectRequest');
    expect(messagesShell).toContain('<DmRequestCard');
    expect(requestCard).toContain("invoke('respond_dm_request'");
  });

  it('InboxResponse pairUnreads is additive and registered on the poll path', () => {
    expect(dmNotifyCore).toContain('pub struct PairUnread');
    expect(dmNotifyCore).toContain('pub pair_unreads: Vec<PairUnread>');
    expect(dmNotifyCore).toContain('inbox_response_pair_unreads_absent_safe');
    expect(dmNotifyCmd).toContain('EVENT_DM_PAIR_UNREADS');
    expect(dmNotifyCmd).toContain('dm:pair-unreads');
    expect(dmNotifyCmd).toContain('apply_pair_unreads_page');
    expect(mainRs).toContain('PairUnreadState::new()');
  });
});
