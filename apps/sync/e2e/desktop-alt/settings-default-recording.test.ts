// @vitest-environment happy-dom
//
// Regression — "Default recording" company must not render BLANK.
//
// US-005: mounts the canonical desktop SettingsPage (popover Settings.svelte
// retired). Boots `src/desktop-alt/pages/SettingsPage.svelte` into a live DOM
// and asserts on the rendered default-recording-company `<select>` — no
// source-contract stub, no bypass of the component.
//
// The bug (originally in classic Settings; SettingsPage already coerced):
// the select used `value={defaultRecordingCompanyUid}`, a RAW value that is
// `null` for the common "Personal" case. Svelte compiles a one-way select
// `value` to `select.__value = value; select_option(select, value)`. With a raw
// `null`, `select.__value` becomes `null` — which NO <option> carries (Personal
// is `value=""`) — so `select_option` finds no match and sets
// `selectedIndex = -1`. In WKWebView that renders a BLANK control instead of
// "Personal". The fix coerces `null → ''` (`value={defaultRecordingCompanyUid ?? ''}`)
// so it matches the Personal <option>.
//
// Why assert `select.__value` rather than `selectedIndex`/visible text:
// happy-dom normalizes a single-select's `selectedIndex` back to 0 after render,
// masking the `-1`/blank state that a real WebKit/Chromium engine shows. The
// raw value Svelte assigns — `select.__value` — is the faithful,
// engine-independent signal: `null` is the broken (no-matching-option) state;
// `''` is the fixed state that matches the Personal option. The first test below
// pins the underlying `select_option` semantics directly so the contract is
// explicit; the mount tests then assert the component hands the select a value
// that always corresponds to a real option.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { select_option } from 'svelte/internal/client';
import { invoke } from '@tauri-apps/api/core';

// ── Root-cause contract: how Svelte's select value matching behaves ──────────

describe('select_option matching — the mechanism behind the blank control', () => {
  it('a raw null value matches no option and deselects (-1); coercing to "" matches Personal', () => {
    function buildSelect(): HTMLSelectElement {
      const sel = document.createElement('select');
      const personal = document.createElement('option');
      personal.value = ''; // the Personal option carries value=""
      personal.textContent = 'Personal';
      const acme = document.createElement('option');
      (acme as unknown as { __value: string }).__value = 'co_acme';
      acme.value = 'co_acme';
      acme.textContent = 'Acme Corp';
      sel.append(personal, acme);
      document.body.append(sel);
      return sel;
    }

    // BROKEN path — what `value={defaultRecordingCompanyUid}` (raw null) compiles to.
    const broken = buildSelect();
    select_option(broken, null);
    expect(broken.selectedIndex).toBe(-1); // nothing selected → blank in WebKit

    // FIXED path — what `value={defaultRecordingCompanyUid ?? ''}` compiles to.
    const fixed = buildSelect();
    select_option(fixed, '');
    expect(fixed.selectedIndex).toBe(0); // matches the Personal <option>
    expect(fixed.options[fixed.selectedIndex]?.textContent?.trim()).toBe('Personal');
  });
});

// ── Tauri / module bridge mocks ─────────────────────────────────────────────
//
// Mutable refs the per-test setup populates so each case controls exactly what
// SettingsPage sees on its single boot.

type SettingsResponse = {
  hqPath: string | null;
  defaultRecordingCompanyUid?: string | null;
  [k: string]: unknown;
};
type Membership = {
  companyUid: string;
  companyName: string | null;
  role: string | null;
  status: string;
};

let settingsResponse: SettingsResponse = { hqPath: '/Users/dev/hq' };
let membershipsResponse: Membership[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    switch (command) {
      case 'get_settings':
        return settingsResponse;
      case 'meetings_list_memberships':
        return membershipsResponse;
      case 'get_autostart_enabled':
        return false;
      case 'meetings_feature_enabled':
        return true;
      case 'is_indigo_user':
        return false;
      case 'available_channels':
        return ['stable'];
      case 'notification_permission_state':
        return 'granted';
      case 'list_displays':
        return [];
      // Update surfaces hydrate on mount (fire-and-forget); return benign nulls.
      // check_for_updates is user-initiated only — must NOT be called on load.
      case 'check_hq_cli_update':
        return null;
      case 'check_pack_update':
        return null;
      case 'get_hq_version':
        return null;
      case 'check_core_state':
        return null;
      case 'save_settings':
        return undefined;
      default:
        return undefined;
    }
  }),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.0.0-test'),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(async () => {}),
}));

// permissionState is a `$state` rune object in the real module; the template
// only reads `permissionState.meetingPermissions` (null → "not granted" branch),
// so a plain object plus a no-op loader is enough to render the Meetings group.
vi.mock('../../src/lib/permissionState.svelte', () => ({
  permissionState: { meetingDetectEligible: true, meetingPermissions: null },
  loadMeetingPermissions: vi.fn(async () => null),
  loadMeetingDetectEligible: vi.fn(async () => true),
}));

