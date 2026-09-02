import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readRepoFile } from './harness';

const ui = (rel: string) => readRepoFile(join('../../packages/ui', rel));

describe('avatar pack picker source contract', () => {
  const mascotsJson = ui('src/avatars/packs/hq-agent-mascots.json');
  const snapshots = ui('src/avatars/snapshots.ts');
  const generated = ui('src/avatars/generated-marks.ts');
  const parsePack = ui('src/avatars/parse-pack.ts');
  const picker = ui('src/avatars/AvatarPackPicker.svelte');
  const agentAvatars = ui('src/chat/messaging/agent-avatars.ts');
  const docs = readRepoFile('docs/avatar-packs.md');
  const types = ui('src/avatars/types.ts');
  const csp = JSON.parse(readRepoFile('src-tauri/tauri.conf.json')) as {
    app: { security: { csp: string } };
  };

  it('renames the shipped packs to Animals and Default', () => {
    const catalog = JSON.parse(mascotsJson) as { name: string; author: string };
    expect(catalog.name).toBe('Animals');
    expect(catalog.author).toBe('Lizzy');
    expect(mascotsJson).not.toContain('HQ agent mascots');
    expect(types).toContain('GENERATED_MARKS_AUTHOR = "Default"');
    expect(types).toContain('HQ_AGENT_MASCOTS_PACK_NAME = "Animals"');
    expect(generated).toContain('GENERATED_MARKS_AUTHOR');
    expect(generated).not.toMatch(/author:\s*"HQ"/);
    expect(docs).toContain('"name": "Animals"');
    expect(docs).toContain('author line **Default**');
    expect(docs).not.toContain('HQ agent mascots');
  });

  it('bundles 24 mascot snapshot images and resolves them via import.meta.glob', () => {
    const root = join(
      process.cwd(),
      '../../packages/ui/src/avatars/packs/hq-agent-mascots/mascots',
    );
    const pngs = ['v1', 'v2'].flatMap((ver) =>
      readdirSync(join(root, ver))
        .filter((name) => name.endsWith('.png'))
        .map((name) => `${ver}/${name}`),
    );
    expect(pngs).toHaveLength(24);
    expect(existsSync(join(root, 'v2/dot.png'))).toBe(true);
    expect(snapshots).toMatch(/import\.meta\.glob\(/);
    expect(snapshots).not.toMatch(/typeof\s+import\.meta\.glob/);
    expect(snapshots).toContain('./packs/hq-agent-mascots/');
    expect(snapshots).toContain('bindBundledPackSrcs');
    expect(agentAvatars).toMatch(/import\.meta\.glob\(/);
    expect(agentAvatars).toContain('query: "?url"');
  });

  it('does not join Vite asset URLs onto builtin: and never paints http(s) tiles', () => {
    expect(parsePack).toContain('isResolvedPackItemSrc');
    expect(parsePack).toContain('cspSafeAvatarSrc');
    expect(parsePack).toContain('base.startsWith("builtin:")');
    expect(picker).toContain('cspSafeAvatarSrc');
    expect(picker).toContain('avatar-pack-item-fallback');
    expect(picker).toContain('onerror');
    expect(csp.app.security.csp).toContain("img-src 'self'");
    expect(csp.app.security.csp).toContain('blob:');
    // Pack tiles never load over http(s) (`cspSafeAvatarSrc` returns null).
    // Marketplace covers/avatars use this one production assets origin.
    // Scheme wildcards stay forbidden — pack tiles still cannot paint http(s).
    // Marketplace listing covers are the only remote img-src — one origin,
    // no scheme wildcard. Same contract as tauri-conf.spec.ts.
    expect(csp.app.security.csp).toContain(
      'https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com',
    );
    expect(csp.app.security.csp).not.toMatch(/img-src[^;]*\*/i);
    expect(csp.app.security.csp).not.toMatch(/img-src[^;]*https:\s/i);
    expect(csp.app.security.csp).not.toMatch(/img-src[^;]*https:\/\/\*/i);
  });
});
