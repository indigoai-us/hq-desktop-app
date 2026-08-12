import { describe, expect, it } from 'vitest';
import { shareAclLabel, sharePathPrefix } from '../../src/lib/share-path';
import { readRepoFile } from './harness';

/**
 * DESKTOP-002 — Unified messages and notification triage.
 *
 * Source contracts for: no People/Requests tabs, compact Messages header,
 * room-only rail plus dedicated activity shortcut, ShareMainPane payload (sender /
 * path / timestamp / ACL / actions), preserved copy + Claude actions, text-only
 * composer (no attachment affordance), naked main canvas, and shared component
 * reuse across Messages + Notifications paths (US-018: InboxPage retired).
 */

describe('DESKTOP-002: unified messages and notification triage', () => {
  const shell = readRepoFile('src/components/messaging/MessagesShell.svelte');
  const sharePane = readRepoFile('src/components/ShareMainPane.svelte');
  const requestCard = readRepoFile('src/components/messaging/DmRequestCard.svelte');
  const conversation = readRepoFile('src/components/messaging/Conversation.svelte');
  const compose = readRepoFile('src/components/messaging/ComposeMessage.svelte');
  const notifications = readRepoFile('src/desktop-alt/chat/NotificationsView.svelte');
  const dmDetail = readRepoFile('src/components/DmDetail.svelte');
  const shareDetail = readRepoFile('src/components/ShareDetail.svelte');

  it('orients the rail without restoring a redundant page title or People/Requests tabs', () => {
    expect(shell).not.toContain('<h1>Messages</h1>');
    expect(shell).toContain('<h2>HQ</h2>');
    expect(shell).toContain("railUnreadCount > 99 ? '99+' : railUnreadCount");
    expect(shell).not.toMatch(/>\s*People\s*</);
    expect(shell).not.toMatch(/>\s*Requests\s*</);
    expect(shell).not.toContain("segment = 'people'");
    expect(shell).not.toContain("segment = 'requests'");
    expect(shell).not.toContain("segment = 'all'");
    expect(shell).not.toContain('class="segments"');
    expect(shell).not.toContain('class="seg"');
    // Compact header keeps the primary compose action.
    expect(shell).toContain('class="new-message-btn"');
    expect(shell).toContain('aria-label="New message"');
    expect(shell).toContain('DESKTOP-002');
  });

  it('names every conversation source, timestamps channels, and never hashes group DMs', () => {
    expect(shell).toContain('data-provenance="direct-message"');
    expect(shell).toContain("data-provenance={isGroupDm ? 'group-dm' : 'channel'}");
    expect(shell).toContain('data-provenance="connection-request"');
    expect(shell).toContain('data-provenance="shared-path"');
    expect(shell).toContain('data-provenance="agent"');
    expect(shell).toContain('<span class="contact-provenance">Connection request</span>');
    expect(shell).toContain('<span class="contact-provenance">Shared path</span>');
    expect(shell).toContain('function channelProvenance');
    expect(shell).toContain("if (channel.scope === 'group')");
    expect(shell).toContain('function channelActivityAt');
    expect(shell).toContain('function formatChannelTime');
    expect(shell).toContain('<time class="contact-time" datetime={activityAt ?? undefined}>');
    expect(shell).toContain("kind={isGroupDm ? 'group' : 'channel'}");
    expect(shell).toContain('label={channelDisplayName(ch)}');
    expect(shell).toContain("selectedChannel.scope === 'group'");
    expect(shell).toContain('aria-current={isActive ? \'page\' : undefined}');
    expect(shell).toContain('aria-busy={isActive && loadingThread}');
  });

  it('keeps requests and shared paths functional without crowding the room rail', () => {
    expect(shell).toContain("kind: 'request'");
    expect(shell).toContain("kind: 'share'");
    expect(shell).toContain('railItems');
    expect(shell).toContain('data-testid="request-rail-row"');
    expect(shell).toContain('data-testid="share-rail-row"');
    expect(shell).toContain('function selectRequest');
    expect(shell).toContain('function selectShare');
    expect(shell).toContain("item.kind === 'dm' || item.kind === 'channel'");
    expect(shell).toContain('Mentions & activity');
    expect(shell).not.toContain('<div class="rail-section-heading"><span>Activity</span></div>');
    // Still merges channels + DMs via the existing pure helper.
    expect(shell).toContain('mergeConversations(contacts, channels)');
  });

  it('uses a shared left-aligned authored timeline instead of opposing chat bubbles', () => {
    expect(conversation).toContain("msg.direction === 'out' ? 'You'");
    expect(conversation).toContain('<IdentityMark kind="person" label={messageAuthor(msg)}');
    expect(conversation).toContain('class="dm-msg-meta"');
    expect(conversation).toContain('grid-template-columns: 28px minmax(0, 720px)');
    expect(conversation).toMatch(/\.dm-msg-out\s*\{[\s\S]*?align-self:\s*stretch/);
    expect(conversation).toMatch(/\.dm-msg-out \.dm-bubble[\s\S]*?background:\s*transparent/);
  });

  it('opens shared payload UI with sender, path, timestamp, ACL truth, and actions', () => {
    expect(shell).toContain("import ShareMainPane from '../ShareMainPane.svelte'");
    expect(shell).toContain('<ShareMainPane events={selectedShareEvents} />');
    expect(sharePane).toContain('data-testid="share-main-pane"');
    expect(sharePane).toContain('data-testid="share-payload"');
    expect(sharePane).toContain('data-testid="share-acl"');
    expect(sharePane).toContain('shareAclLabel');
    expect(sharePane).toContain('sharePathPrefix');
    expect(sharePane).toContain('evt.issuerDisplayName');
    expect(sharePane).toContain('formatDate(evt.createdAt)');
    expect(sharePane).toContain('Copy prompt');
    expect(sharePane).toContain('Open in Claude ↗');
    expect(sharePane).toContain("invoke('open_claude_code_link'");
    // ACL helper truth (unit-checked below) stays wire-faithful.
    expect(shareAclLabel('read')).toBe('ACL: read');
    expect(shareAclLabel('write')).toBe('ACL: write');
    expect(shareAclLabel('')).toBeNull();
    expect(sharePathPrefix('companies/indigo/docs/a.md')).toBe('companies/indigo/docs/a.md');
  });

  it('opens connection requests in the main pane via the shared DmRequestCard', () => {
    expect(shell).toContain('data-testid="request-detail-pane"');
    expect(shell).toContain('<DmRequestCard request={selectedRequest} onresolved={handleRequestResolved} />');
    expect(requestCard).toContain("respond('accept')");
    expect(requestCard).toContain("respond('decline')");
    expect(requestCard).toContain("respond('block')");
    expect(requestCard).toContain("invoke('respond_dm_request'");
  });

  it('preserves copy, reactions, threads, Claude actions, and delivery/pending receipts', () => {
    expect(conversation).toContain('Copy prompt');
    expect(conversation).toContain('Open in Claude ↗');
    expect(conversation).toContain('onopenshareinclaude');
    expect(conversation).toContain('ReactionBar');
    expect(conversation).toContain('onopenthread');
    expect(conversation).toContain('pendingLabel');
    expect(conversation).toContain('copyableText');
    expect(shell).toContain('onopenshareinclaude={openShareInClaude}');
    expect(shell).toContain('open_claude_code_link');
  });

  it('keeps message attachments reference-only (no raw file upload input)', () => {
    // US-004/US-007 superseded the old "text-only composer" contract: the
    // channel composer gains an attach affordance and attachment CARDS, but
    // attachments remain vault-path REFERENCES — never raw file uploads.
    for (const src of [conversation, compose]) {
      expect(src).not.toMatch(/type=["']file["']/);
      expect(src).not.toMatch(/<input[^>]+type=["']file["']/);
      expect(src).not.toMatch(/file-transfer/i);
    }
    // The new-message compose surface stays text-only.
    expect(compose).not.toMatch(/attachment/i);
    expect(compose).not.toMatch(/paperclip/i);
    // Timeline attachments render as reference cards (US-007 wire shape).
    expect(conversation).toContain('FileAttachmentCard');
    // Text entry surfaces remain textarea / send only.
    expect(compose).toContain('class="compose-body"');
    expect(compose).toContain('aria-label="Message body"');
    expect(conversation).toContain('onsend');
  });

  it('uses one window material; embedded mode hides the second rail (D-02)', () => {
    const railRule = shell.match(/\.rail\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const windowRule = shell.match(/\.messages-window\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(shell).toMatch(
      /\.messages-window\s*\{[\s\S]*?background:\s*var\(--v4-ground/,
    );
    expect(windowRule).not.toContain('backdrop-filter:');
    // Standalone Messages window still has a rail; embedded shell hides it.
    expect(shell).toContain('{#if !embedded}');
    expect(shell).toContain('class:embedded');
    expect(railRule).toMatch(/background:\s*color-mix\(in srgb,[\s\S]*?4%,\s*transparent\);/);
    expect(railRule).not.toContain('backdrop-filter:');
    expect(shell).toMatch(
      /\.pane\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border-radius:\s*0;/,
    );
    expect(conversation).toMatch(
      /:global\(\[data-window='desktop-alt'\]\) \.dm-reply-input\s*\{[\s\S]*?background:\s*transparent;/,
    );
    expect(shell).toContain('data-testid="messages-main-pane"');
    expect(shell).toMatch(/\.rail\s*\{[\s\S]*?width:\s*282px/);
  });

  it('shares request/share payload components with Notifications / quick-window paths', () => {
    // ShareMainPane is the shared payload surface for standalone share-detail,
    // dm-detail share rows, and MessagesShell share selection.
    expect(dmDetail).toContain('<ShareMainPane events={shareEvents} />');
    expect(shareDetail).toContain('<ShareMainPane');
    expect(shell).toContain('<ShareMainPane events={selectedShareEvents} />');
    // US-018: NotificationsView is the desktop chronology feed (no People/Requests tabs).
    expect(notifications).toContain('data-testid="notifications-view"');
    expect(notifications).not.toMatch(/>\s*People\s*</);
    expect(notifications).not.toMatch(/>\s*Requests\s*</);
    expect(notifications).not.toContain('role="tablist"');
    // Daybook parity override (prd.json decisions): notification rows carry
    // Lizzie Liu's 10px card radius.
    expect(notifications).toContain('border-radius: 10px');
  });
});
