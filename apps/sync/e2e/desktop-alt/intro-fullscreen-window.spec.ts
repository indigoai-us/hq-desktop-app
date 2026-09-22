// The welcome film must cover the ENTIRE display it plays on, and the person's
// real desktop must blur underneath it.
//
// Reported on v0.10.291: "the welcome intro is messed up. i want it to be FULL
// SCREEN. it should fade / blur over their entire desktop." What shipped sized
// the window to the monitor's WORK AREA — so the menu bar and the Dock stayed
// on top of the film, and the film arrived as a window rather than as a fade.
//
// Source contract over the one window path both entry points use (first run and
// "Replay welcome intro"), so a later change cannot quietly put the film back
// inside a card.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const introWindowRs = read('src-tauri/src/intro_window.rs');
const sharedIntroRs = read('../../crates/hq-platform/src/intro_window.rs');
const previewRs = read('../intro/src-tauri/src/main.rs');
const mainRs = read('src-tauri/src/main.rs');
const desktopAltRs = read('src-tauri/src/commands/desktop_alt.rs');
const windowEffects = read('../../crates/hq-platform/src/window_effects.rs');
const onboarding = read('src/components/Onboarding.svelte');
const introWindowTs = read('src/lib/intro-window.ts');
const cinematicIntro = read('src/components/onboarding/CinematicIntro.svelte');

describe('welcome intro: full screen over a blurred desktop', () => {
  it('takes the display frame, never the work area', () => {
    // `Monitor::position`/`Monitor::size` are the display's FULL bounds. The
    // work area is the band that stops at the menu bar — the exact band the
    // film has to cover.
    expect(introWindowRs).toContain('fn resolve_fullscreen_frame');
    expect(introWindowRs).toContain('m.position()');
    expect(introWindowRs).toContain('m.size()');
    expect(introWindowRs).not.toContain('m.work_area()');
    expect(sharedIntroRs).toContain('pub fn intro_frame_from_screen');
    // The old behaviour: an absurd size clamped down to the work area.
    expect(onboarding).not.toContain('INTRO_SIZE');
    expect(onboarding).not.toContain('100_000');
  });

  it('paints above the menu bar and drops back to a normal level', () => {
    expect(sharedIntroRs).toContain('pub const INTRO_WINDOW_LEVEL: i64 = 25;');
    expect(sharedIntroRs).toContain('pub const MAIN_MENU_WINDOW_LEVEL: i64 = 24;');
    expect(introWindowRs).toContain('set_window_level(ns_window, INTRO_WINDOW_LEVEL)');
    expect(introWindowRs).toContain('set_window_level(ns_window, NORMAL_WINDOW_LEVEL)');
  });

  it('drops every piece of window chrome for the duration', () => {
    expect(introWindowRs).toContain('set_decorations(false)');
    expect(introWindowRs).toContain('set_shadow(false)');
    // ...and the film itself stops being a rounded, draggable card.
    expect(cinematicIntro).toContain('border-radius: 0;');
    expect(cinematicIntro).not.toContain('data-tauri-drag-region');
  });

  it('blurs the real desktop with the native full-screen material', () => {
    expect(windowEffects).toContain('pub fn apply_fullscreen_vibrancy');
    expect(windowEffects).toContain('NSVisualEffectMaterial::FullScreenUI');
    // Square corners on the material too, or the corners show raw desktop.
    const start = windowEffects.indexOf('pub fn apply_fullscreen_vibrancy');
    const body = windowEffects.slice(start, start + 900);
    expect(body).toContain('Some(0.0)');
    expect(introWindowRs).toContain('apply_fullscreen_vibrancy(&handle)');
  });

  it('arrives and leaves as a fade, not as a window appearing', () => {
    // Invisible BEFORE the frame jump, so the move is never on screen.
    const enter = introWindowRs.indexOf('set_window_alpha(ns_window, 0.0)');
    expect(enter).toBeGreaterThan(-1);
    expect(enter).toBeLessThan(introWindowRs.indexOf('set_window_level(ns_window, INTRO_WINDOW_LEVEL)'));
    expect(introWindowRs).toContain('animate_window_alpha(ns_window, 1.0, fade)');
    expect(introWindowRs).toContain('animate_window_alpha(ns_window_ptr(&handle), 0.0, fade)');
    expect(sharedIntroRs).toContain('fn ease_out_timing_function');
    // The renderer owns the timing model.
    expect(introWindowTs).toContain('export const INTRO_FADE_IN_MS = 700;');
    expect(introWindowTs).toContain('export const INTRO_FADE_OUT_MS = 450;');
  });

  it('is reachable from both entry points and restores the window after', () => {
    expect(mainRs).toContain('intro_window::set_intro_fullscreen');
    // First run and replay both mount Onboarding, and both come through the
    // one enter/exit pair.
    expect(onboarding).toContain('enterIntroFullscreen');
    expect(onboarding).toContain('exitIntroFullscreen');
    // The screen goes back before the setup card is sized onto the window.
    expect(onboarding).toContain('void exitIntroWindow().then(() => sizeForOnboarding(ONBOARDING_SIZE))');
    expect(onboarding).toContain('void exitIntroWindow().then(() => restorePopoverSize())');
    // The restore is a copy of the saved frame, not a fresh computation.
    expect(introWindowRs).toContain('SAVED_STATE');
    expect(introWindowRs).toContain('saved.decorated');
  });

  it('exempts the film from the work-area frame clamp', () => {
    expect(desktopAltRs).toContain('intro_window::should_recover_frame');
    expect(desktopAltRs).toContain('intro_window::intro_fullscreen_active');
    const start = desktopAltRs.indexOf('pub fn enforce_desktop_alt_frame');
    const body = desktopAltRs.slice(start, start + 2600);
    // The exemption has to come BEFORE any clamping work.
    expect(body.indexOf('should_recover_frame')).toBeLessThan(body.indexOf('resolve_desktop_frame('));
  });

  it('gives the preview app the same window path it ships', () => {
    // The preview under apps/intro is how this gets reviewed without quitting
    // the shipped app, so it has to be the same window, not a lookalike.
    expect(previewRs).toContain('hq_platform::intro_window::');
    expect(previewRs).toContain('intro_frame_from_screen');
    expect(previewRs).toContain('set_window_level(ns_window, INTRO_WINDOW_LEVEL)');
    expect(previewRs).toContain('apply_fullscreen_vibrancy');
    expect(previewRs).toContain('animate_window_alpha(ns_window, 1.0, FADE_IN_MS)');
    expect(previewRs).not.toContain('work_area()');
  });

  it('keeps Escape, Skip and the chord scene as they were', () => {
    expect(cinematicIntro).toContain("if (event.key === 'Escape')");
    expect(cinematicIntro).toContain('Skip intro');
    // The boundary fallback still drops to the wizard with the card restored.
    expect(onboarding).toContain('svelte:boundary onerror={handleIntroError}');
  });
});
