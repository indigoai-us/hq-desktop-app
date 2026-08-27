/**
 * US-006 — Rollout, bake, and rollback verification.
 *
 * Source-contract: flag still defaults false; QA can grep `[handoff]` for
 * detected / launched / card_shown / co_installed / failed. Do not flip
 * default-on here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());

function readRepo(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), 'utf8');
}

describe('US-006 HQ Work handoff rollout defaults, logs, rollback', () => {
  const hq = readRepo('src-tauri/src/commands/hq_work.rs');
  const config = readRepo('src-tauri/src/commands/config.rs');
  const settings = readRepo('src-tauri/src/commands/settings.rs');
  const coreConfig = readRepo('../../crates/hq-desktop-core/src/config.rs');
  const coreSettings = readRepo('../../crates/hq-desktop-core/src/settings.rs');
  const frontend = readRepo('src/lib/hq-work.ts');
  const doc = readRepo('docs/hq-work-handoff.md');
  const desktopAltDoc = readRepo('docs/desktop-alt.md');
  const logfile = readRepo('../../crates/hq-desktop-core/src/logfile.rs');

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
      const idx = config.indexOf('pub fn get_hq_work_handoff');
      expect(idx).toBeGreaterThan(-1);
      const body = config.slice(idx, config.indexOf('pub fn set_hq_work_handoff', idx));
      expect(body).toContain('if !path.exists()');
      expect(body).toContain('return Ok(false)');
    });

    it('MenubarPrefs and core apply_defaults stay default-off', () => {
      expect(coreConfig).toContain('pub hq_work_handoff: Option<bool>');
      expect(coreConfig).toContain('Absent → false');
      expect(coreSettings).toContain(
        'hq_work_handoff: Some(prefs.hq_work_handoff.unwrap_or(false))',
      );
      expect(coreSettings).toContain('test_hq_work_handoff_defaults_false');
      expect(frontend).toContain('return flag === true');
    });
  });

  describe('handoff log category and events', () => {
    it('logs through category "handoff" so QA can grep [handoff]', () => {
      expect(hq).toContain('fn handoff_log(msg: &str)');
      expect(hq).toContain('log("handoff", msg)');
      expect(logfile).toContain('{} [{}] {}');
      expect(logfile).toContain('~/.hq/logs/hq-sync.log');
    });

    it('emits distinct detected/launched/card_shown/co_installed/failed lines', () => {
      expect(hq).toContain('handoff.detected installed=');
      expect(hq).toContain('handoff.launched');
      expect(hq).toContain('handoff.card_shown first=');
      expect(hq).toContain('handoff.co_installed');
      expect(hq).toContain('handoff.failed');
    });
  });

  describe('rollout docs', () => {
    it('documents alpha enable, default-on one-liners, rollback, removal', () => {
      expect(doc).toContain('hqWorkHandoff');
      expect(doc).toContain('~/.hq/menubar.json');
      expect(doc).toContain('@getindigo.ai');
      expect(doc).toContain('hq_work_handoff: Some(false)');
      expect(doc).toContain('hq_work_handoff: Some(true)');
      expect(doc).toContain('unwrap_or(false)');
      expect(doc).toContain('unwrap_or(true)');
      expect(doc).toContain('hq_work_handoff_enabled');
      expect(doc).toContain('grep \'\\[handoff\\]\' ~/.hq/logs/hq-sync.log');
      expect(doc).toContain('flag_off_opens_desktop_alt_regardless_of_install');
      expect(doc).toContain('plan_desktop_alt_open(false');
      expect(doc).toContain('OpenDesktopAlt');
      expect(doc).toContain('one Sync release after default-on bake');
      expect(doc).toContain('Not a live macOS GUI session');
      expect(doc).toContain('no migration');
    });

    it('desktop-alt.md points at the handoff doc and keeps the window', () => {
      expect(desktopAltDoc).toContain('hq-work-handoff.md');
      expect(desktopAltDoc).toContain('one');
      expect(desktopAltDoc).toContain('default-on bake');
    });
  });

  describe('rollback proof stays in source', () => {
    it('flag_off_opens_desktop_alt_regardless_of_install is OpenDesktopAlt', () => {
      expect(hq).toContain('fn flag_off_opens_desktop_alt_regardless_of_install');
      const idx = hq.indexOf('fn flag_off_opens_desktop_alt_regardless_of_install');
      const body = hq.slice(idx, idx + 900);
      expect(body).toContain('plan_desktop_alt_open_with_route(false, true');
      expect(body).toContain('DesktopAltHandoffPlan::OpenDesktopAlt');
      expect(body).toContain('plan_desktop_alt_open_with_route(false, false');
    });
  });
});
