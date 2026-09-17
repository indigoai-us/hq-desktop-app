import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * v0.10.269 shipped `msg_send![glass, setIgnoresMouseEvents: true]` against
 * NSGlassEffectView. That selector belongs to NSWindow, not NSView, so every
 * launch raised NSInvalidArgumentException and aborted the process before the
 * desktop window appeared. Nothing caught it: the Rust builds fine (msg_send!
 * is unchecked at compile time) and no test drives a real macOS window.
 *
 * This is the cheap guard — the objc selectors sent to the glass *view* must
 * not include NSWindow-only ones.
 */
const WINDOW_ONLY_SELECTORS = [
  'setIgnoresMouseEvents',
  'setOpaque',
  'setTitlebarAppearsTransparent',
  'setMovableByWindowBackground',
  'setLevel',
  'setCollectionBehavior',
];

describe('macOS glass backing', () => {
  const source = readRepoFile('src-tauri/src/glass.rs');

  const sentToGlass = [...source.matchAll(/msg_send!\[\s*glass\s*,\s*([A-Za-z]+)/g)].map(
    (match) => match[1],
  );

  it('sends at least one selector to the glass view', () => {
    expect(sentToGlass.length).toBeGreaterThan(0);
  });

  it.each(WINDOW_ONLY_SELECTORS)(
    'never sends the NSWindow-only selector %s to an NSView',
    (selector) => {
      expect(sentToGlass).not.toContain(selector);
    },
  );
});
