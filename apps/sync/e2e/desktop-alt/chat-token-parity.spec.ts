// @vitest-environment happy-dom
//
// Chat-shell token parity with the canonical Daybook prototype
// (design/desktop-os-redesign : apps/sync/dev-harness/v2/DaybookApp.svelte,
// Lizzie Liu). The chat shell must render with HER exact values — fonts,
// colors in both themes, surfaces, hairlines, shadows.
//
// AUTHORIZED POLICY OVERRIDE (recorded in prd.json decisions): the Daybook
// design's rounded radii, font weights, and hue colors intentionally win over
// the repo's no-rounded-corners / monochrome policies for the chat shell.
// Do not "fix" these expectations back to the neutral palette.
//
// Two layers of protection:
//   1. getComputedStyle assertions: the real chat-tokens.css is injected into
//      a live (happy-dom) document and every token is resolved off an actual
//      `.chat-shell` element — dark via `data-force-theme='dark'`, light via
//      the default `:root` path. This catches selector/cascade drift, not
//      just text drift.
//   2. The expected values below are literals copied from the Daybook source,
//      NOT read from our files — so any edit to chat-tokens.css that departs
//      from the canonical design fails here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TOKENS_CSS = readFileSync(
  join(__dirname, '../../src/desktop-alt/chat/chat-tokens.css'),
  'utf8',
);

// ── Canonical values (verbatim from DaybookApp.svelte <style>) ─────────────

const DARK: Record<string, string> = {
  '--side-bg': 'rgba(0, 0, 0, 0.12)',
  '--ground': 'rgba(255, 255, 255, 0.02)',
  '--raised': 'rgba(255, 255, 255, 0.05)',
  '--btn-bg': 'rgba(255, 255, 255, 0.07)',
  '--elevated': '#1e1e24',
  '--panel-bg': 'rgba(44, 44, 54, 0.94)',
  '--panel-border': 'rgba(255, 255, 255, 0.1)',
  '--panel-edge': '#2b2b33',
  '--border-active': 'rgba(255, 255, 255, 0.3)',
  '--line': 'rgba(255, 255, 255, 0.07)',
  '--line2': 'rgba(255, 255, 255, 0.11)',
  '--t1': 'rgba(255, 255, 255, 0.95)',
  '--t2': 'rgba(255, 255, 255, 0.56)',
  '--t3': 'rgba(255, 255, 255, 0.32)',
  '--ice': '#c9d6e4',
  '--ice-ink': '#c9d6e4',
  '--ice-tile': '#2c3d52',
  '--badge-fg': '#101014',
  '--ok': '#34c759',
  '--ok-ink': '#4ade80',
  '--warn': '#facc15',
  '--warn-ink': '#facc15',
  '--vio': '#c084fc',
  '--vio-ink': '#e0c4fe',
  '--hover': 'rgba(255, 255, 255, 0.05)',
  '--sel': 'rgba(255, 255, 255, 0.08)',
  '--panel-shadow': '0 16px 40px rgba(0, 0, 0, 0.5)',
};

const LIGHT: Record<string, string> = {
  '--side-bg': 'rgba(255, 255, 255, 0.18)',
  '--ground': 'rgba(255, 255, 255, 0.35)',
  '--raised': 'rgba(0, 0, 0, 0.035)',
  '--btn-bg': 'rgba(0, 0, 0, 0.045)',
  '--elevated': '#ffffff',
  '--panel-bg': 'rgba(252, 252, 253, 0.96)',
  '--panel-border': 'rgba(0, 0, 0, 0.07)',
  '--panel-edge': '#f0f1f4',
  '--border-active': 'rgba(0, 0, 0, 0.3)',
  '--line': 'rgba(0, 0, 0, 0.08)',
  '--line2': 'rgba(0, 0, 0, 0.12)',
  '--t1': 'rgba(0, 0, 0, 0.88)',
  '--t2': 'rgba(0, 0, 0, 0.55)',
  '--t3': 'rgba(0, 0, 0, 0.34)',
  '--ice': '#c9d6e4',
  '--ice-ink': '#3e5a75',
  '--ice-tile': '#d3e0ee',
  '--badge-fg': '#ffffff',
  '--ok': '#34c759',
  '--ok-ink': '#248a3d',
  '--warn': '#f0a800',
  '--warn-ink': '#b45309',
  '--hover': 'rgba(0, 0, 0, 0.045)',
  '--sel': 'rgba(0, 0, 0, 0.07)',
  '--panel-shadow': '0 16px 40px rgba(0, 0, 0, 0.18)',
};