// ── Harness ─────────────────────────────────────────────────────────────────

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

const mockInvoke = vi.mocked(invoke);

/**
 * Mount the REAL SettingsPage and let its async loadSettings / update surfaces
 * settle, flushing reactive updates into the DOM between ticks. Resolves once
 * the default-recording select has rendered, or after a bounded number of ticks.
 */
async function mountSettingsPage(): Promise<HTMLElement> {
  const { default: SettingsPage } = await import(
    '../../src/desktop-alt/pages/SettingsPage.svelte'
  );
  component = mount(SettingsPage, { target: host });
  flushSync();
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    if (host.querySelector('select[aria-label="Default recording company"]')) break;
  }
  return host;
}

function recordingSelect(dom: HTMLElement): HTMLSelectElement {
  const el = dom.querySelector<HTMLSelectElement>(
    'select[aria-label="Default recording company"]',
  );
  if (!el) throw new Error('recording select did not render');
  return el;
}

/** The raw value Svelte assigned to the select — the engine-independent signal. */
function svelteValue(select: HTMLSelectElement): unknown {
  return (select as unknown as { __value: unknown }).__value;
}

beforeEach(() => {
  settingsResponse = { hqPath: '/Users/dev/hq' };
  membershipsResponse = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  mockInvoke.mockClear();
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  vi.clearAllMocks();
});

describe('SettingsPage — Default recording company display', () => {
  it('hands the select a value that matches the Personal option when no company default is stored', async () => {
    // Never picked a company → null on disk. This is the common case and the
    // one that rendered BLANK before the fix.
    settingsResponse = {
      hqPath: '/Users/dev/hq',
      defaultRecordingCompanyUid: null,
    };
    membershipsResponse = [
      { companyUid: 'co_acme', companyName: 'Acme Corp', role: 'member', status: 'active' },
    ];

    const dom = await mountSettingsPage();
    const select = recordingSelect(dom);

    // REGRESSION GUARD: the value must be the empty string (matches the Personal
    // <option>), never a raw `null` (which matches nothing → blank in WebKit).
    expect(svelteValue(select)).toBe('');
    expect(svelteValue(select)).not.toBeNull();

    // Memberships render as options (Acme) alongside Personal.
    const optionTexts = Array.from(select.options).map((o) => o.textContent?.trim());
    expect(optionTexts).toContain('Personal');
    expect(optionTexts).toContain('Acme Corp');

    // check_for_updates is user-initiated only — never on load.
    expect(mockInvoke.mock.calls.some((c) => c[0] === 'check_for_updates')).toBe(false);
  });

  it('shows the stored company default when a valid company is selected', async () => {
    // On-disk: the user previously chose Acme. Server: that membership is
    // active, so it is a valid default.
    settingsResponse = {
      hqPath: '/Users/dev/hq',
      defaultRecordingCompanyUid: 'co_acme',
    };
    membershipsResponse = [
      { companyUid: 'co_acme', companyName: 'Acme Corp', role: 'member', status: 'active' },
    ];

    const dom = await mountSettingsPage();
    const select = recordingSelect(dom);

    expect(svelteValue(select)).toBe('co_acme');
    expect(select.value).toBe('co_acme');
    expect(select.options[select.selectedIndex]?.textContent?.trim()).toBe('Acme Corp');
  });

  it('falls back to the Personal option when the stored default is a stale company', async () => {
    // Stored a company UID that is NOT in the active membership list (access
    // revoked / company left). The component resolves it to null/Personal — and
    // critically must hand the select `''` (matches Personal), not a raw `null`.
    settingsResponse = {
      hqPath: '/Users/dev/hq',
      defaultRecordingCompanyUid: 'co_gone',
    };
    membershipsResponse = [
      { companyUid: 'co_acme', companyName: 'Acme Corp', role: 'member', status: 'active' },
    ];

    const dom = await mountSettingsPage();
    const select = recordingSelect(dom);

    expect(svelteValue(select)).toBe('');
    expect(svelteValue(select)).not.toBeNull();
  });

  it('persists a membership pick via save_settings', async () => {
    settingsResponse = {
      hqPath: '/Users/dev/hq',
      defaultRecordingCompanyUid: null,
    };
    membershipsResponse = [
      { companyUid: 'co_acme', companyName: 'Acme Corp', role: 'member', status: 'active' },
    ];

    const dom = await mountSettingsPage();
    const select = recordingSelect(dom);

    mockInvoke.mockClear();
    select.value = 'co_acme';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
    flushSync();

    await vi.waitFor(() => {
      expect(mockInvoke.mock.calls.some((c) => c[0] === 'save_settings')).toBe(true);
    });

    const saveCall = mockInvoke.mock.calls.find((c) => c[0] === 'save_settings');
    expect(saveCall).toBeTruthy();
    const args = saveCall![1] as { prefs: Record<string, unknown> };
    expect(args.prefs.defaultRecordingCompanyUid).toBe('co_acme');
  });
});
