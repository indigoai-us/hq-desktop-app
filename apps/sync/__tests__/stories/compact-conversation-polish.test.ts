import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const conversation = source('../../src/components/messaging/Conversation.svelte');
const dmThreadPane = source('../../src/components/DmThreadPane.svelte');
const channelView = source('../../src/components/messaging/ChannelView.svelte');
const messagingSources = `${conversation}\n${dmThreadPane}\n${channelView}`;

describe('compact conversation polish', () => {
  it('keeps ordinary compact-window messages unboxed and reserves cards for shared files', () => {
    expect(conversation).toContain("html[data-window='dm-detail']");
    expect(conversation).toContain('class:dm-bubble-share={!!msg.share}');
    expect(conversation).toMatch(
      /\.dm-msg-in \.dm-bubble:not\(\.dm-bubble-share\)[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/,
    );
    expect(conversation).toMatch(
      /\.dm-msg-out \.dm-bubble:not\(\.dm-bubble-share\)[\s\S]*?background: color-mix/,
    );
    expect(conversation).toMatch(
      /\.dm-bubble\.dm-bubble-share[\s\S]*?border: 1px solid[\s\S]*?border-radius: 10px;[\s\S]*?background: color-mix/,
    );
  });

  it('renders compact thread and channel metadata as quiet inline actions', () => {
    expect(conversation).toMatch(
      /\.thread-affordance \{[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/,
    );
    expect(channelView).toMatch(
      /\.scope-chip \{[\s\S]*?border: 0;[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/,
    );
    expect(channelView).toMatch(
      /\.member-count-btn \{[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/,
    );
  });

  it('preserves the dedicated full Messages-window treatment', () => {
    expect(conversation).toContain(":global([data-window='messages']) .dm-msg-in .dm-bubble");
    expect(conversation).toContain(":global([data-window='messages']) .dm-msg-out .dm-bubble");
    expect(conversation).toContain(":global([data-window='messages']) .dm-bubble-share");
  });

  it('supports local retries and pending feedback for load, join, and send actions', () => {
    expect(conversation).toContain('onretryload?: () => void | Promise<void>;');
    expect(conversation).toContain('aria-busy={loading || retryingLoad}');
    expect(conversation).toContain('class="load-retry"');
    expect(conversation).toContain('aria-busy={sending}');
    expect(conversation).toContain('class="inline-spinner"');
    expect(dmThreadPane).toContain('onretryload={retryThread}');
    expect(channelView.match(/onretryload=\{retryThread\}/g)).toHaveLength(2);
    expect(channelView).toContain('aria-busy={joining}');
    expect(channelView).toContain('class="inline-spinner"');
  });

  it('follows new content only near the bottom and offers an explicit jump otherwise', () => {
    expect(conversation).toContain('const NEAR_BOTTOM_PX = 72;');
    expect(conversation).toContain('function isNearBottom(element: HTMLDivElement): boolean');
    expect(conversation).toContain('onscroll={handleThreadScroll}');
    expect(conversation).toContain('const shouldFollow = !positionedInitialThread || nearBottom;');
    expect(conversation).toContain('newMessagesAvailable = true;');
    expect(conversation).toContain('class="new-messages-jump"');
    expect(conversation).not.toContain('void scrollToBottom()');
  });

  it('uses restrained press motion, visible focus, and reduced-motion fallbacks', () => {
    expect(messagingSources).toContain(
      'transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);',
    );
    expect(messagingSources).toContain('transform: scale(0.97);');
    expect(messagingSources).toContain(':focus-visible');
    expect(messagingSources).toContain('@media (prefers-reduced-motion: reduce)');
    expect(messagingSources).not.toMatch(/transition:\s*all/i);
    expect(messagingSources).not.toMatch(/\bease-in(?:\s|;|,)/i);
    expect(messagingSources).not.toMatch(/scale\(0\)/i);
  });
});
