import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { setupActivityPhrase, SETUP_ACTIVITY_PHRASES } from './onboarding-setup';

describe('setup activity copy', () => {
  it('names every native queue item in plain language', () => {
    const source = readFileSync(new URL('../../../../crates/hq-desktop-core/src/install_queue.rs', import.meta.url), 'utf8');
    const ids = [...source.split('pub fn as_str')[1].split('pub fn parse')[0].matchAll(/=> "([a-z-]+)"/g)].map(m => m[1]);
    expect(ids).toHaveLength(12);
    for (const id of ids) {
      expect(SETUP_ACTIVITY_PHRASES).toHaveProperty(id);
      expect(setupActivityPhrase(id)).toMatch(/^(installing|connecting|building|syncing) /);
      expect(setupActivityPhrase(id)).not.toMatch(/Step|[!—]/);
    }
    expect(setupActivityPhrase('hq-cli')).toBe('installing the hq command');
    expect(setupActivityPhrase('vault-upload')).toBe('syncing your files');
    expect(setupActivityPhrase('search-index')).toBe('building search');
  });
  it('names blocking stages and suppresses idle or unknown items', () => {
    expect(setupActivityPhrase('content')).toBe('setting up your workspace');
    expect(setupActivityPhrase('git-init')).toBe('setting up file history');
    expect(setupActivityPhrase('personalize')).toBe('personalizing your workspace');
    expect(setupActivityPhrase(null)).toBeNull();
    expect(setupActivityPhrase('future-item')).toBeNull();
  });
});
