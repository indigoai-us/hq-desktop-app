import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The rise stills are reviewed frame by frame. The water's pixel pattern once
// showed through the mock sidebar as a dot grid, and the ripple ring had no
// still of its own. These guard both.
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const preview = readFileSync(resolve(appDir, 'dev-harness/RisePreview.svelte'), 'utf8');
const shots = readFileSync(resolve(appDir, 'scripts/rise-shots.mjs'), 'utf8');

describe('rise preview frame', () => {
  it('paints the sidebar as a plain gradient with no pixel pattern', () => {
    expect(preview).not.toMatch(/\.rail::(after|before)/);
    expect(preview).not.toMatch(/radial-gradient|repeating-linear-gradient/);
  });

  it('captures a ripple still at emergence, inside the first icon ring window', () => {
    const ripple = shots.match(/\{ phase: 'reveal', t: '([\d.]+)', name: 'ripple' \}/);
    expect(ripple).not.toBeNull();
    // First icon reaches the horizon at 9 s and breaks the water 30/140 s earlier. The ring lasts 0.6 s.
    const start = 9 - 30 / 140;
    expect(Number(ripple![1])).toBeGreaterThan(start);
    expect(Number(ripple![1])).toBeLessThan(start + 0.6);
  });
});
