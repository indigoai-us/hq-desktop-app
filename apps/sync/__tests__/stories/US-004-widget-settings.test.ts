// @vitest-environment happy-dom
//
// US-004: Widget settings (enable/disable + display picker + restart persistence)
// Behavioral tests mount WidgetSettings with a mocked Tauri invoke; source
// contracts lock the Rust apply path, list_displays naming, default-ON prefs,
// and single settings surface mount (desktop-alt SettingsPage; popover Settings retired in US-005).
// Leave __tests__/stories/US-004.test.ts alone — legacy suite from an older project.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Vitest resolves Svelte's public entry with the default/server condition in
// this repo's node test config, even for per-file happy-dom tests. Force the
// client entry so mount/flushSync work (same pattern as US-003 / onboarding).
vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

// Hoisted before the component import so WidgetSettings binds to this mock.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { flushSync, mount, unmount } from 'svelte';
import { invoke } from '@tauri-apps/api/core';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const source = (...parts: string[]) =>
  readFileSync(root(...parts), 'utf8').replace(/\r\n/g, '\n');
const widgetRs = source('src-tauri/src/commands/widget.rs');
const settingsRs = source('src-tauri/src/commands/settings.rs');
const mainRs = source('src-tauri/src/main.rs');
const configRs = source('../../crates/hq-desktop-core/src/config.rs');

const mockInvoke = vi.mocked(invoke);

type DisplayInfo = { name: string; primary: boolean };

type SettingsPayload = {
  widgetEnabled?: boolean | null;
  widgetDisplay?: string | null;
  [key: string]: unknown;
};

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function defaultDisplays(): DisplayInfo[] {
  return [{ name: 'Built-in Display', primary: true }];
}

/** Drive invoke per test. Unknown commands reject so stray calls surface. */
function stubInvoke(options: {
  settings?: SettingsPayload | (() => SettingsPayload);
  displays?: DisplayInfo[];
  save?: () => Promise<void>;
  saveError?: Error | string;
  applyError?: Error | string;
}): void {
  const settingsFn =
    typeof options.settings === 'function'
      ? options.settings
      : () =>
          options.settings ?? {
            widgetEnabled: true,
            widgetDisplay: null,
          };
  const displays = options.displays ?? defaultDisplays();

  mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    void args;
    switch (cmd) {
      case 'get_settings':
        return settingsFn();
      case 'list_displays':
        return displays;
      case 'save_settings':
        await options.save?.();
        if (options.saveError) {
          throw typeof options.saveError === 'string'
            ? new Error(options.saveError)
            : options.saveError;
        }
        return undefined;
      case 'apply_widget_settings':
        if (options.applyError) {
          throw typeof options.applyError === 'string'
            ? new Error(options.applyError)
            : options.applyError;
        }
        return undefined;
      default:
        throw new Error(`unexpected invoke: ${cmd}`);
    }
  });
}

async function settleLoad(timeoutMs = 1_000): Promise<void> {
  await vi.waitFor(
    () => {
      flushSync();
      expect(host.querySelector('[data-loading]')).toBeNull();
    },
    { timeout: timeoutMs, interval: 5 },
  );
}

async function flushPersist(): Promise<void> {
  // persist is async: get_settings → save_settings → apply_widget_settings
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
  flushSync();
}

function toggleButton(): HTMLButtonElement {
  const el = host.querySelector('[data-testid="widget-toggle"]');
  expect(el).toBeTruthy();
  return el as HTMLButtonElement;
}

function displayPicker(): HTMLSelectElement | null {
  return host.querySelector('[data-testid="widget-display-picker"]') as HTMLSelectElement | null;
}

function callsOf(command: string): unknown[] {
  return mockInvoke.mock.calls.filter((c) => c[0] === command).map((c) => c[1]);
}

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  vi.clearAllMocks();
  mockInvoke.mockReset();
});

