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
import WidgetSettings from '../../src/components/WidgetSettings.svelte';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const source = (...parts: string[]) =>
  readFileSync(root(...parts), 'utf8').replace(/\r\n/g, '\n');

const widgetSettingsSource = source('src/components/WidgetSettings.svelte');
const settingsPageSource = source('src/desktop-alt/pages/SettingsPage.svelte');
const routeSource = source('src/desktop-alt/route.ts');
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

async function mountWidgetSettings(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(WidgetSettings, { target: host });
  flushSync();
  await settleLoad();
  return host;
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
    it('behavioral: toggle off persists widgetEnabled=false (preserving other keys) then apply_widget_settings; picker unmounts', async () => {
      stubInvoke({
        settings: {
          widgetEnabled: true,
          widgetDisplay: null,
          markerKey: 'preserve-me',
          notifications: true,
        },
        displays: defaultDisplays(),
      });

      await mountWidgetSettings();

      const toggle = toggleButton();
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(displayPicker()).toBeTruthy();

      mockInvoke.mockClear();
      // After clear, re-stub so persist's fresh get_settings still returns the payload.
      stubInvoke({
        settings: {
          widgetEnabled: true,
          widgetDisplay: null,
          markerKey: 'preserve-me',
          notifications: true,
        },
        displays: defaultDisplays(),
      });

      toggle.click();
      flushSync();
      // Optimistic flip before persist settles
      expect(toggleButton().getAttribute('aria-checked')).toBe('false');
      expect(displayPicker()).toBeNull();

      await flushPersist();
      await vi.waitFor(() => {
        expect(mockInvoke.mock.calls.some((c) => c[0] === 'apply_widget_settings')).toBe(true);
      });

      const sequence = mockInvoke.mock.calls.map((c) => c[0] as string);
      // Fresh get_settings, then save_settings, then apply
      expect(sequence).toContain('get_settings');
      expect(sequence).toContain('save_settings');
      expect(sequence).toContain('apply_widget_settings');

      const getIdx = sequence.indexOf('get_settings');
      const saveIdx = sequence.indexOf('save_settings');
      const applyIdx = sequence.indexOf('apply_widget_settings');
      expect(getIdx).toBeGreaterThan(-1);
      expect(saveIdx).toBeGreaterThan(getIdx);
      expect(applyIdx).toBeGreaterThan(saveIdx);

      const saveArgs = callsOf('save_settings')[0] as {
        prefs: Record<string, unknown>;
      };
      expect(saveArgs.prefs.widgetEnabled).toBe(false);
      // Spread from fresh get_settings is preserved (not clobbered)
      expect(saveArgs.prefs.markerKey).toBe('preserve-me');
      expect(saveArgs.prefs.notifications).toBe(true);

      expect(toggleButton().getAttribute('aria-checked')).toBe('false');
      expect(displayPicker()).toBeNull();
    });

    it('behavioral: save_settings rejection reverts optimistic flip and shows inline error', async () => {
      stubInvoke({
        settings: { widgetEnabled: true, widgetDisplay: null },
        displays: defaultDisplays(),
        saveError: 'disk full',
      });

      await mountWidgetSettings();
      expect(toggleButton().getAttribute('aria-checked')).toBe('true');
      expect(host.querySelector('[role="alert"]')).toBeNull();

      mockInvoke.mockClear();
      stubInvoke({
        settings: { widgetEnabled: true, widgetDisplay: null },
        displays: defaultDisplays(),
        saveError: 'disk full',
      });

      toggleButton().click();
      flushSync();
      // Optimistic OFF while save is in flight
      expect(toggleButton().getAttribute('aria-checked')).toBe('false');

      await flushPersist();
      await vi.waitFor(() => {
        expect(toggleButton().getAttribute('aria-checked')).toBe('true');
      });

      // Reverted to ON; picker back; error line visible
      expect(toggleButton().getAttribute('aria-checked')).toBe('true');
      expect(displayPicker()).toBeTruthy();
      const alert = host.querySelector('[role="alert"]');
      expect(alert).toBeTruthy();
      expect(alert!.textContent).toMatch(/disk full/);

      // apply must not run after save failure
      expect(mockInvoke.mock.calls.some((c) => c[0] === 'apply_widget_settings')).toBe(false);
    });

    it('behavioral: apply_widget_settings rejection does NOT revert the toggle; shows error and reloads from disk', async () => {
      // Disk is authoritative after a successful save — apply failure must keep
      // the new value, surface the error, and re-sync via get_settings.
      stubInvoke({
        settings: { widgetEnabled: true, widgetDisplay: null },
        displays: defaultDisplays(),
      });

      await mountWidgetSettings();
      expect(toggleButton().getAttribute('aria-checked')).toBe('true');

      mockInvoke.mockClear();
      // After save succeeds, get_settings (reload) returns the persisted OFF state.
      stubInvoke({
        settings: () => {
          const applyCalls = mockInvoke.mock.calls.filter(
            (c) => c[0] === 'apply_widget_settings',
          ).length;
          // Before apply: still ON for the fresh read-modify-write get.
          // After apply fails and load() runs: disk has OFF.
          if (applyCalls > 0) {
            return { widgetEnabled: false, widgetDisplay: null };
          }
          return { widgetEnabled: true, widgetDisplay: null };
        },
        displays: defaultDisplays(),
        applyError: 'main thread hop failed',
      });

      const getCallsBefore = mockInvoke.mock.calls.filter((c) => c[0] === 'get_settings').length;

      toggleButton().click();
      flushSync();
      expect(toggleButton().getAttribute('aria-checked')).toBe('false');

      await flushPersist();
      await vi.waitFor(() => {
        const alert = host.querySelector('[role="alert"]');
        expect(alert).toBeTruthy();
        expect(alert!.textContent).toMatch(/main thread hop failed/);
      });

      // Toggle stays OFF (not reverted) — disk won
      expect(toggleButton().getAttribute('aria-checked')).toBe('false');
      expect(displayPicker()).toBeNull();

      // save + apply both ran
      expect(mockInvoke.mock.calls.some((c) => c[0] === 'save_settings')).toBe(true);
      expect(mockInvoke.mock.calls.some((c) => c[0] === 'apply_widget_settings')).toBe(true);

      // load() re-sync: get_settings called again after the persist path
      const getCallsAfter = mockInvoke.mock.calls.filter((c) => c[0] === 'get_settings').length;
      expect(getCallsAfter).toBeGreaterThan(getCallsBefore);
      // At least: persist's fresh get + load()'s get
      expect(getCallsAfter).toBeGreaterThanOrEqual(2);
    });

    it('source contract: apply_widget_settings_on_main closes window on disabled path, marks stack not-ready keeping pending; takeover_active reads widget_enabled() fresh', () => {
      // Disabled path closes the window
      expect(widgetRs).toMatch(/fn apply_widget_settings_on_main/);
      const applyFnIdx = widgetRs.indexOf('fn apply_widget_settings_on_main');
      expect(applyFnIdx).toBeGreaterThan(-1);
      const applySlice = widgetRs.slice(applyFnIdx, applyFnIdx + 800);

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

    it('behavioral: selecting display 2 saves widgetDisplay name then apply; Primary (empty) saves null', async () => {
      stubInvoke({
        settings: { widgetEnabled: true, widgetDisplay: null },
        displays: twoDisplays,
      });

      await mountWidgetSettings();

      const picker = displayPicker();
      expect(picker).toBeTruthy();
      const options = Array.from(picker!.querySelectorAll('option')).map((o) => ({
        value: (o as HTMLOptionElement).value,
        text: o.textContent ?? '',
      }));
      expect(options.some((o) => o.value === '')).toBe(true); // Primary
      expect(options.some((o) => o.value === 'DELL U2720Q')).toBe(true);

      mockInvoke.mockClear();
      stubInvoke({
        settings: { widgetEnabled: true, widgetDisplay: null },
        displays: twoDisplays,
      });

      picker!.value = 'DELL U2720Q';
      picker!.dispatchEvent(new Event('change', { bubbles: true }));
      await flushPersist();
      await vi.waitFor(() => {
        expect(mockInvoke.mock.calls.some((c) => c[0] === 'apply_widget_settings')).toBe(true);
      });

      let saveArgs = callsOf('save_settings')[0] as { prefs: Record<string, unknown> };
      expect(saveArgs.prefs.widgetDisplay).toBe('DELL U2720Q');
      const seq = mockInvoke.mock.calls.map((c) => c[0] as string);
      expect(seq.indexOf('apply_widget_settings')).toBeGreaterThan(seq.indexOf('save_settings'));

      // Select Primary (empty string) → null
      mockInvoke.mockClear();
      stubInvoke({
        settings: { widgetEnabled: true, widgetDisplay: 'DELL U2720Q' },
        displays: twoDisplays,
      });

      const picker2 = displayPicker();
      expect(picker2).toBeTruthy();
      picker2!.value = '';
      picker2!.dispatchEvent(new Event('change', { bubbles: true }));
      await flushPersist();
      await vi.waitFor(() => {
        expect(mockInvoke.mock.calls.some((c) => c[0] === 'save_settings')).toBe(true);
      });

      saveArgs = callsOf('save_settings')[0] as { prefs: Record<string, unknown> };
      expect(saveArgs.prefs.widgetDisplay).toBeNull();
      expect(mockInvoke.mock.calls.some((c) => c[0] === 'apply_widget_settings')).toBe(true);
    });

    it('behavioral: stored widgetDisplay absent from list_displays renders a "(disconnected)" option', async () => {
      stubInvoke({
        settings: {
          widgetEnabled: true,
          widgetDisplay: 'Phantom Monitor',
        },
        displays: defaultDisplays(),
      });

      await mountWidgetSettings();

      const picker = displayPicker();
      expect(picker).toBeTruthy();
      const disconnected = Array.from(picker!.querySelectorAll('option')).find((o) =>
        (o.textContent ?? '').includes('(disconnected)'),
      ) as HTMLOptionElement | undefined;
      expect(disconnected).toBeTruthy();
      expect(disconnected!.value).toBe('Phantom Monitor');
      expect(disconnected!.textContent).toMatch(/Phantom Monitor \(disconnected\)/);
    });

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

  // ── 3. Restart preserves prefs ────────────────────────────────────────────

  describe('Given preferences are set, when the app restarts, then widget state and display choice are preserved', () => {
    it('behavioral: get_settings widgetEnabled false renders toggle off (no picker); null/absent defaults ON', async () => {
      stubInvoke({
        settings: { widgetEnabled: false, widgetDisplay: 'DELL U2720Q' },
        displays: [
          { name: 'Built-in Display', primary: true },
          { name: 'DELL U2720Q', primary: false },
        ],
      });

      await mountWidgetSettings();
      expect(toggleButton().getAttribute('aria-checked')).toBe('false');
      // Picker only while enabled
      expect(displayPicker()).toBeNull();

      await unmount(component!);
      component = null;
      host.remove();
      mockInvoke.mockReset();

      // Default-ON when widgetEnabled is null
      stubInvoke({
        settings: { widgetEnabled: null, widgetDisplay: null },
        displays: defaultDisplays(),
      });
      await mountWidgetSettings();
      expect(toggleButton().getAttribute('aria-checked')).toBe('true');
      expect(displayPicker()).toBeTruthy();

      await unmount(component!);
      component = null;
      host.remove();
      mockInvoke.mockReset();

      // Default-ON when key absent entirely
      stubInvoke({
        settings: { widgetDisplay: null },
        displays: defaultDisplays(),
      });
      await mountWidgetSettings();
      expect(toggleButton().getAttribute('aria-checked')).toBe('true');
    });

    it('source contract: widget fields preserve explicit values and use the platform default when absent', () => {
      // Typed fields with skip_serializing_if (merge preservation on unrelated saves)
      expect(configRs).toMatch(/pub widget_enabled:\s*Option<bool>/);
      expect(configRs).toMatch(/pub widget_display:\s*Option<String>/);
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

  // ── 4. Desktop settings surface (popover Settings retired in US-005) ──────

  describe('Settings UI reachable from the desktop SettingsPage (US-005 canonical surface)', () => {
    it('source contract: WidgetSettings mounts ONLY in SettingsPage; route has widget section; WidgetSettings is self-contained', () => {
      // Canonical desktop SettingsPage — section id="widget"
      expect(settingsPageSource).toMatch(
        /import WidgetSettings from ['"]\.\.\/\.\.\/components\/WidgetSettings\.svelte['"]/,
      );
      expect(settingsPageSource).toMatch(/id=["']widget["']/);
      expect(settingsPageSource).toMatch(/<WidgetSettings\s*\/>/);

      // Popover Settings.svelte is gone — no dual-surface mount remains.
      expect(() => readFileSync(root('src/components/Settings.svelte'), 'utf8')).toThrow();

      // route.ts SETTINGS_SECTIONS includes widget row
      expect(routeSource).toMatch(/SETTINGS_SECTIONS/);
      expect(routeSource).toMatch(/\{\s*id:\s*['"]widget['"]\s*,\s*label:\s*['"]Widget['"]\s*\}/);

      // Self-contained: owns load + persist + apply + list_displays
      // load uses typed multiline invoke<...>('get_settings'); persist re-reads fresh
      expect(widgetSettingsSource).toMatch(/['"]get_settings['"]/);
      expect((widgetSettingsSource.match(/['"]get_settings['"]/g) ?? []).length).toBeGreaterThanOrEqual(
        2,
      );
      expect(widgetSettingsSource).toMatch(/['"]save_settings['"]/);
      expect(widgetSettingsSource).toMatch(/['"]apply_widget_settings['"]/);
      expect(widgetSettingsSource).toMatch(/['"]list_displays['"]/);
      expect(widgetSettingsSource).toContain('data-testid="widget-toggle"');
      expect(widgetSettingsSource).toContain('data-testid="widget-display-picker"');
    });
  });
});
