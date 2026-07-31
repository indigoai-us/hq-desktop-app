// @vitest-environment happy-dom
//
// US-003 — Settings reflects the server, and withdrawal takes effect immediately.
//
// The defect: the desktop Settings telemetry toggle was rendered from the local
// `menubar.json` preferences file (via `get_settings`), not from the server. So
// the screen could show "on" while the server held a refusal (and vice versa) —
// a credibility problem, not just a display bug: it is why a server-side backfill
// of declined users was deliberately never run, because the client would then lie
// about the user's own choice.
//
// This story makes the toggle SERVER-AUTHORITATIVE (via a new
// `get_telemetry_consent_status` command), uses the local file only as an offline
// cache that is labelled honestly, shows provenance (when + which consent version),
// and carries `surface: 'settings'` + the consent version on the withdrawal write.
//
// These tests mount the real SettingsPage and drive it through the DOM, mirroring
// the US-001/US-002 story-test idiom and the settings-deep-regressions harness.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
  getVersion: vi.fn(async () => '0.10.35'),
  open: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emit: tauri.emit, listen: tauri.listen }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: tauri.getVersion }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: tauri.open }));

import { flushSync, mount, tick, unmount } from 'svelte';
import SettingsPage from '../../src/desktop-alt/pages/SettingsPage.svelte';
import { TELEMETRY_CONSENT_VERSION } from '../../src/lib/consent-version';

type ConsentStatus = {
  enabled: boolean;
  source: 'server' | 'local-cache';
  updatedAt: string | null;
  consentVersion: number | null;
  unset: boolean;
};

type StubOptions = {
  // Local menubar.json cache value returned by get_settings.telemetryEnabled.
  localTelemetryEnabled?: boolean;
  // How get_telemetry_consent_status behaves.
  consent?: ConsentStatus | (() => Promise<ConsentStatus>) | 'reject';
  // Deferred gate so a test can assert the toggle does not flash before the
  // server answers.
  consentDeferred?: Promise<ConsentStatus>;
  onPostOptIn?: (args: Record<string, unknown> | undefined) => void;
  postOptIn?: 'ok' | 'reject';
};

const defaultSettings = {
  hqPath: '/Users/test/HQ',
  syncOnLaunch: true,
  notifications: true,
  startAtLogin: true,
  realtimeSync: true,
  personalSyncEnabled: true,
  instantSync: true,
  shareNotifications: true,
  dmNotifications: true,
  cliAutoUpdate: true,
  autoUpdate: true,
  stagingChannel: false,
  releaseChannel: null,
  meetingDetectNotify: { enabled: true, platforms: ['zoom', 'meet', 'teams', 'slack', 'webex'] },
  defaultRecordingCompanyUid: null,
  telemetryEnabled: true,
  widgetEnabled: true,
  widgetDisplay: null,
};

const calls: { command: string; args?: Record<string, unknown> }[] = [];

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function flush() {
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await flush();
}

function stubInvoke(options: StubOptions = {}): void {
  let settings = {
    ...defaultSettings,
    telemetryEnabled: options.localTelemetryEnabled ?? defaultSettings.telemetryEnabled,
  };
  tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    switch (command) {
      case 'get_settings':
        return { ...settings };
      case 'meetings_feature_enabled':
      case 'is_indigo_user':
        return true;
      case 'available_channels':
        return ['stable'];
      case 'meetings_list_memberships':
        return [];
      case 'notification_permission_state':
        return 'granted';
      case 'meetings_permissions_state':
        return { allRequiredGranted: true };
      case 'check_pack_update':
      case 'check_core_state':
      case 'check_hq_cli_update':
      case 'get_pending_update':
      case 'get_hq_version':
        return null;
      case 'list_displays':
        return [{ name: 'Built-in Display', primary: true }];
      case 'get_telemetry_consent_status':
        if (options.consentDeferred) return options.consentDeferred;
        if (options.consent === 'reject') throw new Error('no token');
        if (typeof options.consent === 'function') return options.consent();
        return (
          options.consent ?? {
            enabled: true,
            source: 'server',
            updatedAt: null,
            consentVersion: null,
            unset: false,
          }
        );
      case 'write_menubar_telemetry_pref':
        return undefined;
      case 'post_telemetry_opt_in':
        options.onPostOptIn?.(args);
        if (options.postOptIn === 'reject') throw new Error('server error');
        return undefined;
      case 'emit_desktop_telemetry_if_opted_in':
        return undefined;
      case 'save_settings': {
        const prefs = (args?.prefs ?? {}) as Record<string, unknown>;
        settings = { ...settings, ...prefs };
        return undefined;
      }
      default:
        return null;
    }
  });
}

