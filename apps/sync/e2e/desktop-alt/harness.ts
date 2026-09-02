import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { expect } from 'vitest';

export type MaybePromise<T> = T | Promise<T>;

export interface RenderedPage {
  route: string;
  text: string[];
  consoleErrors: string[];
}

export interface DesktopAltWindowState {
  id: number | string;
  focused: boolean;
  created: boolean;
}

export interface DesktopAltSnapshot {
  popoverAlive: boolean;
  trayAlive: boolean;
  desktopAltWindow: { id: number | string; focused: boolean } | null;
}

export interface DesktopAltTestHarness {
  readonly mode: 'live' | 'scripted';
  /**
   * Boot the app and report whether the desktop-alt window is reachable for
   * this user — i.e. what the `desktop_alt_enabled` gate answers.
   *
   * Named for the gate rather than for a UI control on purpose: the popover's
   * `data-testid="desktop-alt-toggle"` launcher was deleted in 3114f6a6, and
   * `assertGateSourceContracts` below asserts it stays gone, so there is no
   * toggle for any harness to look at. The live harness asks the running
   * backend; the scripted harness mirrors the same Rust gate.
   */
  bootApp(): MaybePromise<{ desktopAltEnabled: boolean }>;
  /**
   * Open (or focus) the desktop-alt window the only way the app itself can:
   * `invoke('open_desktop_alt_window')` — what App.svelte, the
   * NotificationFeed deep-links and the tray item all call.
   */
  openDesktopAltWindow(): MaybePromise<DesktopAltWindowState>;
  closeDesktopAltWindow(): MaybePromise<void>;
  snapshot(): MaybePromise<DesktopAltSnapshot>;
  navigate(route: 'sync' | 'meetings' | 'company'): MaybePromise<RenderedPage>;
  dispose?(): MaybePromise<void>;
}

export interface SecretItem {
  key: string;
  upd: string;
  rot: string;
}

export interface SecretEnv {
  env: string;
  count: number;
  items: SecretItem[];
}

const repoRoot = process.cwd();
let reportedDriverMode = false;

export function reportDriverMode(reason?: string): void {
  if (reportedDriverMode) return;
  reportedDriverMode = true;

  const fallbackReason =
    reason ??
    (commandOnPath('tauri-driver')
      ? 'live mode was not configured with HQ_SYNC_DESKTOP_ALT_APP or HQ_SYNC_DESKTOP_ALT_APP_PATH'
      : 'tauri-driver was not found on PATH');
  console.log(`[desktop-alt-e2e] fallback scripted harness active: ${fallbackReason}.`);
}

export function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
}

export function assertNoRecursiveSecretFields(payload: unknown): void {
  const forbiddenPath = findForbiddenSecretField(payload);
  expect(forbiddenPath).toBeNull();
}

