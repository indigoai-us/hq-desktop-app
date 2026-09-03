import { describe, expect, it } from 'vitest';
import { isJumboEmojiBody } from './emojiShortcodes';
import { renderMessageBodyMarkdown } from './messageMarkdown';

describe('popover conversation emoji shortcodes', () => {
  it('renders a known shortcode as the emoji', () => {
    expect(renderMessageBodyMarkdown('banana :stuck_out_tongue_winking_eye:')).toContain(
      '😜',
    );
    expect(renderMessageBodyMarkdown('ship it :tada:')).toContain('🎉');
  });

  it('keeps an unknown shortcode literal', () => {
    expect(renderMessageBodyMarkdown('nope :nope:')).toContain(':nope:');
  });

  it('keeps shortcodes literal in code spans and fences', () => {
    expect(renderMessageBodyMarkdown('`:smile:`')).toContain('<code>:smile:</code>');
    expect(renderMessageBodyMarkdown('`:smile:`')).not.toContain('😄');
    const fenced = renderMessageBodyMarkdown('```\n:smile:\n```');
    expect(fenced).toContain(':smile:');
    expect(fenced).not.toContain('😄');
  });

  it('leaves a URL containing a shortcode untouched', () => {
    const html = renderMessageBodyMarkdown('see https://x.test/a/:smile:/b');
    expect(html).toContain('https://x.test/a/:smile:/b');
    expect(html).not.toContain('😄');
  });

  it('still wraps mentions, and converts emoji beside them', () => {
    const html = renderMessageBodyMarkdown('@Corey :tada:');
    expect(html).toContain('<span class="message-mention">@Corey</span>');
    expect(html).toContain('🎉');
  });

  it('flags emoji-only bodies for jumbo rendering', () => {
    expect(isJumboEmojiBody(':stuck_out_tongue_winking_eye:')).toBe(true);
    expect(isJumboEmojiBody('banana :stuck_out_tongue_winking_eye:')).toBe(false);
  });
});
