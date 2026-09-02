import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-contract regression guard for the desktop-alt window declaration in
// src-tauri/tauri.conf.json. The scripted E2E harness mocks window behaviour and
// never boots a real Tauri app, so an invalid tauri.conf.json (e.g. a bad
// `titleBarStyle` enum casing) passes every other gate but fails `tauri dev` at
// launch. Regression for: `titleBarStyle: "overlay"` (must be PascalCase
// "Overlay") which broke the cold dev build after US-002.

const confPath = fileURLToPath(new URL('../../src-tauri/tauri.conf.json', import.meta.url));
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const desktopCommandSource = readFileSync(
  fileURLToPath(new URL('../../src-tauri/src/commands/desktop_alt.rs', import.meta.url)),
  'utf8',
);
const mainRsSource = readFileSync(
  fileURLToPath(new URL('../../src-tauri/src/main.rs', import.meta.url)),
  'utf8',
);
const externalLinksRs = readFileSync(
  fileURLToPath(new URL('../../src-tauri/src/util/external_links.rs', import.meta.url)),
  'utf8',
);
const glassSource = readFileSync(
  fileURLToPath(new URL('../../src-tauri/src/glass.rs', import.meta.url)),
  'utf8',
);

// Valid values for the macOS title bar style in Tauri 2's tauri.conf.json schema.
const VALID_TITLE_BAR_STYLES = ['Visible', 'Transparent', 'Overlay'];

describe('tauri.conf.json desktop-alt window declaration', () => {
  const windows = conf.app?.windows ?? [];
  const desktopAlt = windows.find((w: { label?: string }) => w.label === 'desktop-alt');

  it('declares the desktop-alt window', () => {
    expect(desktopAlt, 'desktop-alt window must exist in tauri.conf.json').toBeDefined();
  });

  it('uses a schema-valid titleBarStyle for every window (PascalCase enum)', () => {
    for (const w of windows) {
      if (w.titleBarStyle !== undefined) {
        expect(
          VALID_TITLE_BAR_STYLES,
          `window "${w.label ?? '(main)'}" has invalid titleBarStyle "${w.titleBarStyle}" — Tauri 2 requires one of ${VALID_TITLE_BAR_STYLES.join(', ')}`,
        ).toContain(w.titleBarStyle);
      }
    }
  });

  it('keeps the desktop-alt window hidden + lazily created (popover stays default)', () => {
    expect(desktopAlt.visible).toBe(false);
    expect(desktopAlt.create).toBe(false);
  });

  it('keeps the desktop-alt window decorated at the expected size', () => {
    expect(desktopAlt.decorations).toBe(true);
    expect(desktopAlt.width).toBe(1180);
    expect(desktopAlt.height).toBe(760);
  });

  it('keeps both declared and lazily built desktop windows transparent over native material', () => {
    expect(desktopAlt.transparent).toBe(true);
    expect(desktopAlt.titleBarStyle).toBe('Overlay');
    expect(desktopCommandSource).toContain('.transparent(true)');
    expect(desktopCommandSource).toContain(
      '.title_bar_style(tauri::TitleBarStyle::Overlay)',
    );
  });

  it('centres the overlay traffic lights on the titlebar content centre line', () => {
    expect(desktopAlt.hiddenTitle).toBe(true);
    expect(desktopAlt.trafficLightPosition).toEqual({ x: 20, y: 24 });
    expect(desktopCommandSource).toContain('.hidden_title(true)');
    expect(desktopCommandSource).toContain(
      '.traffic_light_position(tauri::LogicalPosition::new',
    );
    expect(desktopCommandSource).toContain(
      'crate::titlebar_layout::traffic_light_position',
    );
  });

  it('enforces a packaged image CSP that cannot auto-load remote tracking images', () => {
    const csp = conf.app?.security?.csp;

    expect(typeof csp).toBe('string');
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain('data:');
    expect(csp).toContain('asset:');
    expect(csp).not.toMatch(/img-src[^;]*https?:/i);
    expect(csp).not.toMatch(/img-src[^;]*\*/i);
  });

  it('routes target=_blank and in-webview navigations to the OS browser', () => {
    expect(desktopCommandSource).toContain('deny_webview_new_windows');
    expect(mainRsSource).toContain('Builder::<tauri::Wry, ()>::new("external-links")');
    expect(mainRsSource).toContain('.on_navigation(|webview, url|');
    expect(externalLinksRs).toContain('.on_new_window');
    expect(externalLinksRs).toContain('is_browser_url');
    expect(externalLinksRs).toContain('mailto');
    expect(externalLinksRs).toContain('NewWindowResponse::Deny');
  });

  it('applies AppKit Liquid Glass on the main thread with an older-macOS vibrancy fallback', () => {
    expect(desktopCommandSource).toContain('dispatcher.run_on_main_thread(move ||');
    expect(desktopCommandSource).toContain('crate::glass::apply_liquid_glass_window(&window)');
    expect(glassSource).toContain('AnyClass::get(c"NSGlassEffectView")');
    expect(glassSource).toContain('GlassWindowRole::LargeWindow => 0');
    expect(glassSource).toContain('GlassWindowRole::CompactCommunications => 0');
    expect(glassSource).toContain('setStyle: style');
    expect(glassSource).toContain('NSVisualEffectMaterial::UnderWindowBackground');
    expect(desktopCommandSource).toContain('setUnderPageBackgroundColor: clear');
    expect(desktopCommandSource).toContain('desktop_alt_ns_string("backgroundColor")');
    expect(glassSource).toContain('Some(NSVisualEffectState::Active)');
  });

  it('reveals the cold macOS window only after its first native glass paint', () => {
    expect(desktopCommandSource).toContain('.visible(false)');
    expect(desktopCommandSource).toContain('tauri::webview::PageLoadEvent::Finished');
    expect(desktopCommandSource).toContain('AtomicBool::new(false)');
    expect(desktopCommandSource).toContain(
      'first_page_finished.swap(true, Ordering::AcqRel)',
    );
    expect(glassSource).toContain('pub fn refresh_liquid_glass_window');
    expect(glassSource).toContain('setNeedsLayout: true');
    expect(glassSource).toContain('layoutSubtreeIfNeeded');
    expect(glassSource).toContain('setNeedsDisplay: true');
    expect(glassSource).toContain('displayIfNeeded');

    const coldLifecycleSource = desktopCommandSource.slice(
      desktopCommandSource.indexOf('let first_page_finished'),
    );
    const lifecycle = [
      'crate::glass::apply_liquid_glass_window(&window)',
      'crate::glass::refresh_liquid_glass_window(&window)',
      'window.show()',
      'window.set_focus()',
    ].map((step) => coldLifecycleSource.indexOf(step));

    expect(lifecycle.every((index) => index >= 0)).toBe(true);
    expect(lifecycle).toEqual([...lifecycle].sort((a, b) => a - b));
    expect(
      desktopCommandSource.match(
        /crate::glass::apply_liquid_glass_window\(&window\)/g,
      ),
    ).toHaveLength(1);
  });
});
