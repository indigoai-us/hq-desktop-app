import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-004 — Channel Chat tab (timeline + composer) source contracts.
 *
 * Grep-the-source specs: lock the date dividers, absent-safe system-event
 * rendering, and optimistic send state labels into the messaging components.
 */

describe('desktop channel chat timeline + composer (US-004)', () => {
  const conversation = readRepoFile('src/components/messaging/Conversation.svelte');
  const channelView = readRepoFile('src/components/messaging/ChannelView.svelte');
  const models = readRepoFile('src/components/messaging/channelMessageModels.ts');
  const sendMachine = readRepoFile('src/components/messaging/sendStateMachine.ts');
  const systemLine = readRepoFile('src/components/messaging/SystemEventLine.svelte');
  const runCard = readRepoFile('src/components/messaging/RunCompleteCard.svelte');
  const fileCard = readRepoFile('src/components/messaging/FileAttachmentCard.svelte');

  it('renders date dividers between days', () => {
    expect(conversation).toContain('function startsNewDay(index: number)');
    expect(conversation).toContain('class="date-separator"');
    expect(conversation).toContain('data-testid="date-separator"');
    expect(conversation).toContain('formatDateSeparator');
  });

  it('system-event rendering is absent-safe for unknown types', () => {
    expect(models).toContain('export function parseSystemEvent');
    expect(models).toContain('export function shouldHideSystemMessage');
    // Unknown type / wrong version → null (renders nothing).
    expect(models).toMatch(/unknown.*null|return null/i);
    expect(models).toContain("if (!type || !KNOWN_TYPES.has(type)) return null");
    expect(models).toContain("if ('v' in raw && raw.v !== 1 && raw.v !== '1') return null");

    expect(conversation).toContain('parseSystemEvent');
    expect(conversation).toContain('shouldHideSystemMessage');
    expect(conversation).toContain('SystemEventLine');
    expect(conversation).toContain('RunCompleteCard');
    // System chrome uses SVG icons, not emoji.
    expect(systemLine).toContain('<svg');
    expect(systemLine).not.toMatch(/🎉|👍|🚀|✅/);
  });

  it('run-complete and file-attachment cards exist with graceful open handlers', () => {
    expect(runCard).toContain('Open preview');
    expect(runCard).toContain('View diff');
    expect(runCard).toContain("import { open as openExternal } from '@tauri-apps/plugin-shell'");
    expect(fileCard).toContain('data-testid="file-attachment-card"');
    expect(fileCard).toContain('hq:open-file-attachment');
    // "FILES · <size>" caption (falls back to plain "FILES" without sizeBytes).
    expect(models).toContain("sizeLabel ? `FILES · ${sizeLabel}` : 'FILES'");
    expect(fileCard).toContain('{model.caption}');
  });

  it('composer optimistic states exist (Sending / Delivered / Failed tap-to-retry)', () => {
    expect(sendMachine).toContain("status: 'pending'");
    expect(sendMachine).toContain("'sending'");
    expect(sendMachine).toContain("'delivered'");
    expect(sendMachine).toContain("'failed'");
    expect(sendMachine).toContain('Failed — tap to retry');
    expect(sendMachine).toContain('export async function runSend');
    expect(sendMachine).toContain('export async function retrySend');

    expect(conversation).toContain('sendStatus');
    expect(conversation).toContain('data-testid="send-failed"');
    expect(conversation).toContain('data-testid="send-status"');
    expect(conversation).toContain('onretrysend');
    expect(channelView).toContain('createOutboundMessage');
    expect(channelView).toContain('runSend');
    expect(channelView).toContain('retryFailedSend');
  });

  it('composer has attach + emoji + send, slash agent menu, and Cmd+Enter', () => {
    expect(conversation).toContain('data-testid="composer-attach"');
    expect(conversation).toContain('data-testid="composer-emoji"');
    expect(conversation).toContain('data-testid="composer-send"');
    expect(conversation).toContain('data-testid="agent-slash-menu"');
    expect(conversation).toContain('Run an agent');
    expect(conversation).toContain("buildClaudePromptWithSkillCatalog");
    expect(conversation).toContain("invoke('open_claude_code_link', { url })");
    expect(conversation).toContain("e.metaKey || e.ctrlKey) && e.key === 'Enter'");
    // Group-aware label: "#name" for channels, plain names for group DMs.
    expect(channelView).toContain(
      'Message ${conversationLabel} — or type / to run an agent…',
    );
  });

  it('paginates channel history with fetch_channel limit + cursor', () => {
    expect(channelView).toContain('const PAGE_SIZE = 50');
    expect(channelView).toContain("invoke<ChannelDetail>('fetch_channel'");
    expect(channelView).toContain('limit: PAGE_SIZE');
    expect(channelView).toContain('cursor');
    expect(channelView).toContain('loadOlder');
    expect(channelView).toContain('nextCursor');
    expect(conversation).toContain('onloadolder');
    expect(conversation).toContain('loadingOlder');
    expect(conversation).toContain('hasOlder');
  });

  it('reuses reaction controller + quick tray emoji without reimplementing toggle', () => {
    expect(conversation).toContain('ReactionBar');
    expect(conversation).toContain("const QUICK_REACT_EMOJI = ['👍', '🎉', '👀']");
    expect(conversation).toContain('ontogglereaction');
    expect(channelView).toContain('ReactionController');
    expect(channelView).toContain('reactionsCtl.toggle');
  });
});
