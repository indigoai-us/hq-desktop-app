import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('ThreadPanel pinned root', () => {
  it('renders the root through Conversation with no footer', () => {
    const threadPanel = read('src/components/messaging/ThreadPanel.svelte');
    const conversation = read('src/components/messaging/Conversation.svelte');

    expect(threadPanel).not.toContain('thread-root-bubble');
    expect(threadPanel).toContain('composer={false}');
    expect(conversation).toContain('composer = true');
  });
});