const FONT_UI = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const FONT_MONO = "'Geist Mono', ui-monospace, Menlo, monospace";

// ── Live-cascade harness ────────────────────────────────────────────────────

let styleEl: HTMLStyleElement;
let shell: HTMLDivElement;

beforeEach(() => {
  styleEl = document.createElement('style');
  styleEl.textContent = TOKENS_CSS;
  document.head.appendChild(styleEl);
  shell = document.createElement('div');
  shell.className = 'chat-shell';
  document.body.appendChild(shell);
});

afterEach(() => {
  styleEl.remove();
  shell.remove();
  document.documentElement.removeAttribute('data-force-theme');
  document.documentElement.classList.remove('dark');
});

const resolved = (prop: string): string =>
  getComputedStyle(shell).getPropertyValue(prop).trim();

// happy-dom's computed-style support for custom properties across descendant
// selectors is verified by a sentinel: if the engine can't resolve --t1 at
// all, the whole live-cascade layer is inapplicable and the source-contract
// layer below is the guard. We fail loudly rather than skip silently.
function assertTheme(expected: Record<string, string>) {
  const sentinel = resolved('--t1');
  expect(sentinel, 'happy-dom failed to resolve any chat token').not.toBe('');
  for (const [prop, value] of Object.entries(expected)) {
    expect(`${prop}: ${resolved(prop)}`).toBe(`${prop}: ${value}`);
  }
}

describe('chat-shell token parity — dark theme (forced)', () => {
  it('resolves every Daybook dark token off a live .chat-shell element', () => {
    document.documentElement.setAttribute('data-force-theme', 'dark');
    assertTheme(DARK);
  });

  it('resolves the dark tokens via the `.dark` class path too', () => {
    document.documentElement.classList.add('dark');
    assertTheme(DARK);
  });
});

describe('chat-shell token parity — light theme (default + forced)', () => {
  it('resolves every Daybook light token off a live .chat-shell element', () => {
    assertTheme(LIGHT);
  });

  it('resolves the light tokens when light is forced explicitly', () => {
    document.documentElement.setAttribute('data-force-theme', 'light');
    assertTheme(LIGHT);
  });
});

describe('chat-shell typography parity', () => {
  it('carries the Daybook UI + mono font stacks', () => {
    expect(resolved('--font-ui')).toBe(FONT_UI);
    expect(resolved('--font-mono')).toBe(FONT_MONO);
  });

  it('sets the Daybook base text style (400 13px / 1.45)', () => {
    const cs = getComputedStyle(shell);
    expect(cs.fontSize).toBe('13px');
    expect(cs.fontWeight === '400' || cs.fontWeight === 'normal').toBe(true);
    expect(cs.lineHeight === '1.45' || cs.lineHeight === '18.85px').toBe(true);
  });
});

// ── Source-contract layer ───────────────────────────────────────────────────
// Independent of any DOM engine: the literal declarations must exist in
// chat-tokens.css exactly as the Daybook source wrote them.

function block(marker: string, source: string): string {
  const start = source.indexOf(marker);
  expect(start, `missing CSS block: ${marker}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

describe('chat-tokens.css source contract', () => {
  it('declares the dark values verbatim on the base .chat-shell block', () => {
    const dark = block('.chat-shell {', TOKENS_CSS);
    for (const [prop, value] of Object.entries(DARK)) {
      expect(dark, `${prop} must be ${value}`).toContain(`${prop}: ${value};`);
    }
    expect(dark).toContain('font: 400 13px/1.45 var(--font-ui);');
  });

  it('declares the light values verbatim on the light override block', () => {
    const light = block(":root[data-force-theme='light'] .chat-shell", TOKENS_CSS);
    for (const [prop, value] of Object.entries(LIGHT)) {
      expect(light, `${prop} must be ${value}`).toContain(`${prop}: ${value};`);
    }
  });
});
