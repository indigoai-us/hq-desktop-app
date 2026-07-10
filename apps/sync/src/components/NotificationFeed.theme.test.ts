import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const feedSource = readFileSync(new URL('./NotificationFeed.svelte', import.meta.url), 'utf8');
const rowSource = readFileSync(new URL('./NotificationRow.svelte', import.meta.url), 'utf8');
const combined = `${feedSource}\n${rowSource}`;

describe('NotificationFeed + NotificationRow popover theme tokens', () => {
  it('uses shared popover tokens for adaptive feed surfaces and text', () => {
    // Feed chrome (status / empty / day labels)
    expect(feedSource).toContain('color: var(--popover-text-muted);');
    expect(feedSource).toContain('color: var(--popover-danger);');
    expect(feedSource).toContain('background: var(--popover-bg);');

    // Shared one-line row (NotificationRow) — locked design tokens
    expect(rowSource).toContain('color: var(--popover-text-muted);');
    expect(rowSource).toContain('color: var(--popover-text);');
    expect(rowSource).toContain('background: var(--popover-action-hover);');
    expect(rowSource).toContain('background: var(--popover-unread);');
    expect(rowSource).toContain('background: var(--popover-surface);');
    expect(rowSource).toContain('var(--popover-divider)');

    // Combined contract: the tokens the design system requires across both files
    expect(combined).toContain('--popover-text-muted');
    expect(combined).toContain('--popover-text');
    expect(combined).toContain('--popover-action-hover');
    expect(combined).toContain('--popover-unread');
    expect(combined).toContain('--popover-danger');
  });

  it('does not reintroduce the dark-only notification feed palette', () => {
    for (const source of [feedSource, rowSource]) {
      expect(source).not.toMatch(/rgba\(255,\s*255,\s*255,\s*0\.0[45]\)/);
      expect(source).not.toContain('#8a8a90');
      expect(source).not.toContain('#8a8a92');
      expect(source).not.toContain('#f0a3a3');
      expect(source).not.toContain('#f2f2f4');
      expect(source).not.toContain('#b9b9c0');
      expect(source).not.toContain('#76767c');
      expect(source).not.toContain('#c2c2c8');
      // Legacy avatar tints from the old two-line feed rows
      expect(source).not.toContain('#7e8cff');
      expect(source).not.toContain('#2fb98a');
      expect(source).not.toContain('rgba(126, 140, 255');
      expect(source).not.toContain('rgba(70, 214, 166');
    }
  });

  it('NotificationFeed adopts the shared NotificationRow component', () => {
    expect(feedSource).toContain("import NotificationRow from './NotificationRow.svelte'");
    expect(feedSource).toContain('<NotificationRow');
    expect(feedSource).toContain('type="message"');
    expect(feedSource).toContain('type="share"');
    expect(feedSource).toContain('type="sync"');
    // Old two-line design removed
    expect(feedSource).not.toContain('notif-avatar');
    expect(feedSource).not.toContain('ReactionBar');
    expect(feedSource).not.toContain('notif-cluster-files');
    expect(feedSource).not.toContain('notif-message-btn');
  });
});
