import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/components/messaging/ChannelView.svelte'),
  'utf8',
);

describe('channel conversation lifecycle and hierarchy', () => {
  it('rejects late fetch and send completions after the selected channel changes', () => {
    expect(source).toContain('let loadGeneration = 0');
    expect(source).toContain('let sendGeneration = 0');
    expect(source).toContain('const requestedChannelId = current.channelId');
    expect(source).toMatch(
      /generation !== loadGeneration[\s\S]*?current\.channelId !== requestedChannelId/,
    );
    expect(source).toMatch(
      /generation !== sendGeneration[\s\S]*?current\.channelId !== requestedChannelId/,
    );
    expect(source).toContain('void markRead(requestedChannelId)');
  });

  it('preserves a trusted thread during refresh failure and disposes late listeners', () => {
    const loadCatch =
      source.match(
        /async function load\(\)[\s\S]*?catch \(err\) \{([\s\S]*?)\n    \} finally/,
      )?.[1] ?? '';
    expect(loadCatch).not.toContain('messages = []');
    expect(source).toContain('let disposed = false');
    expect(source).toContain('if (disposed) safe()');
    expect(source).toContain('const safe = safeUnlisten(unlisten)');
    expect(source).toContain('disposed = true');
  });

  it('uses flat inline metadata and announces the visible member count', () => {
    expect(source).toContain('`View ${memberCount}');
    expect(source).toMatch(
      /\.scope-chip \{[\s\S]*?padding: 0;[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/,
    );
    expect(source).toMatch(
      /\.member-count-btn \{[\s\S]*?border-bottom: 1px solid transparent;[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/,
    );
  });
});
