import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('thread panel responsive layout', () => {
  it('keeps message bodies inside the shrinking conversation pane', () => {
    const shell = source('./MessagesShell.svelte');
    const conversation = source('./Conversation.svelte');

    expect(shell).toContain('.pane {');
    expect(shell).toContain('overflow: hidden;');
    expect(conversation).toContain('.dm-thread {');
    expect(conversation).toContain('min-width: 0;');
    expect(conversation).toContain('overflow-x: hidden;');
  });

  it('uses the thread overlay before the docked panes crowd the conversation', () => {
    const shell = source('./MessagesShell.svelte');

    expect(shell).toContain('@media (max-width: 1000px)');
    expect(shell).toContain('position: absolute;');
    expect(shell).toContain('width: min(100%, 420px);');
  });

  it('provides a draggable left edge for a docked thread panel', () => {
    const shell = source('./MessagesShell.svelte');

    expect(shell).toContain('class="thread-resize-handle"');
    expect(shell).toContain('onpointerdown={startThreadResize}');
    expect(shell).toContain('onpointermove={resizeThread}');
    expect(shell).toContain('cursor: col-resize;');
    expect(shell).toContain('MIN_THREAD_PANEL_WIDTH = 280');
    expect(shell).toContain('MAX_THREAD_PANEL_WIDTH = 560');
  });
});
