import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldUseNativePopoverMaterial } from './nativePopoverMaterial';

describe('native popover material platform gate', () => {
  it('uses native material only in Tauri on macOS and Windows', () => {
    expect(
      shouldUseNativePopoverMaterial(
        true,
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6)',
      ),
    ).toBe(true);
    expect(
      shouldUseNativePopoverMaterial(
        true,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      ),
    ).toBe(true);
  });

  it('keeps the CSS blur fallback in Linux Tauri and browser previews', () => {
    expect(
      shouldUseNativePopoverMaterial(
        true,
        'Mozilla/5.0 (X11; Linux x86_64)',
      ),
    ).toBe(false);
    expect(
      shouldUseNativePopoverMaterial(
        false,
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6)',
      ),
    ).toBe(false);
  });

  it('gates the production popover native-glass class through the platform helper', () => {
    const popover = readFileSync(
      resolve(process.cwd(), 'src/components/Popover.svelte'),
      'utf8',
    );
    expect(popover).toContain('shouldUseNativePopoverMaterial(');
    expect(popover).toContain('class:native-glass={nativeGlass}');
  });
});
