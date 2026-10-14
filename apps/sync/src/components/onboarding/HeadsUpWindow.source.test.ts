// The heads-up is the first frame of the welcome flow at card size
// (install-flow-rethink US-002 polish). It must read the flow's own tokens,
// type and buttons from welcome.css rather than carry copies, so the two cannot
// drift apart. Pinned as a source contract: the test DOM has no layout, fonts
// or transitions to check.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const headsUp = readFileSync(
  resolve(process.cwd(), 'src/components/onboarding/HeadsUpWindow.svelte'),
  'utf8',
);
const welcomeCss = readFileSync(
  resolve(process.cwd(), 'src/components/onboarding/welcome/welcome.css'),
  'utf8',
);
const style = headsUp.slice(headsUp.indexOf('<style>'));

describe('HeadsUpWindow: shared welcome-flow look', () => {
  it('renders inside the .hq-welcome root and loads welcome.css itself', () => {
    expect(headsUp).toContain("import './welcome/welcome.css';");
    expect(headsUp).toMatch(/class="hq-welcome heads-up"/);
  });

  it('uses the flow title and body type, not its own font setup', () => {
    expect(headsUp).toMatch(/<h1 class="h title"/);
    expect(headsUp).toMatch(/<ul class="body points"/);
    expect(style).not.toContain('@font-face');
    expect(style).not.toMatch(/font-family/);
  });

  it('uses the flow buttons', () => {
    expect(headsUp).toContain('class="btn btn-primary"');
    expect(headsUp.match(/class="btn btn-secondary"/g)).toHaveLength(2);
    expect(style).not.toMatch(/^\s*\.btn\s*\{/m);
  });

  it('paints with the flow veil, grain, easing and faint text tokens', () => {
    expect(style).toContain('var(--w-veil-bg)');
    expect(style).toContain('var(--w-ease-in-out)');
    expect(style).toContain('var(--w-ease-out)');
    expect(style).toContain('var(--w-faint)');
    expect(style).toContain('var(--w-text)');
    expect(headsUp).toMatch(/<div class="grain" class:on=\{ready\}/);
  });

  it('carries the HQ mark from the takeover', () => {
    expect(headsUp).toContain("import { HQ_MARK_H, HQ_MARK_Q } from './welcome/engines';");
    expect(headsUp).toContain('viewBox="0 0 280 161"');
  });

  it('enters with the takeover motion: 0.9s ease-out, 12px lift, buttons at 0.7s', () => {
    expect(style).toMatch(/opacity 0\.9s var\(--w-ease-out\)/);
    expect(style).toMatch(/transform 0\.9s var\(--w-ease-out\)/);
    expect(style).toContain('translateY(12px)');
    expect(style).toContain('transition-delay: 0.7s');
  });

  it('stays transparent until the window is at card size', () => {
    expect(headsUp).toMatch(/class:ready/);
    expect(headsUp).toMatch(/<div class="content" class:on=\{ready\}/);
    expect(style).toMatch(/\.surface \{[^}]*opacity: 0;/);
    expect(style).toMatch(/\.ready \.surface \{\s*opacity: 1;/);
  });

  it('follows the UI rules: weight 500 at most, no left bars, no backdrop-filter', () => {
    for (const match of style.matchAll(/font-weight:\s*(\d+)/g)) {
      expect(Number(match[1])).toBeLessThanOrEqual(500);
    }
    expect(style).not.toMatch(/border-left/);
    expect(style).not.toMatch(/backdrop-filter:/);
  });

  it('welcome.css still defines the shared tokens at the values the heads-up relies on', () => {
    const token = (name: string) =>
      welcomeCss.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
    expect(token('w-font-sans')).toBe("'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif");
    expect(token('w-font-display')).toBe("'Fraunces', Georgia, 'Times New Roman', serif");
    expect(token('w-veil-bg')).toBe('rgba(0, 0, 0, 0.72)');
    expect(token('w-text')).toBe('#fff');
    expect(token('w-muted')).toBe('rgba(255, 255, 255, 0.62)');
    expect(token('w-faint')).toBe('rgba(255, 255, 255, 0.38)');
    expect(token('w-btn-bg')).toBe('#fff');
    expect(token('w-btn2-bg')).toBe('rgba(255, 255, 255, 0.14)');
    expect(token('w-ease-out')).toBe('cubic-bezier(0.23, 1, 0.32, 1)');
    expect(token('w-ease-in-out')).toBe('cubic-bezier(0.77, 0, 0.175, 1)');
    expect(token('w-radius-button')).toBe('8px');
  });

  it('welcome.css still gives the title, body and entrance the takeover values', () => {
    expect(welcomeCss).toMatch(
      /\.hq-welcome \.h \{[^}]*font-weight: 300;[^}]*'WONK' 1;[^}]*letter-spacing: -0\.04em;/,
    );
    expect(welcomeCss).toMatch(/\.hq-welcome \.body \{[^}]*font-size: 15px;[^}]*line-height: 22px;/);
    expect(welcomeCss).toMatch(/\.hq-welcome \.on \.h \{[^}]*transition-delay: 0\.18s;/);
    expect(welcomeCss).toMatch(/\.hq-welcome \.on \.body \{[^}]*transition-delay: 0\.32s;/);
  });
});
