/**
 * Windows reliability integration harness (US-001).
 *
 * Provides deterministic fixtures and content-safe diagnostics for tray
 * activation, child processes, meetings, workspaces, and Core Drift.
 *
 * Modes:
 * - **scripted** (default): always available on every OS — simulates launch and
 *   diagnostics so macOS CI keeps full desktop-alt coverage without a Windows
 *   app binary.
 * - **live** (Windows only): when `HQ_SYNC_WINDOWS_RELIABILITY_LIVE=1` and
 *   `HQ_SYNC_DESKTOP_ALT_APP` / `HQ_SYNC_DESKTOP_ALT_APP_PATH` point at a built
 *   executable, the harness can be extended to observe a real process tree.
 *   Live observation is opt-in; missing configuration falls back to scripted.
 *
 * Content-safety: diagnostics never include vault file contents, tokens, or
 * command arguments that may carry secrets. Only counts, enums, and role labels.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChildProcessState = 'stopped' | 'starting' | 'running' | 'backoff';

export type ChildProcessRole = 'watch-daemon' | 'ai-probe' | 'sync-runner';

export interface FixtureChildProcess {
  /** Opaque id — never a real path or command line. */
  id: string;
  role: ChildProcessRole;
  state: ChildProcessState;
  /** Whether a console window would be visible (CREATE_NO_WINDOW inverted). */
  visibleConsole: boolean;
}

export interface FixtureMeeting {
  id: string;
  title: string;
  botState: 'available' | 'invited' | 'joining' | 'recording' | 'completed';
  /** Synthetic meeting URL used for identity tests — not read from vault. */
  url: string;
}

export interface FixtureWorkspace {
  slug: string;
  enabled: boolean;
  kind: 'company' | 'personal';
}

export interface FixtureCoreDrift {
  available: boolean;
  modifiedCount: number;
  baselineStatus: 'ok' | 'unavailable';
}

export interface WindowsReliabilityFixtures {
  tray: { activated: boolean; leftClickCount: number };
  childProcesses: FixtureChildProcess[];
  meetings: FixtureMeeting[];
  workspaces: FixtureWorkspace[];
  coreDrift: FixtureCoreDrift;
}

/** Content-safe observation snapshot — never secrets, vault bodies, or argv. */
export interface ContentSafeDiagnostics {
  windowCount: number;
  visibleConsoleProcessCount: number;
  childProcessStates: Array<{
    id: string;
    role: ChildProcessRole;
    state: ChildProcessState;
    visibleConsole: boolean;
  }>;
  backendRequestCounts: Record<string, number>;
  trayActivated: boolean;
  trayLeftClickCount: number;
  meetingCount: number;
  workspaceCount: number;
  coreDriftBaselineStatus: FixtureCoreDrift['baselineStatus'];
  coreDriftModifiedCount: number;
  platform: NodeJS.Platform;
  mode: 'scripted' | 'live';
}

export interface LaunchResult {
  launched: boolean;
  mode: 'scripted' | 'live';
  platform: NodeJS.Platform;
  /** True when live was requested but configuration forced scripted fallback. */
  liveFallback: boolean;
  fallbackReason?: string;
}

// Keys / string patterns that must never appear in diagnostics payloads.
const SENSITIVE_KEY_PATTERN =
  /^(value|secret|token|accessToken|refreshToken|password|authorization|cookie|argv|args|commandLine|command_line|vaultContent|fileContents?|plaintext)$/i;

