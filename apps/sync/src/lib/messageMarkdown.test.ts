import { describe, expect, it } from 'vitest';
import { renderMessageBodyMarkdown } from './messageMarkdown';

describe('renderMessageBodyMarkdown', () => {
  it('renders markdown links used in conversation messages', () => {
    const html = renderMessageBodyMarkdown(
      'Changed [dmThread.ts](/home/ec2-user/hq-agent/repos/private/hq-desktop-app/apps/sync/src/lib/dmThread.ts:44).',
    );

    expect(html).toContain(
      '<a href="/home/ec2-user/hq-agent/repos/private/hq-desktop-app/apps/sync/src/lib/dmThread.ts:44"',
    );
    expect(html).toContain('>dmThread.ts</a>');
  });

  it('escapes raw HTML and drops unsafe link schemes', () => {
    const html = renderMessageBodyMarkdown(
      'See <script>alert(1)</script> and [bad](javascript:alert(1)).',
    );

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('bad');
  });
});
