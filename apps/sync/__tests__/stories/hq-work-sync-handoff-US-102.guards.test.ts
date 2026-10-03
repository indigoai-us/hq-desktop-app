import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('US-102 Sync PlatformAdapter source guard', () => {
  it('does not clone createDesktopAdapter / WebPlatformAdapter', () => {
    const src = readFileSync(
      new URL('../../../../packages/platform/src/tauri/sync-adapter.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain('export function createSyncPlatformAdapter');
    expect(src).not.toContain('createDesktopAdapter');
    expect(src).not.toContain('WebPlatformAdapter');
    expect(src).not.toContain('new WebPlatformAdapter');
  });
});
