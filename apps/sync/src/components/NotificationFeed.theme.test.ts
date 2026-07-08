import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./NotificationFeed.svelte', import.meta.url), 'utf8');

describe('NotificationFeed popover theme tokens', () => {
  it('uses shared popover tokens for adaptive feed surfaces and text', () => {
    expect(source).toContain('color: var(--popover-text-muted);');
    expect(source).toContain('color: var(--popover-danger);');
    expect(source).toContain('background: var(--popover-action-hover);');
    expect(source).toContain('color: var(--popover-text-heading);');
    expect(source).toContain('color: var(--popover-text);');
    // Redesigned compact rows: neutral chips + unread dot ride the shared
    // surface/unread tokens instead of the legacy --accent aliases.
    expect(source).toContain('background: var(--popover-surface);');
    expect(source).toContain('var(--popover-unread');
  });

  it('does not reintroduce the dark-only notification feed palette', () => {
    expect(source).not.toMatch(/rgba\(255,\s*255,\s*255,\s*0\.0[45]\)/);
    expect(source).not.toContain('#8a8a90');
    expect(source).not.toContain('#8a8a92');
    expect(source).not.toContain('#f0a3a3');
    expect(source).not.toContain('#f2f2f4');
    expect(source).not.toContain('#b9b9c0');
    expect(source).not.toContain('#76767c');
    expect(source).not.toContain('#c2c2c8');
  });
});
