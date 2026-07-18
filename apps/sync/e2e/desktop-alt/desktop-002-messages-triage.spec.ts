import { describe, expect, it } from 'vitest';
import { shareAclLabel, sharePathPrefix } from '../../src/lib/share-path';
import { readRepoFile } from './harness';

/**
 * DESKTOP-002 — Unified messages and notification triage.
 *
 * Source contracts for: no People/Requests tabs, compact Messages header,
 * request + share rows in the unified rail, ShareMainPane payload (sender /
 * path / timestamp / ACL / actions), preserved copy + Claude actions, text-only
 * composer (no attachment affordance), naked main canvas, and shared component
 * reuse across Messages + Inbox paths.
 */

describe('DESKTOP-002: unified messages and notification triage', () => {
  const shell = readRepoFile('src/components/messaging/MessagesShell.svelte');
  const sharePane = readRepoFile('src/components/ShareMainPane.svelte');
  const requestCard = readRepoFile('src/components/messaging/DmRequestCard.svelte');
  const conversation = readRepoFile('src/components/messaging/Conversation.svelte');
  const compose = readRepoFile('src/components/messaging/ComposeMessage.svelte');
  const inbox = readRepoFile('src/desktop-alt/pages/InboxPage.svelte');
  const dmDetail = readRepoFile('src/components/DmDetail.svelte');
  const shareDetail = readRepoFile('src/components/ShareDetail.svelte');

  it('drops the redundant Messages page title and People/Requests tabs', () => {
    expect(shell).not.toContain('<h1>Messages</h1>');
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

  it('renders requests and shared paths as ordinary recency-sorted rail rows', () => {
    expect(shell).toContain("kind: 'request'");
    expect(shell).toContain("kind: 'share'");
    expect(shell).toContain('railItems');
    expect(shell).toContain('data-testid="request-rail-row"');
    expect(shell).toContain('data-testid="share-rail-row"');
    expect(shell).toContain('function selectRequest');
    expect(shell).toContain('function selectShare');
    // Still merges channels + DMs via the existing pure helper.
    expect(shell).toContain('mergeConversations(contacts, channels)');
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

  it('keeps the composer text-only with no attachment affordance', () => {
    for (const src of [conversation, compose]) {
      expect(src).not.toMatch(/type=["']file["']/);
      expect(src).not.toMatch(/paperclip/i);
      expect(src).not.toMatch(/attachment/i);
      expect(src).not.toMatch(/file-transfer/i);
      expect(src).not.toMatch(/<input[^>]+type=["']file["']/);
    }
    // Text entry surfaces remain textarea / send only.
    expect(compose).toContain('class="compose-body"');
    expect(compose).toContain('aria-label="Message body"');
    expect(conversation).toContain('onsend');
  });

  it('uses liquid-glass/source-list treatment only on the rail, naked main canvas', () => {
    expect(shell).toContain('background: var(--surface-rail)');
    expect(shell).toMatch(
      /\.pane\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border-radius:\s*0;/,
    );
    expect(shell).toContain('data-testid="messages-main-pane"');
    // Title/meta 3px gap on rail rows and pane headers.
    expect(shell).toMatch(
      /\.contact-meta\s*\{[\s\S]*?gap:\s*var\(--v4-row-stack-gap,\s*3px\)/,
    );
    expect(shell).toMatch(
      /\.pane-title-stack\s*\{[\s\S]*?gap:\s*var\(--v4-row-stack-gap,\s*3px\)/,
    );
  });

  it('shares request/share payload components with Inbox quick-window paths', () => {
    // ShareMainPane is the shared payload surface for standalone share-detail,
    // dm-detail share rows, and MessagesShell share selection.
    expect(dmDetail).toContain('<ShareMainPane events={shareEvents} />');
    expect(shareDetail).toContain('<ShareMainPane');
    expect(shell).toContain('<ShareMainPane events={selectedShareEvents} />');
    // Inbox still hosts NotificationFeed (ordinary share/DM rows) without
    // People/Requests tabs.
    expect(inbox).toContain('NotificationFeed');
    expect(inbox).not.toMatch(/>\s*People\s*</);
    expect(inbox).not.toMatch(/>\s*Requests\s*</);
    expect(inbox).not.toContain('role="tablist"');
    expect(inbox).toContain('border-radius: 0');
  });
});
