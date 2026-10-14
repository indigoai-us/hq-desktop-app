import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  openHqShortcutChord,
  readOnboardingHostOs,
  shortcutKeyboardLayoutFor,
} from '../../../lib/onboarding-platform';
import { keyboardRowsFor } from './engines';

// The UA a Tauri WKWebView reports on macOS. No `__HQ_HOST_OS__` and no OS
// plugin globals exist in the onboarding window, so this is all it has.
const MAC_WEBKIT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)';

function sceneFor(ua: string) {
  const layout = shortcutKeyboardLayoutFor(readOnboardingHostOs(ua));
  const rows = keyboardRowsFor(layout);
  const chord = openHqShortcutChord(layout);
  const bottom = rows[rows.length - 1].map((k) => k.label);
  const ids = new Set(rows.flatMap((r) => r.map((k) => k.id)));
  const lit = rows.flatMap((r) => r).filter((k) => chord.highlight.includes(k.id));
  return { layout, rows, chord, bottom, ids, lit };
}

describe('shortcut scene keyboard', () => {
  it('draws the Mac board with option and shift lit and the ⌥ ⇧ O legend on macOS WebKit', () => {
    const s = sceneFor(MAC_WEBKIT_UA);
    expect(s.layout).toBe('mac');
    expect(s.bottom.slice(0, 7)).toEqual(['fn', 'control', 'option', 'command', '', 'command', 'option']);
    expect(s.bottom).not.toContain('Windows');
    expect(s.bottom).not.toContain('Alt');
    expect(s.lit.map((k) => k.label).sort()).toEqual(['O', 'option', 'shift']);
    expect(s.chord.keys).toEqual(['⌥', '⇧', 'O']);
    expect(s.chord.spoken).toBe('Option, Shift, O');
  });

  it.each([
    ['Windows', WINDOWS_UA],
    ['Linux', LINUX_UA],
    ['an unknown host', ''],
  ])('draws the PC board with Alt and shift lit and the Alt Shift O legend on %s', (_name, ua) => {
    const s = sceneFor(ua);
    expect(s.layout).toBe('pc');
    expect(s.bottom.slice(0, 7)).toEqual(['fn', 'control', 'Windows', 'Alt', '', 'Alt', 'Windows']);
    expect(s.bottom).not.toContain('option');
    expect(s.lit.map((k) => k.label).sort()).toEqual(['Alt', 'O', 'shift']);
    expect(s.chord.keys).toEqual(['Alt', 'Shift', 'O']);
    expect(s.chord.spoken).toBe('Alt, Shift, O');
  });

  it.each(['mac', 'pc'] as const)('every lit key exists on the %s board', (layout) => {
    const ids = new Set(keyboardRowsFor(layout).flatMap((r) => r.map((k) => k.id)));
    for (const id of openHqShortcutChord(layout).highlight) expect(ids.has(id)).toBe(true);
  });

  it('does not decide the layout from the shared platform probe at module load', () => {
    // The probe is empty in the onboarding window, so a module-level read drew
    // the PC board on a Mac. The board must come from the wizard's UA read.
    const engines = readFileSync(fileURLToPath(new URL('./engines.ts', import.meta.url)), 'utf8');
    expect(engines).not.toMatch(/hostComputerNoun/);
    expect(engines).not.toMatch(/export const KEYBOARD_ROWS/);
    const wizard = readFileSync(
      fileURLToPath(new URL('../OnboardingWizard.svelte', import.meta.url)),
      'utf8',
    );
    expect(wizard).toMatch(/keyboardRowsFor\(shortcutLayout\)/);
    expect(wizard).toMatch(/openHqShortcutChord\(shortcutLayout\)/);
    expect(wizard).toMatch(/\{#each keyboardRows as row/);
  });
});
