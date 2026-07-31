import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

const detail = read('src/components/DmDetail.svelte');
const sidePane = read('src/components/QuickWindowSidePane.svelte');
const channelView = read('src/components/messaging/ChannelView.svelte');

describe('quick communications window hierarchy', () => {
  it('orients the window around Messages with flat Conversations and Notifications tabs', () => {
    expect(detail).toContain('<h1>Messages</h1>');
    expect(detail).toContain("let activeTab = $state<'conversations' | 'notifications'>");
    expect(detail).toContain('data-testid="communications-tab-conversations"');
    expect(detail).toContain('data-testid="communications-tab-notifications"');
    expect(detail).toContain('class:active={activeTab ===');
    expect(detail).toContain("hidden={activeTab !== 'notifications'}");
    expect(detail).toContain("hidden={activeTab !== 'conversations'}");
    expect(detail).toContain('onkeydown={handleTabKeydown}');
    expect(detail).toContain("event.key === 'Home'");
    expect(detail).toContain("event.key === 'End'");
    expect(detail).toContain('<NotificationFeed');
    expect(detail).toContain('density="comfortable"');
    expect(detail).toContain('showDayLabels={false}');
    expect(detail).toMatch(/\.communications-tab\.active[\s\S]*?border-bottom-color:/);
    const tabRule = detail.match(/\.communications-tab\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(tabRule).not.toContain('border-radius');
  });

  it('keeps the conversation view two-pane and can select a channel', () => {
    expect(detail).toContain('let selectedChannel = $state<Channel | null>(null)');
    expect(detail).toContain('onselectchannel={selectChannel}');
    expect(detail).toContain('selectedChannelId={selectedChannel?.channelId ?? null}');
    expect(detail).toContain('<ChannelView');
    expect(detail).toContain('channel={selectedChannel}');
    expect(detail).toContain("invoke<AppConfig>('get_config')");
    expect(detail).toContain('{selfPersonUid}');
    expect(detail).toContain('data-testid="quick-communications-conversations"');
    expect(detail).toContain("class:group-channel={selectedChannel?.scope === 'group'}");
    expect(detail).toMatch(
      /\.detail-main\.group-channel :global\(\.channel-hash\)\s*\{[^}]*display:\s*none/,
    );
  });

  it('provides an honest asynchronous jump to the full Messages or Inbox view', () => {
    expect(detail).toContain('async function openFullView()');
    expect(detail).toContain("invoke('open_messages_window'");
    expect(detail).toContain("invoke('open_desktop_alt_window', { route: 'inbox' })");
    expect(detail).toContain('data-testid="communications-open-full"');
    expect(detail).toContain('aria-busy={openingFullView}');
    expect(detail).toContain("{openingFullView ? 'Opening…' : 'Open full view'}");
  });

  it('merges messages and channels into an activity-sorted, searchable room rail', () => {
    expect(sidePane).toContain("invoke<ChannelsResponse | null>('list_channels')");
    expect(sidePane).toContain('onselectchannel?: (channel: Channel) => void');
    expect(sidePane).toContain('selectedChannelId?: string | null');
    expect(sidePane).toContain("channel.scope === 'group'");
    expect(sidePane).toContain('kind="group"');
    expect(sidePane).toContain('kind="channel"');
    expect(sidePane).toContain('members={(channel.members ?? []).map');
    expect(sidePane).toContain('channel.unread');
    expect(sidePane).toContain("'other' : 'others'");
    expect(sidePane).toContain('data-testid="quick-channel-row"');
    expect(sidePane).toContain('data-testid="quick-conversation-row"');
    expect(sidePane).toContain('data-provenance="group-dm"');
    expect(sidePane).toContain("kind: 'conversation'");
    expect(sidePane).toContain("kind: 'channel'");
    expect(sidePane).toContain('orderQuickWindowChannels(channels)');
    expect(sidePane).toContain('.sort((a, b) => b.timestamp - a.timestamp)');
    expect(sidePane).not.toContain('.slice(0, 12)');
    expect(sidePane).toContain('aria-label="Message sources"');
    expect(sidePane).not.toContain('aria-labelledby="quick-conversations-label"');
    expect(sidePane).toContain('id="quick-conversations-label">Direct messages');
    expect(sidePane).toContain('<div class="qw-side-label">Channels</div>');
    expect(sidePane).toContain('placeholder="Find a conversation"');
    expect(sidePane).toContain('filteredDirectEntries');
    expect(sidePane).not.toContain('sourceLabel=');
    expect(sidePane).not.toContain('text={row.latest');
    expect(sidePane).not.toMatch(/\.conversation-row\s*\{[\s\S]*?border-left:/);
  });

  it('keeps group-DM language human after the conversation is selected', () => {
    expect(channelView).toContain("const isGroup = $derived(current.scope === 'group')");
    expect(channelView).toContain('const conversationLabel = $derived(isGroup ? title : `#${title}`)');
    expect(channelView).toContain("{#if !isGroup}<span class=\"channel-hash\"");
    expect(channelView).toContain("isGroup ? 'Join conversation' : `Join #${title}`");
    expect(channelView).toContain('placeholder={`Message ${conversationLabel}…`}');
  });

  it('uses loading placeholders instead of collapsing the rail to one status line', () => {
    expect(sidePane).toContain('class="qw-skeleton-row"');
    expect(sidePane).toContain('aria-label="Loading conversations"');
    expect(sidePane).toContain('aria-busy={loading || loadingChannels}');
    expect(sidePane).toMatch(/\.conversation-row\s*\{[\s\S]*?min-height:\s*34px/);
  });

  it('keeps one native material, a browser fallback, and flat structural descendants', () => {
    expect(detail).toMatch(/\.detail-window\s*\{[\s\S]*?backdrop-filter:/);
    expect(detail).toMatch(/\.detail-window\.native-glass\s*\{[\s\S]*?backdrop-filter:\s*none/);
    expect(detail).toContain('--compact-glass-bg');
    expect(detail).toMatch(/\.communications-header\s*\{[\s\S]*?background:\s*transparent/);
    expect(detail).toMatch(/\.detail-main\s*\{[\s\S]*?background:\s*transparent/);
    expect(detail).toMatch(/\.notifications-pane\s*\{[\s\S]*?background:\s*transparent/);
  });

  it('distinguishes failed hydration from a true empty rail and exposes retry', () => {
    expect(sidePane).toContain("loadError = 'Messages are unavailable.'");
    expect(sidePane).toContain("channelLoadError = 'Channels are unavailable.'");
    expect(sidePane).toContain('class="qw-load-error"');
    expect(sidePane).toContain('async function retryFailedSources()');
    expect(sidePane).toContain('aria-busy={retrying}');
    expect(sidePane).toContain("{retrying ? 'Retrying…' : 'Retry'}");
  });
});
