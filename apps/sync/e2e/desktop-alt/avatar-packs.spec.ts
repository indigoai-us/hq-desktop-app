import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readRepoFile } from './harness';

const ui = (rel: string) => readRepoFile(join('../../packages/ui', rel));

const MARKETPLACE_COVER_ORIGIN =
  'https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com';

describe('avatar pack picker source contract', () => {
  const mascotsJson = ui('src/avatars/packs/hq-agent-mascots.json');
  const snapshots = ui('src/avatars/snapshots.ts');
  const generated = ui('src/avatars/generated-marks.ts');
  const parsePack = ui('src/avatars/parse-pack.ts');
  const picker = ui('src/avatars/AvatarPackPicker.svelte');
  const agentAvatars = ui('src/chat/messaging/agent-avatars.ts');
  const identityMark = ui('src/chat/messaging/IdentityMark.svelte');
  const sidebarModel = ui('src/chat/sidebar-model.ts');
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
    const images = ['v1', 'v2'].flatMap((ver) =>
      readdirSync(join(root, ver))
        .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
        .map((name) => `${ver}/${name}`),
    );
    expect(images).toHaveLength(24);
    expect(existsSync(join(root, 'v2/dot.jpg'))).toBe(true);
    expect(snapshots).toMatch(/import\.meta\.glob\(/);
    expect(snapshots).not.toMatch(/typeof\s+import\.meta\.glob/);
    expect(snapshots).toContain('./packs/hq-agent-mascots/');
    expect(snapshots).toContain('bindBundledPackSrcs');
    expect(snapshots).toContain('lookupBundledAsset');
    expect(agentAvatars).toMatch(/import\.meta\.glob\(/);
    expect(agentAvatars).toContain('query: "?url"');
    expect(agentAvatars).toContain('agent-*.{png,svg,jpg,jpeg}');
  });

  it('keeps globbed avatar snapshots small enough for the universal binary', () => {
    // Vite dist is embedded in EACH slice of the macOS universal binary.
    // Uncompressed 512px PNGs in v0.10.181 added ~13 MB and failed the
    // 120 MB app-binary budget. JPEG 512px snapshots are the gate.
    const mascotRoot = join(
      process.cwd(),
      '../../packages/ui/src/avatars/packs/hq-agent-mascots/mascots',
    );
    const marksRoot = join(
      process.cwd(),
      '../../packages/ui/src/assets/agent-avatars',
    );
    const dirBytes = (dir: string, pattern: RegExp): number =>
      readdirSync(dir)
        .filter((name) => pattern.test(name))
        .reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
    const mascotBytes = ['v1', 'v2'].reduce(
      (sum, ver) =>
        sum + dirBytes(join(mascotRoot, ver), /\.(png|jpe?g|webp)$/i),
      0,
    );
    const markBytes = dirBytes(marksRoot, /^agent-.*\.(png|svg|jpe?g)$/i);
    expect(mascotBytes).toBeGreaterThan(0);
    expect(markBytes).toBeGreaterThan(0);
    expect(mascotBytes).toBeLessThan(1.5 * 1024 * 1024);
    expect(markBytes).toBeLessThan(0.75 * 1024 * 1024);
  });

  it('does not join Vite asset URLs onto builtin: and never paints http(s) tiles', () => {
    expect(parsePack).toContain('isResolvedPackItemSrc');
    expect(parsePack).toContain('cspSafeAvatarSrc');
    expect(parsePack).toContain('base.startsWith("builtin:")');
    expect(picker).toContain('cspSafeAvatarSrc');
    expect(picker).toContain('avatar-pack-item-fallback');
    expect(picker).toContain('onerror');
    // Message rows / rail photos use the same allowlist — they must not
    // paint arbitrary http(s) by stuffing a CDN URL into <img src>.
    expect(agentAvatars).toContain('paintableAvatarSrc');
    expect(identityMark).toContain('paintableAvatarSrc');
    expect(sidebarModel).toContain('paintableAvatarSrc');
    const imageSources = csp.app.security.csp
      .match(/(?:^|;)\s*img-src\s+([^;]+)/i)?.[1]
      ?.trim()
      .split(/\s+/);

    expect(imageSources).toContain("'self'");
    expect(imageSources).toContain('blob:');
    // Pack tiles never load over http(s) (`cspSafeAvatarSrc` returns null).
    // Marketplace covers and HQ profile photos share this one production
    // assets origin. Scheme wildcards stay forbidden.
    expect(imageSources?.filter((source) => /^https?:/i.test(source))).toEqual([
      MARKETPLACE_COVER_ORIGIN,
    ]);
  });
});
