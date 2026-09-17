import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

const sidePane = read('src/components/QuickWindowSidePane.svelte');
const channelView = read('src/components/messaging/ChannelView.svelte');

// The quick-communications side pane outlived the dm-detail window it was
// built for; share-detail is now its only host. These assertions cover the
// rail itself, which is unchanged by that window's removal.
describe('quick communications rail', () => {
  it('orients the rail around Slack-like rooms with activity behind a shortcut', () => {
    expect(sidePane).toContain('class="qw-rail-head"');
    expect(sidePane).toContain('class="qw-utility"');
    expect(sidePane).toContain('Mentions & activity');
    expect(sidePane).toContain('Open full desktop view');
    expect(sidePane).toContain('onopenactivity?: () => void');
    expect(sidePane).toContain('onopenfull?: () => void');
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
    expect(sidePane).toMatch(/\.conversation-row\s*\{[\s\S]*?min-height:\s*28px/);
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
