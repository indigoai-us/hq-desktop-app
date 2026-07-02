import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// DEV-1835 (feedback_d8a98754): two contained desktop-messaging bugs.
//   1. The "Copy message" icon copied only the top-level body, silently
//      dropping any block-formatted `details` beneath it.
//   2. There was no way to manually select/highlight a block-formatted
//      message, because the popover disables text selection app-wide.
//
// Fix 1 lives in the pure `copyableText` helper (unit-tested in
// src/lib/conversation-copy.test.ts). These are source-contract assertions
// (mirroring the US-* story tests) so the selection CSS + the class wiring
// can't silently regress.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const conversation = read('src/components/messaging/Conversation.svelte');
const popoverCss = read('src/styles/popover.css');

describe('DEV-1835: copy the whole block-formatted message', () => {
  it('the copy-message button copies the body kind through copyableText', () => {
    const c = normalize(conversation);
    // The hover-revealed bubble action copies kind 'body' — which now resolves
    // to body + details via the helper.
    expect(c).toContain("onclick={() => copyText(msg.eventId, 'body', msg)}");
    expect(c).toContain('const text = copyableText(msg, kind);');
  });
});

describe('DEV-1835: manual text selection of message bubbles', () => {
  it('marks the message body and details as selectable', () => {
    const c = normalize(conversation);
    expect(c).toContain('class="dm-bubble-body selectable-text"');
    expect(c).toContain('class="dm-bubble-details selectable-text"');
  });

  it('popover.css re-enables selection for .selectable-text', () => {
    const css = normalize(popoverCss);
    // Selection is turned back on for the opt-in class + its descendants.
    expect(css).toContain('.selectable-text, .selectable-text * { user-select: text; -webkit-user-select: text; }');
  });

  it('the app-wide selection kill-switch excludes .selectable-text so the opt-in wins', () => {
    const css = normalize(popoverCss);
    // The blanket `user-select: none` rule must exclude .selectable-text (and
    // its descendants); otherwise it out-specifies the opt-in and selection
    // stays broken.
    expect(css).toContain(':not(.selectable-text):not(.selectable-text *)');
  });
});