export function findForbiddenSecretField(payload: unknown, path = '$'): string | null {
  if (!payload || typeof payload !== 'object') return null;

  if (Array.isArray(payload)) {
    for (let index = 0; index < payload.length; index += 1) {
      const nested = findForbiddenSecretField(payload[index], `${path}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'value' || key === 'secret') {
      return `${path}.${key}`;
    }
    const nested = findForbiddenSecretField(value, `${path}.${key}`);
    if (nested) return nested;
  }

  return null;
}

export function sanitizeSecretsResponse(raw: unknown): SecretEnv[] {
  const rows = secretRows(raw);
  const grouped = new Map<string, SecretItem[]>();

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const rawKey = firstString(record, [
      'key',
      'name',
      'path',
      'secretPath',
      'secretName',
      'parameterName',
    ]);
    if (!rawKey) continue;

    const env =
      firstString(record, ['env', 'environment', 'stage', 'scope']) ??
      inferEnvFromKey(rawKey) ??
      'default';
    const key = rawKey.includes('/') ? rawKey.split('/').filter(Boolean).at(-1) ?? rawKey : rawKey;
    const items = grouped.get(env) ?? [];
    items.push({
      key,
      upd: firstString(record, ['upd', 'updatedAt', 'updated_at', 'lastUpdated']) ?? '-',
      rot: firstString(record, ['rot', 'rotation', 'rotatedAt', 'lastRotated']) ?? '-',
    });
    grouped.set(env, items);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([env, items]) => {
      const sortedItems = [...items].sort((a, b) => a.key.localeCompare(b.key));
      return { env, count: sortedItems.length, items: sortedItems };
    });
}

export class DesktopAltHarness implements DesktopAltTestHarness {
  private email: string;
  private nextWindowId = 1;
  private desktopAltWindow: { id: number; focused: boolean } | null = null;
  readonly mode = 'scripted';
  readonly popover = { alive: true };
  readonly tray = { alive: true };
  readonly consoleErrors: string[] = [];

  constructor(email: string) {
    this.email = email;
  }

  bootApp(): { desktopAltEnabled: boolean } {
    reportDriverMode();
    this.assertGateSourceContracts();
    return { desktopAltEnabled: this.isDesktopAltEnabled() };
  }

  openDesktopAltWindow(): DesktopAltWindowState {
    this.assertWindowLifecycleSourceContracts();

    if (!this.isDesktopAltEnabled()) {
      throw new Error('desktop-alt requires a signed-in user');
    }

    if (this.desktopAltWindow) {
      this.desktopAltWindow.focused = true;
      return { ...this.desktopAltWindow, created: false };
    }

    this.desktopAltWindow = { id: this.nextWindowId, focused: true };
    this.nextWindowId += 1;
    return { ...this.desktopAltWindow, created: true };
  }

  closeDesktopAltWindow(): void {
    this.desktopAltWindow = null;
  }

  snapshot(): DesktopAltSnapshot {
    return {
      popoverAlive: this.popover.alive,
      trayAlive: this.tray.alive,
      desktopAltWindow: this.desktopAltWindow ? { ...this.desktopAltWindow } : null,
    };
  }

  navigate(route: 'sync' | 'meetings' | 'company'): RenderedPage {
    this.assertDesktopAppRouteContracts();

    if (route === 'sync') {
      // The legacy 'sync' route resolves to Home (US-002); the V4 Home surface
      // superseded SyncPage in US-003.
      return {
        route,
        text: sourceText('src/desktop-alt/pages/HomePage.svelte', [
          'aria-label="Home"',
          '<ActivityDigest',
        ]),
        consoleErrors: [...this.consoleErrors],
      };
    }

    if (route === 'meetings') {
      return {
        route,
        text: sourceText('src/desktop-alt/pages/MeetingsPage.svelte', [
          'aria-label="Meetings"',
          '<h1>Meetings</h1>',
          'Connected calendars',
        ]),
        consoleErrors: [...this.consoleErrors],
      };
    }

    return {
      route,
      text: sourceText('src/desktop-alt/pages/CompanyPage.svelte', [
        'aria-labelledby="company-page-title"',
        'New project',
        '<CompanyBoardPanel',
      ]),
      consoleErrors: [...this.consoleErrors],
    };
  }

  interceptGetCompanySecrets(raw: unknown): SecretEnv[] {
    this.assertSecretsSourceContracts();
    return sanitizeSecretsResponse(raw);
  }

  private isDesktopAltEnabled(): boolean {
    // GA mirror of the Rust gate (`feature_gate::email_present`): the
    // expanded desktop window graduated from the Indigo dogfood, so it's
    // visible for ANY signed-in user (non-empty email) and hidden only when
    // signed out.
    return this.email.trim().length > 0;
  }

  private assertGateSourceContracts(): void {
    const app = readRepoFile('src/App.svelte');
    const popover = readRepoFile('src/components/Popover.svelte');
    const feed = readRepoFile('src/components/NotificationFeed.svelte');
    const rust = readRepoFile('src-tauri/src/commands/desktop_alt.rs');
    const main = readRepoFile('src-tauri/src/main.rs');

    // Rust-side gate stays; menubar popover is chrome-free (US-001). The
    // desktop-view launcher surface moves into the desktop app in US-005 —
    // until then open paths remain tray + NotificationFeed deep-links.
    expect(rust).toContain('pub async fn desktop_alt_enabled()');
    expect(rust).toContain('crate::util::feature_gate::desktop_features_enabled().await');
    expect(main).toContain('commands::desktop_alt::desktop_alt_enabled');
    expect(app).toContain("invoke('open_desktop_alt_window')");
    expect(popover).not.toContain('data-testid="desktop-alt-toggle"');
    expect(popover).not.toContain('{#if desktopAltEnabled}');
    expect(feed).toContain("invoke('open_desktop_alt_window'");
  }

  private assertWindowLifecycleSourceContracts(): void {
    const rust = readRepoFile('src-tauri/src/commands/desktop_alt.rs');
    const main = readRepoFile('src-tauri/src/main.rs');
    const tauriConfig = readRepoFile('src-tauri/tauri.conf.json');

    expect(rust).toContain('const WINDOW_LABEL: &str = "desktop-alt"');
    expect(rust).toContain('app.get_webview_window(WINDOW_LABEL)');
    expect(rust).toContain('window.show()');
    expect(rust).toContain('window.set_focus()');
    expect(rust).toContain('tauri::WebviewWindowBuilder::new');
    expect(main).toContain('if window.label() == "main"');
    expect(tauriConfig).toContain('"label": "desktop-alt"');
    expect(tauriConfig).toContain('"create": false');
    expect(tauriConfig).toContain('"visible": false');
  }

  private assertDesktopAppRouteContracts(): void {
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    const route = readRepoFile('src/desktop-alt/route.ts');

    // US-007 IA: the desktop lands on the last-visited company (persisted),
    // falling back to the first sidebar company row; the legacy 'sync'
    // pending-route alias stays functional by resolving to Home.
    expect(route).toContain('export function getDesktopLandingRoute(');
    expect(route).toContain("case 'sync':");
    expect(desktopApp).toContain("route.kind === 'home'");
    expect(desktopApp).toContain("route.kind === 'meetings'");
    expect(desktopApp).toContain('<CompanyPage');
    expect(desktopApp).toContain('company={activeCompany}');
    expect(desktopApp).toContain('tab={companyTab}');
  }

  private assertSecretsSourceContracts(): void {
    const rust = readRepoFile('src-tauri/src/commands/desktop_alt.rs');
    const core = readRepoFile('../../crates/hq-desktop-core/src/desktop_alt.rs');
    const panel = readRepoFile('src/desktop-alt/panels/SecretsPanel.svelte');

    // The command wrapper returns ONLY the metadata-only projection type — never
    // a value-bearing shape. The type itself is defined + tested in the shared
    // core library (the command binary depends on it, so it lives there).
    expect(rust).toContain('pub async fn get_company_secrets(');
    expect(rust).toContain('Result<Vec<SecretEnv>, String>');
    expect(core).toContain('pub struct SecretItem');
    const secretItemStruct = core.match(/pub struct SecretItem\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(secretItemStruct).toContain('pub key: String');
    expect(secretItemStruct).toContain('pub upd: String');
    expect(secretItemStruct).toContain('pub rot: String');
    expect(secretItemStruct).not.toMatch(/pub (value|secret):|serde\(flatten\)/);
    expect(panel).toContain('companyStore.loadSecrets(slug');
    expect(panel).toContain('key: stringOrFallback(item.key');
    expect(panel).toContain('upd: stringOrFallback(item.upd');
    expect(panel).toContain('rot: stringOrFallback(item.rot');
  }
}

const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Candidate on-disk file names for a bare command name.
 *
 * On Windows an executable is almost never stored under its bare name —
 * `cargo install tauri-driver` produces `tauri-driver.exe` — so a bare
 * `existsSync` probe never matches and every caller silently concludes the tool
 * is missing. Mirror the shell and expand the command with PATHEXT.
 */
export function executableCandidates(
  command: string,
  platform: NodeJS.Platform = process.platform,
  pathExt: string | undefined = process.env.PATHEXT,
): string[] {
  if (platform !== 'win32') return [command];

  // PATHEXT is always ';'-separated (it is a Windows-only variable), so this
  // must not use path.delimiter — that would follow the *host* platform.
  const extensions = (pathExt ?? DEFAULT_WINDOWS_PATHEXT)
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`));

  // An explicitly-suffixed command (`tauri-driver.exe`) is already a file name.
  if (extensions.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()))) {
    return [command];
  }

  // PATHEXT is conventionally upper-case (`.EXE`) while installed binaries are
  // lower-case (`tauri-driver.exe`). NTFS does not care, but `existsSync` on a
  // case-sensitive filesystem does — so probe both spellings.
  const candidates = new Set<string>([command]);
  for (const extension of extensions) {
    candidates.add(`${command}${extension}`);
    candidates.add(`${command}${extension.toLowerCase()}`);
    candidates.add(`${command}${extension.toUpperCase()}`);
  }

  return [...candidates];
}

export function commandOnPath(command: string): boolean {
  const paths = process.env.PATH?.split(delimiter) ?? [];
  const candidates = executableCandidates(command);

  return paths.some((dir) => {
    // Windows PATH entries are frequently quoted; `join` would keep the quote.
    const directory = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) return false;
    return candidates.some((candidate) => existsSync(join(directory, candidate)));
  });
}

function sourceText(path: string, markers: string[]): string[] {
  const source = readRepoFile(path);
  for (const marker of markers) {
    expect(source).toContain(marker);
  }
  return markers.map((marker) =>
    marker
      .replace(/aria-label="([^"]+)"/, '$1')
      .replace(/<\/?h1>/g, '')
      .replace(/[<>"{}]/g, ''),
  );
}

function secretRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  for (const key of ['secrets', 'items']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  for (const key of ['body', 'data']) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const rows = secretRows(nested);
      if (rows.length > 0) return rows;
    }
  }
  return [];
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function inferEnvFromKey(key: string): string | null {
  const [first] = key.split('/').filter(Boolean);
  return first && /^[a-z][a-z0-9_-]*$/i.test(first) ? first : null;
}
