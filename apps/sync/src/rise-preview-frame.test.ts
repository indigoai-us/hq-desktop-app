import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RISE_FIRST_S, RISE_ICON, RISE_RIPPLE_S, RISE_SPEED } from '../../../packages/ui/src/brief/brief-rise';

// The rise stills are reviewed frame by frame. The water's pixel pattern once
// showed through the mock sidebar as a dot grid, and the ripple ring had no
// still of its own. These guard both.
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const preview = readFileSync(resolve(appDir, 'dev-harness/RisePreview.svelte'), 'utf8');
const shots = readFileSync(resolve(appDir, 'scripts/rise-shots.mjs'), 'utf8');

describe('rise preview frame', () => {
  it('paints the sidebar as a plain gradient with no pixel pattern', () => {
    const rail = preview.match(/\n {2}\.rail \{[^}]*\}/)?.[0] ?? '';
    expect(rail).toContain('linear-gradient(180deg');
    expect(rail).not.toMatch(/radial-gradient|repeating-|background-size/);
    expect(preview).not.toMatch(/\.rail::(after|before)/);
  });

  it('captures a ripple still at emergence, inside the first icon ring window', () => {
    const ripple = shots.match(/\{ phase: 'reveal', t: '([\d.]+)', name: 'ripple' \}/);
    expect(ripple).not.toBeNull();
    // The first icon breaks the water half an icon before it reaches the horizon.
    const start = RISE_FIRST_S - RISE_ICON / 2 / RISE_SPEED;
    expect(Number(ripple![1])).toBeGreaterThan(start);
    expect(Number(ripple![1])).toBeLessThan(start + RISE_RIPPLE_S);
  });
});