async function mountSettings(): Promise<void> {
  component = mount(SettingsPage, { target: host, props: { activeTab: 'general' } });
  flushSync();
  await settle();
}

function telemetryToggle(): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>('[data-testid="telemetry-toggle"]');
  expect(el, 'telemetry toggle').toBeTruthy();
  return el!;
}

function testid(id: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  calls.length = 0;
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('US-003 — settings reflects the server', () => {
  // ── The headline e2e criterion ──────────────────────────────────────────
  it('renders the toggle OFF when the server records a decline even though the local file says enabled', async () => {
    stubInvoke({
      localTelemetryEnabled: true, // the lie the old code would have shown
      consent: {
        enabled: false, // the truth
        source: 'server',
        updatedAt: '2026-07-27T10:00:00Z',
        consentVersion: 1,
        unset: false,
      },
    });
    await mountSettings();

    // The toggle reflects the SERVER (off), not the local file (on).
    expect(telemetryToggle().checked).toBe(false);
    // And it never fell back to reading the local file as truth.
    const consentReads = calls.filter((c) => c.command === 'get_telemetry_consent_status');
    expect(consentReads.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the toggle ON when the server records consent', async () => {
    stubInvoke({
      localTelemetryEnabled: false,
      consent: { enabled: true, source: 'server', updatedAt: null, consentVersion: null, unset: false },
    });
    await mountSettings();
    expect(telemetryToggle().checked).toBe(true);
  });

  // ── Offline fallback, labelled honestly ─────────────────────────────────
  it('falls back to the cached local value and labels it as offline when the server is unreachable', async () => {
    stubInvoke({
      localTelemetryEnabled: false,
      consent: { enabled: false, source: 'local-cache', updatedAt: null, consentVersion: null, unset: false },
    });
    await mountSettings();

    expect(telemetryToggle().checked).toBe(false);
    // Honest labelling: shown as a last-known/offline value, not current truth.
    expect(testid('telemetry-offline')).toBeTruthy();
    expect(testid('telemetry-offline')?.textContent?.toLowerCase()).toContain('server');
    // No provenance is claimed for an offline value.
    expect(testid('telemetry-answered-at')).toBeNull();
  });

  // ── No flash of the local default before the server answers ─────────────
  it('does not flash the ON default before the server responds', async () => {
    let resolveConsent!: (value: ConsentStatus) => void;
    const consentDeferred = new Promise<ConsentStatus>((resolve) => {
      resolveConsent = resolve;
    });
    stubInvoke({ localTelemetryEnabled: true, consentDeferred });

    component = mount(SettingsPage, { target: host, props: { activeTab: 'general' } });
    flushSync();
    await flush();

    // Server hasn't answered yet: the toggle is in a checking state, disabled,
    // and NOT showing the ON default from the local file.
    expect(telemetryToggle().checked).toBe(false);
    expect(telemetryToggle().disabled).toBe(true);
    expect(testid('telemetry-checking')).toBeTruthy();

    // Server answers OFF — the toggle settles on the server value, never having
    // flashed ON.
    resolveConsent({ enabled: false, source: 'server', updatedAt: null, consentVersion: null, unset: false });
    await settle();
    expect(telemetryToggle().checked).toBe(false);
    expect(telemetryToggle().disabled).toBe(false);
    expect(testid('telemetry-checking')).toBeNull();
  });

  // ── Provenance (AC5) ────────────────────────────────────────────────────
  it('shows when the answer was given and which consent version it was given against', async () => {
    stubInvoke({
      consent: {
        enabled: true,
        source: 'server',
        updatedAt: '2026-07-27T10:00:00Z',
        consentVersion: 1,
        unset: false,
      },
    });
    await mountSettings();

    expect(testid('telemetry-answered-at')?.textContent).toContain('2026');
    expect(testid('telemetry-consent-version')?.textContent).toContain('1');
  });

  it('degrades cleanly when provenance is absent — no "null"/"undefined" leaks', async () => {
    stubInvoke({
      consent: { enabled: true, source: 'server', updatedAt: null, consentVersion: null, unset: false },
    });
    await mountSettings();

    expect(testid('telemetry-answered-at')).toBeNull();
    expect(testid('telemetry-consent-version')).toBeNull();
    const row = testid('telemetry-row');
    expect(row?.textContent).not.toContain('null');
    expect(row?.textContent).not.toContain('undefined');
  });

  // ── Withdrawal write carries surface + consent version ──────────────────
  it('issues the server-side withdrawal write with surface=settings and the consent version', async () => {
    let posted: Record<string, unknown> | undefined;
    stubInvoke({
      consent: { enabled: true, source: 'server', updatedAt: null, consentVersion: null, unset: false },
      onPostOptIn: (args) => {
        posted = args;
      },
    });
    await mountSettings();

    // Turn it off.
    const toggle = telemetryToggle();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(posted).toBeTruthy();
    expect(posted?.enabled).toBe(false);
    expect(posted?.surface).toBe('settings');
    expect(posted?.consentVersion).toBe(TELEMETRY_CONSENT_VERSION);
  });

  // ── AC4: a withdrawal is not overwritten by the client cache/replay path ─
  it('never sends onlyIfUnset on a deliberate withdrawal, so a replay guard cannot resurrect it', async () => {
    // The settings toggle is a DELIBERATE answer. It must always be an
    // unconditional write (no onlyIfUnset), so it wins over any prior state —
    // the "only if never answered" guard is reserved for the self-heal replay,
    // which can therefore never flip a recorded false back to true.
    let posted: Record<string, unknown> | undefined;
    stubInvoke({
      consent: { enabled: true, source: 'server', updatedAt: null, consentVersion: null, unset: false },
      onPostOptIn: (args) => {
        posted = args;
      },
    });
    await mountSettings();

    const toggle = telemetryToggle();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(posted).toBeTruthy();
    // A deliberate answer never carries the conditional guard.
    expect(posted?.onlyIfUnset).toBeUndefined();
    expect(posted?.enabled).toBe(false);
  });

  // ── finding #6: a withdrawal must not emit another telemetry event ──────
  it('does NOT emit a telemetry_preference_changed event on a withdrawal', async () => {
    // The old code emitted telemetry_preference_changed(false) BEFORE the
    // withdrawal write — while the server still reported "enabled" — producing
    // one more telemetry event AFTER the user had asked to stop. A withdrawal
    // must halt emission immediately, so no such event may fire.
    stubInvoke({
      consent: { enabled: true, source: 'server', updatedAt: null, consentVersion: null, unset: false },
    });
    await mountSettings();

    const toggle = telemetryToggle();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    const emits = calls.filter((c) => c.command === 'emit_desktop_telemetry_if_opted_in');
    expect(emits).toHaveLength(0);
  });

  it('still records telemetry_preference_changed on an OPT-IN, after the server confirms it', async () => {
    // Opting IN is a change worth recording, and by then collection is (about to
    // be) on — so a single audit event after the confirmed write is correct.
    let phase: 'before' | 'after' = 'before';
    stubInvoke({
      consent: async () =>
        phase === 'before'
          ? { enabled: false, source: 'server', updatedAt: null, consentVersion: null, unset: false }
          : { enabled: true, source: 'server', updatedAt: '2026-07-28T09:00:00Z', consentVersion: 1, unset: false },
      onPostOptIn: () => {
        phase = 'after';
      },
    });
    await mountSettings();
    expect(telemetryToggle().checked).toBe(false);

    const toggle = telemetryToggle();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    const emits = calls.filter((c) => c.command === 'emit_desktop_telemetry_if_opted_in');
    expect(emits.length).toBeGreaterThanOrEqual(1);
  });

  it('re-reads the server after a successful withdrawal so the displayed value stays authoritative', async () => {
    // After the write succeeds, the screen re-reads the server rather than
    // trusting the optimistic toggle — so it can never drift from truth.
    let phase: 'before' | 'after' = 'before';
    stubInvoke({
      consent: async () =>
        phase === 'before'
          ? { enabled: true, source: 'server', updatedAt: null, consentVersion: null, unset: false }
          : {
              enabled: false,
              source: 'server',
              updatedAt: '2026-07-28T09:00:00Z',
              consentVersion: 1,
              unset: false,
            },
      onPostOptIn: () => {
        phase = 'after';
      },
    });
    await mountSettings();
    expect(telemetryToggle().checked).toBe(true);

    const toggle = telemetryToggle();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    // The post-write re-read reflects the server's now-declined state and its
    // provenance.
    expect(telemetryToggle().checked).toBe(false);
    expect(testid('telemetry-answered-at')?.textContent).toContain('2026');
  });
});