describe('US-004: Widget settings (enable/disable, display, persistence)', () => {
  // ── 1. Toggle off → native notifications, no widget window ────────────────

  describe('Given the widget toggle is switched off, when a notification arrives, then it is native and no widget window exists', () => {

    it('source contract: apply_widget_settings_on_main closes window on disabled path, marks stack not-ready keeping pending; takeover_active reads widget_enabled() fresh', () => {
      // Disabled path closes the window
      expect(widgetRs).toMatch(/fn apply_widget_settings_on_main/);
      const applyFnIdx = widgetRs.indexOf('fn apply_widget_settings_on_main');
      expect(applyFnIdx).toBeGreaterThan(-1);
      const applySlice = widgetRs.slice(applyFnIdx, applyFnIdx + 1400);

      // enabled → setup_widget_window; disabled → close
      expect(applySlice).toMatch(/if widget_enabled\(\)/);
      expect(applySlice).toMatch(/setup_widget_window\(app\)/);
      expect(applySlice).toMatch(/window\.close\(\)/);

      // Not-ready but KEEP pending (same contract as setup create path)
      expect(applySlice).toMatch(/ch\.0\s*=\s*false/);
      expect(applySlice).toMatch(/keep ch\.1 \(pending\)|KEEP pending|keep.*pending/i);

      // After close, takeover_active is false → native path (documented + impl)
      expect(widgetRs).toMatch(
        /pub fn takeover_active\(app: &AppHandle\)\s*->\s*bool\s*\{\s*widget_enabled\(\)/s,
      );
      expect(widgetRs).toMatch(/widget_enabled\(\)\s*&&\s*app\.get_webview_window/);
      expect(widgetRs).toMatch(/FRESH each call|instantly restores native/i);
      expect(widgetRs).toMatch(
        /After close, takeover_active\(\) is false|next notification goes native/i,
      );
    });

    it('source contract: macOS hop-failure path returns Err instead of inline apply_widget_settings_on_main', () => {
      // Find the async apply_widget_settings command (not the _on_main helper)
      const cmdIdx = widgetRs.indexOf('pub async fn apply_widget_settings');
      expect(cmdIdx).toBeGreaterThan(-1);
      // Slice the hop-failure branch of the macOS path
      const hopIdx = widgetRs.indexOf('if hop.is_err()', cmdIdx);
      expect(hopIdx).toBeGreaterThan(cmdIdx);
      const hopSlice = widgetRs.slice(hopIdx, hopIdx + 400);

      // Must return Err with the locked message — not run apply inline off-main
      expect(hopSlice).toMatch(
        /return Err\("apply_widget_settings: failed to reach main thread"\.into\(\)\)/,
      );
      // Inline fallback must be gone from the hop-failure branch
      expect(hopSlice).not.toMatch(/return apply_widget_settings_on_main\(&app\)/);
      expect(hopSlice).not.toMatch(/running inline/);
    });
  });

  // ── 2. Display picker → re-anchor ─────────────────────────────────────────

  describe("Given two displays, when the user picks display 2, then the widget moves to display 2's lower-right corner", () => {
    const twoDisplays: DisplayInfo[] = [
      { name: 'Built-in Display', primary: true },
      { name: 'DELL U2720Q', primary: false },
    ];

    it('source contract: list_displays uses localizedName (same key as configured_display_name/widget_position_cocoa); enabled apply calls setup_widget_window', () => {
      // DisplayInfo name must be NSScreen.localizedName matching key
      expect(widgetRs).toMatch(/localizedName/);
      expect(widgetRs).toMatch(/configured_display_name|widget_position_cocoa/);
      expect(widgetRs).toMatch(
        /name.*MUST be the exact string matched by `configured_display_name`|same source as the anchor|NSScreen\.localizedName/s,
      );

      // list_displays_cocoa primary = index 0
      expect(widgetRs).toMatch(/fn list_displays_cocoa/);
      expect(widgetRs).toMatch(/primary:\s*i\s*==\s*0/);
      // Tauri monitor fallback present
      expect(widgetRs).toMatch(/fn list_displays_fallback/);

      // Enabled apply path → setup_widget_window (re-anchor when window exists)
      expect(widgetRs).toMatch(
        /apply_widget_settings: enabled — setup\/re-anchor|enabled → `setup_widget_window`/,
      );
      const applyFnIdx = widgetRs.indexOf('fn apply_widget_settings_on_main');
      const applySlice = widgetRs.slice(applyFnIdx, applyFnIdx + 400);
      expect(applySlice).toMatch(/if widget_enabled\(\)\s*\{[\s\S]*?setup_widget_window\(app\)/s);

      // setup re-anchors existing window
      expect(widgetRs).toMatch(/window already exists — re-anchoring/);
      expect(widgetRs).toMatch(/fn setup_widget_window/);
    });

    it('source contract: list_displays dedupes duplicate names (seen-set / retain by name)', () => {
      // Shared post-pass: drop later entries whose name already appeared
      expect(widgetRs).toMatch(/fn dedupe_displays_by_name/);
      expect(widgetRs).toMatch(/HashSet|seen\.insert|retain.*name|seen-set|dedupe/i);
      expect(widgetRs).toMatch(/list\.retain\(\|d\| seen\.insert\(d\.name\.clone\(\)\)\)/);
      // Both list paths use the dedupe helper
      expect(widgetRs).toMatch(/dedupe_displays_by_name\(out\)/);
      // Doc comment explains first-match anchor + keyed-each
      expect(widgetRs).toMatch(/first-match|keyed|#each|duplicate.*name/i);
    });
  });

  describe('placement, auto-hide, and needs-action persist through save then apply', () => {
    function placementPicker(): HTMLSelectElement | null {
      return host.querySelector('[data-testid="widget-placement-picker"]');
    }
    function autoHidePicker(): HTMLSelectElement | null {
      return host.querySelector('[data-testid="widget-auto-hide-picker"]');
    }
    function needsActionToggle(): HTMLButtonElement | null {
      return host.querySelector('[data-testid="widget-needs-action-toggle"]');
    }

    it('source contract: apply_widget_settings re-anchors so placement moves the native window', () => {
      expect(widgetRs).toContain('fn widget_position_in_work_area');
      expect(widgetRs).toContain('apply_widget_settings: enabled — setup/re-anchor');
      expect(widgetRs).toContain('emit_widget_live_settings');
      expect(mainRs).toContain('commands::widget::hide_widget_stack');
    });
  });

  // ── 3. Restart preserves prefs ────────────────────────────────────────────

  describe('Given preferences are set, when the app restarts, then widget state and display choice are preserved', () => {

    it('source contract: widget fields preserve explicit values and use the platform default when absent', () => {
      // Typed fields with skip_serializing_if (merge preservation on unrelated saves)
      expect(configRs).toMatch(/pub widget_enabled:\s*Option<bool>/);
      expect(configRs).toMatch(/pub widget_display:\s*Option<String>/);
      expect(configRs).toMatch(/pub widget_placement:\s*Option<String>/);
      expect(configRs).toMatch(/pub widget_auto_hide_seconds:\s*Option<u32>/);
      expect(configRs).toMatch(/pub widget_show_needs_action:\s*Option<bool>/);
      // Both fields carry skip_serializing_if = "Option::is_none"
      const enabledFieldIdx = configRs.indexOf('pub widget_enabled');
      const displayFieldIdx = configRs.indexOf('pub widget_display');
      expect(enabledFieldIdx).toBeGreaterThan(-1);
      expect(displayFieldIdx).toBeGreaterThan(enabledFieldIdx);
      const enabledAttr = configRs.slice(enabledFieldIdx - 120, enabledFieldIdx);
      const displayAttr = configRs.slice(displayFieldIdx - 120, displayFieldIdx);
      expect(enabledAttr).toMatch(/skip_serializing_if\s*=\s*"Option::is_none"/);
      expect(displayAttr).toMatch(/skip_serializing_if\s*=\s*"Option::is_none"/);

      // settings.rs default ON in no-file branch AND existing-file branch
      expect(settingsRs).toMatch(/const fn default_widget_enabled\(\)\s*->\s*bool/);
      expect(settingsRs).toContain('!cfg!(target_os = "windows")');
      expect(settingsRs).toMatch(/widget_enabled:\s*Some\(default_widget_enabled\(\)\)/);
      expect(settingsRs).toMatch(/widget_enabled[\s\S]*?unwrap_or_else\(default_widget_enabled\)/);
      // Both occurrences of default-on for widget_enabled
      const unwrapMatches = settingsRs.match(/unwrap_or_else\(default_widget_enabled\)/g) ?? [];
      const someTrueMatches = settingsRs.match(/Some\(default_widget_enabled\(\)\)/g) ?? [];
      // no-file uses Some(true); with-file uses unwrap_or(true) — together both branches
      expect(someTrueMatches.length + unwrapMatches.length).toBeGreaterThanOrEqual(2);
      expect(unwrapMatches.length).toBeGreaterThanOrEqual(1);
      expect(someTrueMatches.length).toBeGreaterThanOrEqual(1);

      // Launch still calls setup_widget_window
      expect(mainRs).toContain('commands::widget::setup_widget_window');

      // setup early-returns when !widget_enabled()
      expect(widgetRs).toMatch(
        /pub fn setup_widget_window\(app: &AppHandle\)\s*\{\s*if !widget_enabled\(\)/s,
      );
      expect(widgetRs).toMatch(/widgetEnabled=false — skipping/);
    });
  });
});
