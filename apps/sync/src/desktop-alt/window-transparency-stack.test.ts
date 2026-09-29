// Regression: the Appearance "Window opacity" slider had no visible effect
// because several full-window layers each painted their own backing:
//   .hq-work-embedded (HqWorkWorkShell, alpha floor .72 light / .78 dark)
//   .desktop-shell    (--v4-ground)
//   .shell-settings   (--v4-ground again, on the Settings screen)
// Stacked, those composite to ~99.7% opaque in dark mode at the slider's
// minimum, so the window looked solid at every value. Only .desktop-shell may
// paint the window ground, and that ground must actually open up.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const shell = read('./HqWorkWorkShell.svelte');
const settings = read('../../../../packages/ui/src/settings/ShellSettings.svelte');
const homeTokens = read('../../../../packages/ui/src/home/tokens.css');

function styleBlock(source: string): string {
  const match = source.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  return match ? match[1] : '';
}

function backgroundsFor(css: string, selector: string): string[] {
  const out: string[] = [];
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g');
  for (const m of css.matchAll(re)) {
    for (const d of m[1].matchAll(/(?:^|;|\s)background(?:-color|-image)?\s*:\s*([^;]+)/g)) {
      out.push(d[1].trim());
    }
  }
  return out;
}

/** Evaluate `--v4-ground` alpha for a given --hq-window-transparency-factor. */
function darkGroundAlpha(factor: number): number {
  const darkBlock = homeTokens.slice(homeTokens.indexOf(':root[data-force-theme="dark"]'));
  const m = darkBlock.match(/--v4-ground:\s*rgb\(17 17 17 \/ clamp\(([\d.]+),\s*calc\(([^;]+)\),\s*1\)\);/);
  if (!m) throw new Error('dark --v4-ground not found');
  const floor = Number(m[1]);
  const expr = m[2].replace(/var\(--hq-window-transparency-factor,\s*[\d.]+\)/g, String(factor));
  if (!/^[\d.\s+*/()-]+$/.test(expr)) throw new Error(`unexpected expression: ${expr}`);
  const value = Function(`return (${expr});`)() as number;
  return Math.min(1, Math.max(floor, value));
}

describe('window transparency layer stack', () => {
  it('does not paint a second window backing on .hq-work-embedded', () => {
    const backgrounds = backgroundsFor(styleBlock(shell), '.hq-work-embedded');
    expect(backgrounds.length).toBeGreaterThan(0);
    for (const bg of backgrounds) expect(bg).toBe('transparent');
  });

  it('does not repaint the ground on the Settings surface', () => {
    const backgrounds = backgroundsFor(styleBlock(settings), '.shell-settings');
    expect(backgrounds).toEqual(['transparent']);
  });

  it('lets the dark ground open up at the minimum opacity and stay solid at 100%', () => {
    expect(darkGroundAlpha(0)).toBe(1);
    expect(darkGroundAlpha(0.65)).toBeLessThanOrEqual(0.6);
    expect(darkGroundAlpha(0.65)).toBeGreaterThanOrEqual(0.5);
  });
});
