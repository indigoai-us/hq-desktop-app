/**
 * US-106 — Combined-app rollout, bake, rollback, updater budget.
 *
 * Source-contract: flag still defaults false; canonical doc is
 * hq-work-embedded-rollout.md; two-app hq-work-handoff.md is superseded.
 * Do not flip default-on here. Do not invent AFTER updater bytes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());

function readRepo(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), 'utf8');
}

describe('US-106 HQ Work embedded rollout, rollback, updater budget', () => {
  const settings = readRepo('src-tauri/src/commands/settings.rs');
  const config = readRepo('src-tauri/src/commands/config.rs');
  const boot = readRepo('src/desktop-alt/boot.ts');
  const twoApp = readRepo('docs/hq-work-handoff.md');
  const desktopAltDoc = readRepo('docs/desktop-alt.md');
  const docPath = resolve(repoRoot, 'docs/hq-work-embedded-rollout.md');

  it('commits apps/sync/docs/hq-work-embedded-rollout.md', () => {
    expect(existsSync(docPath)).toBe(true);
  });

  describe('flag defaults false', () => {
    it('get_settings no-file branch is Some(false), not Some(true)', () => {
      const idx = settings.indexOf('if !path.exists()');
      expect(idx).toBeGreaterThan(-1);
      const noFile = settings.slice(idx, settings.indexOf('let contents =', idx));
      expect(noFile).toContain('hq_work_handoff: Some(false)');
      expect(noFile).not.toContain('hq_work_handoff: Some(true)');
    });

    it('get_settings present branch unwrap_or(false)', () => {
      expect(settings).toContain(
        'hq_work_handoff: Some(prefs.hq_work_handoff.unwrap_or(false))',
      );
      expect(settings).not.toContain(
        'hq_work_handoff: Some(prefs.hq_work_handoff.unwrap_or(true))',
      );
    });

    it('hq_work_handoff_enabled unwrap_or(false)', () => {
      const idx = config.indexOf('pub fn hq_work_handoff_enabled');
      expect(idx).toBeGreaterThan(-1);
      const body = config.slice(idx, idx + 280);
      expect(body).toContain('.unwrap_or(false)');
      expect(body).not.toContain('.unwrap_or(true)');
    });

    it('get_hq_work_handoff missing file is Ok(false)', () => {
      const idx = config.indexOf('fn get_hq_work_handoff');
      expect(idx).toBeGreaterThan(-1);
      const body = config.slice(
        idx,
        config.indexOf('fn set_hq_work_handoff', idx),
      );
      expect(body).toContain('if !path.exists()');
      expect(body).toContain('return Ok(false)');
    });
  });

  describe('boot rollback is the legacy shell', () => {
    it('flag off maps to legacy / mountLegacy', () => {
      expect(boot).toContain("return (await getHandoff()) === true ? 'hq-work' : 'legacy'");
      expect(boot).toContain("if (shell === 'hq-work')");
      expect(boot).toContain('deps.mountHqWork()');
      expect(boot).toContain('deps.mountLegacy()');
    });
  });

  describe('canonical rollout doc', () => {
    it('documents alpha enable, default-on one-liners, rollback, removal', () => {
      const doc = readRepo('docs/hq-work-embedded-rollout.md');
      expect(doc).toContain('hqWorkHandoff');
      expect(doc).toContain('~/.hq/menubar.json');
      expect(doc).toContain('@getindigo.ai');
      expect(doc).toContain('hq_work_handoff: Some(false)');
      expect(doc).toContain('hq_work_handoff: Some(true)');
      expect(doc).toContain('unwrap_or(false)');
      expect(doc).toContain('unwrap_or(true)');
      expect(doc).toContain('hq_work_handoff_enabled');
      expect(doc).toContain('get_hq_work_handoff');
      expect(doc).toContain('return Ok(false)');
      expect(doc).toContain('Not a live macOS GUI session');
      expect(doc).toContain('no migration');
      expect(doc).toContain('legacy');
      expect(doc).toContain('one Sync release after default-on bake');
    });

    it('records BEFORE updater bytes and withholds fabricated AFTER', () => {
      const doc = readRepo('docs/hq-work-embedded-rollout.md');
      expect(doc).toContain('HQ.app.tar.gz');
      expect(doc).toContain('74110996');
      expect(doc).toContain('70.68');
      expect(doc).toContain('+10 MiB');
      expect(doc).toContain('HqWorkDesktopShell');
      expect(doc).toContain('dynamic import()');
      expect(doc).toMatch(/requires a[\s\S]*release build/);
      expect(doc).toContain('Do not invent an AFTER number');
    });

    it('two-app handoff doc is superseded, not deleted', () => {
      expect(existsSync(resolve(repoRoot, 'docs/hq-work-handoff.md'))).toBe(
        true,
      );
      expect(twoApp.toLowerCase()).toContain('superseded');
      expect(twoApp).toContain('hq-work-embedded-rollout.md');
      expect(desktopAltDoc).toContain('hq-work-embedded-rollout.md');
      expect(desktopAltDoc).toContain('hq-work-handoff.md');
      expect(desktopAltDoc).toContain('default-on bake');
    });
  });
});
