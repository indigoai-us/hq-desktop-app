// PR #1717 review, critical 2: the DM thread draws message avatars with the
// @hq/ui IdentityMark at its regular size. The avatar column in
// Conversation.svelte must be exactly that wide, or the mark overflows its cell
// and crowds the author name and body (the grid gap shrinks by the overflow).
// happy-dom does no layout, so this compares the declared sizes.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const conversation = readFileSync(resolve(here, 'Conversation.svelte'), 'utf8');
const identityMark = readFileSync(
  resolve(here, '../../../../../packages/ui/src/chat/messaging/IdentityMark.svelte'),
  'utf8',
);

/**
 * The body of the CSS rule whose selector list starts at a line beginning with
 * `selector` (so `  .dm-msg` does not match a nested `    .dm-msg`) and that
 * declares `prop`. A selector can have several rules; the one setting `prop`
 * is the one that matters.
 */
function rule(src: string, selector: string, prop: string): string {
  let from = 0;
  for (;;) {
    const at = src.indexOf(`\n${selector}`, from);
    if (at < 0) throw new Error(`no ${selector} rule declares ${prop}`);
    from = at + 1;
    const next = src[at + 1 + selector.length];
    if (next !== ' ' && next !== ',') continue;
    const open = src.indexOf('{', at);
    const body = src.slice(open + 1, src.indexOf('}', open));
    if (new RegExp(`(?:^|[;\\s])${prop}:`).test(body)) return body;
  }
}

function px(body: string, prop: string): number {
  const m = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`));
  expect(m, prop).not.toBeNull();
  return Number(m![1]);
}

describe('DM thread avatar column matches the @hq/ui IdentityMark size', () => {
  const markWidth = px(rule(identityMark, '  .identity', 'width'), 'width');

  it('renders message avatars at the regular IdentityMark size', () => {
    expect(conversation).toMatch(/<span class="dm-msg-avatar">\s*<IdentityMark[\s\S]*?size="regular"/);
    expect(markWidth).toBeGreaterThan(0);
  });

  it('sizes the grid column to the mark', () => {
    const grid = rule(conversation, '  .dm-msg', 'grid-template-columns');
    const first = grid.match(/grid-template-columns:\s*(\d+)px/);
    expect(first).not.toBeNull();
    expect(Number(first![1])).toBe(markWidth);
  });

  it('sizes the avatar cell and the continuation spacer to the mark', () => {
    expect(px(rule(conversation, '  .dm-msg-avatar', 'width'), 'width')).toBe(markWidth);
  });

  it('indents the date separator by the avatar column plus the grid gap', () => {
    const grid = rule(conversation, '  .dm-msg', 'grid-template-columns');
    expect(grid, 'grid gap is 0.625rem (10px)').toMatch(/gap:\s*0\.625rem/);
    expect(px(rule(conversation, '  .date-separator', 'margin-left'), 'margin-left')).toBe(
      markWidth + 10,
    );
  });
});
