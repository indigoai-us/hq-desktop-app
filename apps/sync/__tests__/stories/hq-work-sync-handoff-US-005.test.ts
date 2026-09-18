/**
 * US-005 — Sync: reroute every desktop-alt open path to HQ Work.
 *
 * Source-contract: one Rust seam (`plan_desktop_alt_open` /
 * `maybe_intercept_desktop_alt_handoff`) picks HQ Work, the US-003 card, or
 * desktop-alt. Svelte call sites still invoke the same Tauri commands.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());

function readRepo(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), 'utf8');
}

describe('US-005 reroute desktop-alt opens to HQ Work', () => {
  const hq = readRepo('src-tauri/src/commands/hq_work.rs');
  const desktop = readRepo('src-tauri/src/commands/desktop_alt.rs');
  const dm = readRepo('src-tauri/src/commands/dm_notify.rs');
  const messages = readRepo('src-tauri/src/commands/messages.rs');
  const app = readRepo('src/App.svelte');

  describe('one seam', () => {
    it('adds LaunchHqWork to DesktopAltHandoffPlan', () => {
      expect(hq).toContain('enum DesktopAltHandoffPlan');
      expect(hq).toContain('OpenDesktopAlt');
      expect(hq).toContain('ShowHandoffCard');
      expect(hq).toContain('LaunchHqWork { url: Option<String> }');
    });

    it('open_desktop_alt_window_inner still intercepts through maybe_intercept', () => {
      const idx = desktop.indexOf('pub async fn open_desktop_alt_window_inner');
      expect(idx).toBeGreaterThan(-1);
      const body = desktop.slice(idx, idx + 2800);
      expect(body).toMatch(
        /if crate::commands::hq_work::maybe_intercept_desktop_alt_handoff\(&app,\s*route\)\?/,
      );
      expect(body).toContain('return Ok(())');
      const interceptAt = body.indexOf('maybe_intercept_desktop_alt_handoff');
      const hideAt = body.indexOf('get_webview_window("main")');
      expect(interceptAt).toBeGreaterThan(-1);
      expect(hideAt).toBeGreaterThan(interceptAt);
    });

    it('the plan seam still maps a Launch outcome to the launcher', () => {
      // PL-05 deleted `apply_handoff_plan` (the dead two-app launcher that
      // showed / hid the popover). The decision seam itself is live and is
      // covered by the Rust unit test `intercept_with_launch_three_outcomes`.
      expect(hq).toContain('pub fn intercept_with_launch');
      expect(hq).toContain('HandoffInterceptAction::Launched');
      expect(hq).toContain('launch_hq_work');
      expect(hq).toContain('intercept_with_launch_three_outcomes');
      // The popover show/hide helpers the launcher used are gone.
      expect(hq).not.toContain('fn hide_compact_popover');
      expect(hq).not.toContain('fn reveal_handoff_card');
    });

    it('the plan seam still maps a missing install to the US-003 card', () => {
      expect(hq).toContain('should_intercept_desktop_alt');
      expect(hq).toContain('handoff_enabled && !installed');
      expect(hq).toContain('HandoffInterceptAction::ShowHandoffCard');
      // US-103: the live intercept is a permanent no-op, so nothing reaches
      // the card in this build.
      expect(hq).toContain('pub fn intercept_steals_desktop_alt_window');
    });

    it('flag off restores desktop-alt regardless of install', () => {
      expect(hq).toContain('DesktopAltHandoffPlan::OpenDesktopAlt');
      expect(hq).toMatch(
        /fn plan_desktop_alt_open[\s\S]*else if handoff_enabled && installed[\s\S]*LaunchHqWork[\s\S]*else \{[\s\S]*OpenDesktopAlt/,
      );
      expect(hq).toContain('flag_off_opens_desktop_alt_regardless_of_install');
      const inner = desktop.slice(
        desktop.indexOf('pub async fn open_desktop_alt_window_inner'),
        desktop.indexOf('pub async fn open_desktop_alt_window_inner') + 3500,
      );
      expect(inner).toContain('WINDOW_LABEL');
      expect(inner).toContain('desktop-alt.html');
    });

    it('launch failure while installed is Err, not a silent no-op', () => {
      expect(hq).toContain('handoff.failed');
      expect(hq).toMatch(
        /LaunchHqWork[\s\S]*Err\(err\)[\s\S]*if !installed[\s\S]*ShowHandoffCard[\s\S]*Err\(err\)/,
      );
    });
  });

  describe('URL builder', () => {
    it('builds hqwork://open channel/person/reply URLs and reuses US-002 validation', () => {
      expect(hq).toContain('pub fn build_hqwork_open_url');
      expect(hq).toContain('hqwork://open?channel=');
      expect(hq).toContain('hqwork://open?person=');
      expect(hq).toContain('&reply=');
      expect(hq).toContain('validate_hqwork_deep_link');
      expect(hq).toContain('fn hqwork_query_token');
    });

    it('maps desktop-alt routes without inventing HQ Work destinations', () => {
      expect(hq).toContain('pub fn hqwork_url_for_desktop_alt_route');
      expect(hq).toContain('inbox');
      expect(hq).toContain('messages');
      expect(hq).toContain('meetings');
      expect(hq).toContain('company:');
    });

    it('keeps settings:updates on desktop-alt as the only exception', () => {
      expect(hq).toContain('pub fn desktop_alt_route_bypasses_hq_work');
      expect(hq).toContain('settings:updates');
      expect(hq).toContain('intentional exception');
      expect(hq).toContain('updater ticket UI');
    });
  });

  describe('channel and DM intercept', () => {
    it('open_communications_window intercepts to hqwork://open?channel=', () => {
      const idx = dm.indexOf('pub async fn open_communications_window');
      const body = dm.slice(idx, dm.indexOf('pub async fn open_dm_detail'));
      expect(body).toContain('maybe_intercept_conversation_open');
      expect(body).toContain('channel.as_ref().map(|c| c.channel_id.as_str())');
      expect(hq).toContain('maybe_intercept_conversation_open');
      expect(hq).toContain('HqWorkConversation::Channel');
    });

    it('open_dm_detail intercepts to hqwork://open?person=', () => {
      const idx = dm.indexOf('pub async fn open_dm_detail');
      const body = dm.slice(idx, idx + 900);
      expect(body).toContain('maybe_intercept_dm_open');
      expect(body).toContain('from_person_uid');
      expect(hq).toContain('HqWorkConversation::Person');
    });

    it('open_messages_window intercepts person targets through the same seam', () => {
      const idx = messages.indexOf('pub async fn open_messages_window');
      const body = messages.slice(idx, idx + 1200);
      expect(body).toContain('maybe_intercept_dm_open');
      expect(body).toContain('person_uid');
    });
  });

  describe('call sites stay on existing Tauri commands', () => {
    it('Svelte still invokes open_desktop_alt_window / dm_detail', () => {
      // PL-07 deleted Popover.svelte and NotificationFeed.svelte, which held
      // the other call sites (`open_desktop_alt_window` with a route, and
      // `open_communications_window`). The commands themselves stay — the
      // Rust seam assertions above are what guard them.
      expect(app).toContain("invoke('open_desktop_alt_window')");
      expect(app).toContain("invoke('open_dm_detail'");
    });

    it('retains desktop-alt window code for flag-off rollback', () => {
      expect(desktop).toContain('const WINDOW_LABEL: &str = "desktop-alt"');
      expect(desktop).toContain('desktop-alt.html');
      expect(desktop).toContain('pub async fn open_desktop_alt_window_inner');
      expect(desktop).toContain('WebviewWindowBuilder::new');
    });
  });
});
