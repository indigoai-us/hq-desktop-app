import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readRepoFile } from './harness';

const ui = (rel: string) => readRepoFile(join('../../packages/ui', rel));

const MARKETPLACE_COVER_ORIGIN =
  'https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com';

const BINARY_IMAGE = /\.(png|jpe?g|gif|webp|svg|ico)$/i;

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

describe('avatar pack picker source contract', () => {
  const generated = ui('src/avatars/generated-marks.ts');
  const parsePack = ui('src/avatars/parse-pack.ts');
  const picker = ui('src/avatars/AvatarPackPicker.svelte');
  const gallery = ui('src/avatars/gallery.ts');
  const agentAvatars = ui('src/chat/messaging/agent-avatars.ts');
  const identityMark = ui('src/chat/messaging/IdentityMark.svelte');
  const sidebarModel = ui('src/chat/sidebar-model.ts');
  const cspSrc = ui('src/avatars/csp-image-src.ts');
  const docs = readRepoFile('docs/avatar-packs.md');
  const types = ui('src/avatars/types.ts');
  const csp = JSON.parse(readRepoFile('src-tauri/tauri.conf.json')) as {
    app: { security: { csp: string } };
  };

  it('keeps the Default / Animals names', () => {
    expect(types).toContain('GENERATED_MARKS_AUTHOR = "Default"');
    expect(types).toContain('HQ_AGENT_MASCOTS_PACK_NAME = "Animals"');
    expect(generated).toContain('GENERATED_MARKS_AUTHOR');
    expect(generated).not.toMatch(/author:\s*"HQ"/);
    expect(docs).toContain('**Animals**');
    expect(docs).toContain('credit line **Default**');
    expect(docs).not.toContain('HQ agent mascots');
  });

  it('does not ship binary pack images under packages/ui/src/avatars/packs', () => {
    const packsRoot = join(
      process.cwd(),
      '../../packages/ui/src/avatars/packs',
    );
    const binaries = listFiles(packsRoot).filter((path) =>
      BINARY_IMAGE.test(path),
    );
    expect(binaries).toEqual([]);
  });

  it('loads the gallery from hq-pro and lazy-loads thumbs', () => {
    expect(gallery).toContain('listAvatarPacks');
    expect(gallery).toContain('getAvatarPack');
    expect(gallery).toContain('GALLERY_CACHE_STORAGE_KEY');
    expect(picker).toContain('loading="lazy"');
    expect(picker).toContain('avatar-pack-skeleton');
    expect(picker).toContain('paintableAvatarSrc');
    expect(agentAvatars).toMatch(/import\.meta\.glob\(/);
    expect(agentAvatars).toContain('query: "?url"');
    expect(agentAvatars).toContain('agent-*.{png,svg,jpg,jpeg}');
  });

  it('keeps globbed generated marks small enough for the universal binary', () => {
    // Vite dist is embedded in EACH slice of the macOS universal binary.
    // Uncompressed 512px pack PNGs in v0.10.181 added ~13 MB and failed the
    // 120 MB app-binary budget. Pack images now live on hq-pro; this gate
    // keeps the remaining bundled generated-mark JPEGs from growing the same
    // way.
    const marksRoot = join(
      process.cwd(),
      '../../packages/ui/src/assets/agent-avatars',
    );
    const markBytes = readdirSync(marksRoot)
      .filter((name) => /^agent-.*\.(png|svg|jpe?g)$/i.test(name))
      .reduce((sum, name) => sum + statSync(join(marksRoot, name)).size, 0);
    expect(markBytes).toBeGreaterThan(0);
    expect(markBytes).toBeLessThan(0.75 * 1024 * 1024);
  });

  it('does not join Vite asset URLs onto builtin: and paints marketplace pack thumbs', () => {
    expect(parsePack).toContain('isResolvedPackItemSrc');
    expect(parsePack).toContain('cspSafeAvatarSrc');
    expect(parsePack).toContain('base.startsWith("builtin:")');
    expect(picker).toContain('paintableAvatarSrc');
    expect(picker).toContain('avatar-pack-item-fallback');
    expect(picker).toContain('onerror');
    expect(agentAvatars).toContain('paintableAvatarSrc');
    expect(identityMark).toContain('paintableAvatarSrc');
    expect(sidebarModel).toContain('paintableAvatarSrc');
    expect(cspSrc).toContain('pathname.startsWith("/avatar-packs/")');
    expect(cspSrc).toContain('pathname.startsWith("/agents/")');
    const imageSources = csp.app.security.csp
      .match(/(?:^|;)\s*img-src\s+([^;]+)/i)?.[1]
      ?.trim()
      .split(/\s+/);

    expect(imageSources).toContain("'self'");
    expect(imageSources).toContain('blob:');
    expect(imageSources?.filter((source) => /^https?:/i.test(source))).toEqual([
      MARKETPLACE_COVER_ORIGIN,
    ]);
  });
});
