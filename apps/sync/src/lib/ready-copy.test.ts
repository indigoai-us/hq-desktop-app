import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { setupActivityPhrase, setupActivityLabel, SETUP_ACTIVITY_PHRASES } from './onboarding-setup';

describe('setup activity copy', () => {
  it('names every native queue item in plain language', () => {
    const source = readFileSync(new URL('../../../../crates/hq-desktop-core/src/install_queue.rs', import.meta.url), 'utf8');
    // Variants come from the declared queue order; each id is the first
    // `QueueItemId::Variant => "id"` arm for that variant (as_str precedes the
    // label table). No dependence on method names, layout or a fixed count.
    const order = source.match(/pub const ALL:\s*\[QueueItemId;\s*(\d+)\]\s*=\s*\[([^\]]*)\]/);
    expect(order).not.toBeNull();
    const variants = [...order![2].matchAll(/QueueItemId::(\w+)/g)].map(m => m[1]);
    expect(variants).toHaveLength(Number(order![1]));
    const firstArm = new Map<string, string>();
    for (const m of source.matchAll(/QueueItemId::(\w+)\s*=>\s*"([a-z][a-z-]*)"/g)) {
      if (!firstArm.has(m[1])) firstArm.set(m[1], m[2]);
    }
    const ids = variants.map(v => firstArm.get(v));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(variants.length);
    // Ids are the kebab-case variant names, so a label arm can never stand in.
    expect(ids).toEqual(variants.map(v => v.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()));
    for (const id of ids as string[]) {
      expect(SETUP_ACTIVITY_PHRASES).toHaveProperty(id);
      expect(setupActivityPhrase(id)).toMatch(/^(installing|connecting|building|syncing) /);
      expect(setupActivityPhrase(id)).not.toMatch(/Step|[!—]/);
    }
    expect(setupActivityPhrase('hq-cli')).toBe('installing the hq command');
    expect(setupActivityPhrase('vault-upload')).toBe('syncing your files');
    expect(setupActivityPhrase('search-index')).toBe('building search');
  });
  it('uses sentence case standalone and a nonempty fallback for blocking work', () => {
    expect(setupActivityLabel('content')).toBe('Setting up your workspace');
    expect(setupActivityLabel(null, 'Setting up HQ')).toBe('Setting up HQ');
    expect(setupActivityLabel('future-item', 'Setting up HQ')).toBe('Setting up HQ');
    expect(setupActivityLabel(null)).toBeNull();
    expect(setupActivityLabel('future-item')).toBeNull();
    expect(setupActivityPhrase('hq-cli')).toBe('installing the hq command');
  });
  it('names blocking stages and suppresses idle or unknown items', () => {
    expect(setupActivityPhrase('content')).toBe('setting up your workspace');
    expect(setupActivityPhrase('git-init')).toBe('setting up file history');
    expect(setupActivityPhrase('personalize')).toBe('personalizing your workspace');
    expect(setupActivityPhrase(null)).toBeNull();
    expect(setupActivityPhrase('future-item')).toBeNull();
  });
});