const SENSITIVE_VALUE_PATTERN =
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*|sk-[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\./;

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

export function createDeterministicWindowsFixtures(): WindowsReliabilityFixtures {
  return {
    tray: { activated: false, leftClickCount: 0 },
    childProcesses: [
      {
        id: 'child-watch-1',
        role: 'watch-daemon',
        state: 'running',
        visibleConsole: false,
      },
      {
        id: 'child-probe-1',
        role: 'ai-probe',
        state: 'stopped',
        visibleConsole: false,
      },
      {
        id: 'child-runner-1',
        role: 'sync-runner',
        state: 'running',
        visibleConsole: false,
      },
    ],
    meetings: [
      {
        id: 'mtg-1',
        title: 'Standup',
        botState: 'available',
        url: 'https://meet.example.test/j/deterministic-standup',
      },
      {
        id: 'mtg-2',
        title: 'Design review',
        botState: 'invited',
        url: 'https://zoom.example.test/j/deterministic-design',
      },
    ],
    workspaces: [
      { slug: 'personal', enabled: true, kind: 'personal' },
      { slug: 'indigo', enabled: true, kind: 'company' },
      { slug: 'liverecover', enabled: false, kind: 'company' },
    ],
    coreDrift: {
      available: true,
      modifiedCount: 0,
      baselineStatus: 'ok',
    },
  };
}

// ---------------------------------------------------------------------------
// Content-safety helpers
// ---------------------------------------------------------------------------

export function findSensitiveDiagnosticPath(
  payload: unknown,
  path = '$',
): string | null {
  if (payload === null || payload === undefined) return null;

  if (typeof payload === 'string') {
    if (SENSITIVE_VALUE_PATTERN.test(payload)) return path;
    return null;
  }

  if (typeof payload !== 'object') return null;

  if (Array.isArray(payload)) {
    for (let i = 0; i < payload.length; i += 1) {
      const hit = findSensitiveDiagnosticPath(payload[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      return `${path}.${key}`;
    }
    const hit = findSensitiveDiagnosticPath(value, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

export function assertContentSafeDiagnostics(diagnostics: unknown): void {
  const hit = findSensitiveDiagnosticPath(diagnostics);
  if (hit) {
    throw new Error(
      `Diagnostics payload contains sensitive field or value at ${hit}. ` +
        'Only window counts, console visibility flags, child-state enums, and request counts are allowed.',
    );
  }
}

// ---------------------------------------------------------------------------
// Capability / schema generation helpers
// ---------------------------------------------------------------------------

const appRoot = fileURLToPath(new URL('../..', import.meta.url));

export function resolveSyncAppRoot(): string {
  // Prefer process.cwd() when tests run from apps/sync (vitest default).
  if (existsSync(join(process.cwd(), 'src-tauri', 'capabilities'))) {
    return process.cwd();
  }
  return appRoot;
}

export function listCapabilityIdentifiers(root = resolveSyncAppRoot()): string[] {
  const dir = join(root, 'src-tauri', 'capabilities');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        identifier?: string;
      };
      return raw.identifier ?? name.replace(/\.json$/, '');
    })
    .sort();
}

export function listGeneratedSchemaFiles(root = resolveSyncAppRoot()): string[] {
  const dir = join(root, 'src-tauri', 'gen', 'schemas');
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
}

/**
 * Verify committed capability sources are reflected in gen/schemas/capabilities.json
 * and that the expected generated schema set is present.
 */
export function checkCapabilitySchemaSync(root = resolveSyncAppRoot()): {
  ok: boolean;
  sourceIds: string[];
  generatedIds: string[];
  missingInGenerated: string[];
  schemaFiles: string[];
  errors: string[];
} {
  const errors: string[] = [];
  const sourceIds = listCapabilityIdentifiers(root);
  const schemaFiles = listGeneratedSchemaFiles(root);

  for (const required of [
    'acl-manifests.json',
    'capabilities.json',
    'desktop-schema.json',
  ]) {
    if (!schemaFiles.includes(required)) {
      errors.push(`missing generated schema file: ${required}`);
    }
  }

  const capabilitiesPath = join(root, 'src-tauri', 'gen', 'schemas', 'capabilities.json');
  let generatedIds: string[] = [];
  if (existsSync(capabilitiesPath)) {
    const generated = JSON.parse(readFileSync(capabilitiesPath, 'utf8')) as Record<
      string,
      { identifier?: string }
    >;
    generatedIds = Object.values(generated)
      .map((entry) => entry.identifier ?? '')
      .filter(Boolean)
      .sort();
  } else {
    errors.push('gen/schemas/capabilities.json is missing');
  }

  const missingInGenerated = sourceIds.filter((id) => !generatedIds.includes(id));
  if (missingInGenerated.length > 0) {
    errors.push(
      `capability identifiers missing from gen/schemas/capabilities.json: ${missingInGenerated.join(', ')}`,
    );
  }

  return {
    ok: errors.length === 0,
    sourceIds,
    generatedIds,
    missingInGenerated,
    schemaFiles,
    errors,
  };
}

/**
 * Optionally re-run Windows-oriented capability/schema generation and assert
 * the worktree under gen/schemas is unchanged.
 *
 * Opt-in only: set `HQ_SYNC_WINDOWS_SCHEMA_GEN=1`. Default test runs use the
 * static `checkCapabilitySchemaSync()` alignment so unit/e2e suites stay fast
 * on every OS (including Windows). Documented for signed-release gates and
 * MANUAL_TESTING.md.
 *
 * Returns `{ ran: false }` when the live generation step is skipped.
 */
export async function runWindowsSchemaGenerationCleanCheck(
  root = resolveSyncAppRoot(),
): Promise<{
  ran: boolean;
  clean: boolean;
  reason?: string;
  porcelain?: string;
}> {
  if (process.env.HQ_SYNC_WINDOWS_SCHEMA_GEN !== '1') {
    return {
      ran: false,
      clean: true,
      reason:
        'set HQ_SYNC_WINDOWS_SCHEMA_GEN=1 to run cargo-driven schema generation clean-check',
    };
  }

  const cargoToml = join(root, 'src-tauri', 'Cargo.toml');
  if (!existsSync(cargoToml)) {
    return { ran: false, clean: true, reason: 'src-tauri/Cargo.toml not found' };
  }

  // Trigger tauri_build schema emission via a lightweight cargo check of the
  // build script dependencies. We use `cargo check` which runs build.rs and
  // regenerates gen/schemas when capabilities change.
  const check = await runCommand(
    'cargo',
    ['check', '--manifest-path', cargoToml, '--message-format=short'],
    { cwd: root, timeoutMs: 10 * 60_000 },
  );
  if (check.exitCode !== 0) {
    return {
      ran: true,
      clean: false,
      reason: `cargo check failed (exit ${check.exitCode}): ${check.stderr.slice(0, 500)}`,
    };
  }

  const git = await runCommand(
    'git',
    ['status', '--porcelain', '--', 'src-tauri/gen/schemas'],
    { cwd: root, timeoutMs: 30_000 },
  );
  const porcelain = (git.stdout + git.stderr).trim();
  return {
    ran: true,
    clean: porcelain.length === 0,
    porcelain,
    reason: porcelain.length === 0 ? undefined : 'generated schema files differ from HEAD',
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface WindowsReliabilityHarnessOptions {
  fixtures?: WindowsReliabilityFixtures;
  /**
   * Force scripted mode even when live env is configured.
   * Defaults to false.
   */
  forceScripted?: boolean;
}

export class WindowsReliabilityHarness {
  readonly platform: NodeJS.Platform = process.platform;
  private fixtures: WindowsReliabilityFixtures;
  private backendRequestCounts: Record<string, number> = {};
  private windowCount = 0;
  private launched = false;
  private mode: 'scripted' | 'live' = 'scripted';
  private liveFallback = false;
  private fallbackReason?: string;
  private liveProcess: ChildProcess | null = null;

  constructor(options: WindowsReliabilityHarnessOptions = {}) {
    this.fixtures = structuredClone(
      options.fixtures ?? createDeterministicWindowsFixtures(),
    );
    if (options.forceScripted) {
      this.mode = 'scripted';
    }
  }

  getFixtures(): WindowsReliabilityFixtures {
    return structuredClone(this.fixtures);
  }

  /**
   * Launch HQ under deterministic fixtures.
   * On non-Windows or without a live app path, always uses scripted mode.
   */
  async launch(): Promise<LaunchResult> {
    const liveResolution = resolveLiveAppPath();
    const wantLive =
      process.env.HQ_SYNC_WINDOWS_RELIABILITY_LIVE === '1' &&
      this.platform === 'win32' &&
      Boolean(liveResolution.appPath);

    if (!wantLive || !liveResolution.appPath) {
      this.mode = 'scripted';
      this.liveFallback = process.env.HQ_SYNC_WINDOWS_RELIABILITY_LIVE === '1';
      this.fallbackReason = liveResolution.reason ?? 'live mode not requested';
      this.applyScriptedLaunch();
      return {
        launched: true,
        mode: 'scripted',
        platform: this.platform,
        liveFallback: this.liveFallback,
        fallbackReason: this.fallbackReason,
      };
    }

    // Live: spawn the built app only when explicitly requested. Diagnostics
    // still come from fixture-backed observers so we never scrape vault files.
    try {
      this.liveProcess = spawn(liveResolution.appPath, [], {
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          HQ_SYNC_RELIABILITY_FIXTURES: '1',
        },
      });
      this.mode = 'live';
      this.applyScriptedLaunch(); // fixture baseline still drives content-safe counts
      this.launched = true;
      return {
        launched: true,
        mode: 'live',
        platform: this.platform,
        liveFallback: false,
      };
    } catch (error) {
      this.mode = 'scripted';
      this.liveFallback = true;
      this.fallbackReason =
        error instanceof Error ? error.message : 'failed to spawn live app';
      this.applyScriptedLaunch();
      return {
        launched: true,
        mode: 'scripted',
        platform: this.platform,
        liveFallback: true,
        fallbackReason: this.fallbackReason,
      };
    }
  }

  /** Simulate tray left-click activation (popover toggle policy). */
  activateTray(): { activated: boolean; leftClickCount: number } {
    this.ensureLaunched();
    this.fixtures.tray.activated = true;
    this.fixtures.tray.leftClickCount += 1;
    // Compact popover only — does not create a desktop window.
    if (this.windowCount < 1) this.windowCount = 1;
    return {
      activated: this.fixtures.tray.activated,
      leftClickCount: this.fixtures.tray.leftClickCount,
    };
  }

  /** Transition a fixture child process state (content-safe id only). */
  setChildProcessState(id: string, state: ChildProcessState): void {
    const child = this.fixtures.childProcesses.find((c) => c.id === id);
    if (!child) {
      throw new Error(`Unknown child process fixture id: ${id}`);
    }
    child.state = state;
  }

  /** Record a backend request by logical resource name (no URLs or bodies). */
  recordBackendRequest(resource: string): void {
    if (!resource || /[/?&=]/.test(resource) || SENSITIVE_KEY_PATTERN.test(resource)) {
      throw new Error(
        `Backend request resource must be a safe logical name, got: ${JSON.stringify(resource)}`,
      );
    }
    this.backendRequestCounts[resource] = (this.backendRequestCounts[resource] ?? 0) + 1;
  }

  /** Capture content-safe diagnostics. */
  captureDiagnostics(): ContentSafeDiagnostics {
    this.ensureLaunched();
    const diagnostics: ContentSafeDiagnostics = {
      windowCount: this.windowCount,
      visibleConsoleProcessCount: this.fixtures.childProcesses.filter((c) => c.visibleConsole)
        .length,
      childProcessStates: this.fixtures.childProcesses.map((c) => ({
        id: c.id,
        role: c.role,
        state: c.state,
        visibleConsole: c.visibleConsole,
      })),
      backendRequestCounts: { ...this.backendRequestCounts },
      trayActivated: this.fixtures.tray.activated,
      trayLeftClickCount: this.fixtures.tray.leftClickCount,
      meetingCount: this.fixtures.meetings.length,
      workspaceCount: this.fixtures.workspaces.length,
      coreDriftBaselineStatus: this.fixtures.coreDrift.baselineStatus,
      coreDriftModifiedCount: this.fixtures.coreDrift.modifiedCount,
      platform: this.platform,
      mode: this.mode,
    };
    assertContentSafeDiagnostics(diagnostics);
    return diagnostics;
  }

  async dispose(): Promise<void> {
    if (this.liveProcess && !this.liveProcess.killed) {
      this.liveProcess.kill();
    }
    this.liveProcess = null;
    this.launched = false;
  }

  private applyScriptedLaunch(): void {
    this.launched = true;
    // Tray-resident app: no top-level window until activation; model as 0.
    this.windowCount = 0;
    // Seed a few metadata-only backend requests that a cold launch would make.
    this.backendRequestCounts = {
      workspace_metadata: 1,
      auth_state: 1,
    };
  }

  private ensureLaunched(): void {
    if (!this.launched) {
      throw new Error('Harness has not launched — call launch() first');
    }
  }
}

// ---------------------------------------------------------------------------
// Platform / live resolution
// ---------------------------------------------------------------------------

export function isWindowsPlatform(): boolean {
  return process.platform === 'win32';
}

export function resolveLiveAppPath(): { appPath: string | null; reason?: string } {
  const fromEnv =
    process.env.HQ_SYNC_DESKTOP_ALT_APP_PATH?.trim() ||
    process.env.HQ_SYNC_DESKTOP_ALT_APP?.trim() ||
    '';
  if (!fromEnv) {
    return {
      appPath: null,
      reason:
        'set HQ_SYNC_WINDOWS_RELIABILITY_LIVE=1 and HQ_SYNC_DESKTOP_ALT_APP (or _APP_PATH) to a built .exe',
    };
  }
  if (!existsSync(fromEnv)) {
    return { appPath: null, reason: `live app path does not exist: ${fromEnv}` };
  }
  return { appPath: fromEnv };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ exitCode: 124, stdout, stderr: stderr + '\n[timeout]' });
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
