// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('svelte', async () => {
  // @ts-expect-error Browser runtime is required for component mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});
import { flushSync, mount, unmount } from 'svelte';
import SessionTranscript from './SessionTranscript.svelte';

let component: ReturnType<typeof mount> | undefined;
afterEach(() => { if (component) unmount(component); document.body.innerHTML = ''; });

describe('session transcript reauth card', () => {
  it('renders a sign-in card instead of a red error for authentication_failed', () => {
    component = mount(SessionTranscript, {
      target: document.body,
      props: {
        blocks: [
          {
            type: 'error',
            id: 'e1',
            text: 'This session needs you to sign in again on this Mac.',
            tone: 'warn',
            code: 'authentication_failed',
            action: 'reauth',
            at: null,
          },
        ],
        onreauth: () => {},
        reauthTool: 'claude',
      },
    });
    flushSync();
    expect(document.querySelector('[data-testid="session-reauth-card"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="session-inline-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="session-reauth"]')?.textContent).toContain(
      'Sign in',
    );
  });
});

describe('session transcript rich content', () => {
  it('renders protocol question replies as readable question and answer pairs', () => {
    const text = '<send_user_message_question_reply>' + JSON.stringify([
      { questionItemId: 'internal-call-id', question: 'Can you run this?\n\n```sh\nhq status\n```', answer: 'Please debug without asking anyone.' },
      { questionItemId: 'another-id', question: 'Which path?', answer: '[This one](https://example.com)' },
    ]) + '</send_user_message_question_reply>';
    component = mount(SessionTranscript, { target: document.body, props: { blocks: [
      { type: 'userBubble', id: 'q1', attachments: [], at: null, text },
    ] } });
    flushSync();
    const replies = document.querySelector('[data-testid="session-question-replies"]')!;
    expect(replies.querySelectorAll('section')).toHaveLength(2);
    expect(replies.textContent).toContain('Please debug without asking anyone.');
    expect(replies.querySelector('pre code')?.textContent).toContain('hq status');
    expect(replies.textContent).not.toContain('internal-call-id');
    expect(replies.textContent).not.toContain('send_user_message_question_reply');
    expect(replies.textContent).not.toContain('\\n');
  });
  it('renders user Markdown links without duplicating their raw source', () => {
    component = mount(SessionTranscript, { target: document.body, props: { blocks: [
      { type: 'userBubble', id: 'u1', attachments: [], at: null, text: '[Read report](https://example.com/report)\n\nHelp me debug this' },
    ] } });
    flushSync();
    const bubble = document.querySelector('[data-testid="session-user-bubble"]')!;
    expect(bubble.querySelector('a')?.getAttribute('href')).toBe('https://example.com/report');
    expect(bubble.textContent).toContain('Help me debug this');
    expect(bubble.textContent).not.toContain('[Read report]');
  });

  it('renders GFM tables as real tables, not display:block pipes', () => {
    const table = [
      '| ID | Title | Status |',
      '| --- | --- | --- |',
      '| US-001 | Nested restore | done |',
      '| US-007 | Accept the matrix | in_progress |',
    ].join('\n');
    component = mount(SessionTranscript, { target: document.body, props: { blocks: [
      { type: 'assistantProse', id: 'a1', at: null, text: table, streaming: false },
    ] } });
    flushSync();
    const prose = document.querySelector('[data-testid="session-assistant-prose"]')!;
    expect(prose.querySelector('.markdown-table-scroll')).not.toBeNull();
    expect(prose.querySelectorAll('th')).toHaveLength(3);
    expect(prose.querySelectorAll('td')).toHaveLength(6);
    expect(prose.textContent).toContain('US-007');
    expect(prose.textContent).not.toContain('| US-007 |');
  });

  it('preserves the entire long code line and sanitizes user HTML', () => {
    const line = `hq files get ${'long-path/'.repeat(150)}`;
    component = mount(SessionTranscript, { target: document.body, props: { blocks: [
      { type: 'userBubble', id: 'u1', attachments: [], at: null, text: '<script>alert(1)</script>\n\n```sh\n' + line + '\n```' },
      { type: 'assistantProse', id: 'a1', at: null, text: '```sh\n' + line + '\n```', streaming: false },
    ] } });
    flushSync();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelectorAll('pre code')).toHaveLength(2);
    for (const code of document.querySelectorAll('pre code')) expect(code.textContent).toContain(line);
  });
});
