import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  commandOnPath,
  DesktopAltHarness,
  reportDriverMode,
  type DesktopAltSnapshot,
  type DesktopAltTestHarness,
  type DesktopAltWindowState,
  type RenderedPage,
} from './harness';

type DesktopRouteName = 'sync' | 'meetings' | 'company';

interface LiveConfig {
  appPath: string;
  webdriverUrl: string;
}

interface DriverStart {
  client: WebDriverClient;
}

interface WebDriverResponse<T> {
  value?: T;
  sessionId?: string;
}

interface SessionValue {
  sessionId?: string;
  capabilities?: Record<string, unknown>;
}

interface WebDriverLogEntry {
  level?: string;
  message?: string;
}

const DESKTOP_ALT_SELECTOR = '#desktop-alt, html[data-window="desktop-alt"]';
const POPOVER_TOGGLE_SELECTOR = '[data-testid="desktop-alt-toggle"]';
const ERROR_CAPTURE_SCRIPT = `
  if (!window.__desktopAltE2eErrors) {
    window.__desktopAltE2eErrors = [];
    const pushError = (value) => window.__desktopAltE2eErrors.push(String(value));
    const originalConsoleError = console.error.bind(console);
    console.error = (...args) => {
      pushError(args.map((arg) => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'string') return arg;
        try { return JSON.stringify(arg); } catch (_) { return String(arg); }
      }).join(' '));
      originalConsoleError(...args);
    };
    window.addEventListener('error', (event) => {
      pushError(event.error?.stack || event.message || 'window error');
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      pushError(reason?.stack || reason?.message || reason || 'unhandled rejection');
    });
  }
  return true;
`;

export async function createDesktopAltHarness(email: string): Promise<DesktopAltTestHarness> {
  const resolution = await resolveLiveConfig();

  if (!resolution.config) {
    // Live mode is opt-in and always explicit (CI sets HQ_SYNC_DESKTOP_ALT_LIVE
    // before the Windows smoke steps). Degrading to the scripted source-contract
    // harness there would turn a ~20-minute "test the installed application" job
    // into a 68ms regex pass over .svelte files that never launches the binary —
    // a green check asserting nothing. Fail loudly instead; only the implicit
    // (unset) case is allowed to fall back.
    if (isTruthy(process.env.HQ_SYNC_DESKTOP_ALT_LIVE)) {
      throw new Error(
        `[desktop-alt-e2e] HQ_SYNC_DESKTOP_ALT_LIVE was requested but the live tauri-driver ` +
          `harness could not be resolved: ${resolution.reason}. Refusing to fall back to the ` +
          `scripted harness — that would report a pass without exercising the application.`,
      );
    }

    reportDriverMode(resolution.reason);
    return new DesktopAltHarness(email);
  }

  const start = await startOrReuseDriver(resolution.config);

  try {
    const live = await LiveDesktopAltHarness.create(start.client);
    console.log(
      `[desktop-alt-e2e] live tauri-driver harness active at ${resolution.config.webdriverUrl}.`,
    );
    return live;
  } catch (error) {
    // Release the session so the next spec can create one against the shared
    // driver; the driver process itself outlives individual harnesses.
    await start.client.deleteSession().catch(() => undefined);
    throw error;
  }
}

class LiveDesktopAltHarness implements DesktopAltTestHarness {
  readonly mode = 'live';

  private constructor(private readonly driver: WebDriverClient) {}

  static async create(driver: WebDriverClient): Promise<LiveDesktopAltHarness> {
    await driver.waitForWindow();
    const harness = new LiveDesktopAltHarness(driver);
    await harness.installErrorCaptureForAllWindows();
    return harness;
  }

  async bootPopover(): Promise<{ toggleVisible: boolean }> {
    await this.installErrorCaptureForAllWindows();
    const popover = await this.findWindowWithSelector(POPOVER_TOGGLE_SELECTOR);
    if (popover) await this.driver.switchToWindow(popover);
    return { toggleVisible: Boolean(popover) };
  }

  async clickDesktopAltToggle(): Promise<DesktopAltWindowState> {
    const existingDesktop = await this.findDesktopAltWindow();

    await this.openDesktopAltWindow();

    const desktop = await this.waitForDesktopAltWindow();
    await this.driver.switchToWindow(desktop);
    await this.installErrorCapture();

    return {
      id: desktop,
      focused: true,
      created: existingDesktop !== desktop,
    };
  }

  async closeDesktopAltWindow(): Promise<void> {
    const desktop = await this.findDesktopAltWindow();
    if (!desktop) return;

    await this.driver.switchToWindow(desktop);
    await this.driver.closeCurrentWindow();
    await this.driver.waitUntil(async () => !(await this.findDesktopAltWindow()), 5_000);

    const [remainingWindow] = await this.driver.getWindowHandles();
    if (remainingWindow) await this.driver.switchToWindow(remainingWindow);
  }

  async snapshot(): Promise<DesktopAltSnapshot> {
    const desktop = await this.findDesktopAltWindow();
    const popoverAlive = Boolean(await this.findResponsiveNonDesktopWindow(desktop));
    const trayAlive = await this.invokeTauriCommand('set_tray_state', { state: 'idle' });

    return {
      popoverAlive,
      trayAlive,
      desktopAltWindow: desktop ? { id: desktop, focused: true } : null,
    };
  }

  async navigate(route: DesktopRouteName): Promise<RenderedPage> {
    const desktop = await this.waitForDesktopAltWindow();
    await this.driver.switchToWindow(desktop);
    await this.installErrorCapture();

    if (route === 'company') {
      const clicked = await this.driver.execute<boolean>(`
        const button = document.querySelector('nav[aria-label="Companies"] button');
        if (!button) return false;
        button.click();
        return true;
      `);
      if (!clicked) {
        throw new Error('Live desktop-alt company navigation requires at least one company row.');
      }
      await this.waitForText('Companies');
    } else {
      // The V4 IA renamed the Sync destination to Home (US-002); the V4 Home
      // surface renders the actor-grouped digest header (US-003).
      await this.clickButtonWithText(route === 'sync' ? 'Home' : 'Meetings');
      await this.waitForText(
        route === 'sync' ? 'Today across your companies' : 'Connected calendars',
      );
    }

    const text = await this.visibleText();
    return {
      route,
      text,
      consoleErrors: await this.collectConsoleErrors(),
    };
  }

  async dispose(): Promise<void> {
    // Only the session: the tauri-driver server is shared across the spec file.
    await this.driver.deleteSession().catch(() => undefined);
  }

  private async openDesktopAltWindow(): Promise<void> {
    const popover = await this.findWindowWithSelector(POPOVER_TOGGLE_SELECTOR);
    if (popover) {
      await this.driver.switchToWindow(popover);
      const toggle = await this.driver.findElement(POPOVER_TOGGLE_SELECTOR);
      await this.driver.clickElement(toggle);
      return;
    }

    await this.invokeTauriCommand('open_desktop_alt_window', {});
  }

  private async clickButtonWithText(label: string): Promise<void> {
    const clicked = await this.driver.execute<boolean>(
      `
        const label = arguments[0];
        const buttons = Array.from(document.querySelectorAll('button'));
        const button = buttons.find((candidate) => candidate.textContent?.trim() === label);
        if (!button) return false;
        button.click();
        return true;
      `,
      [label],
    );

    if (!clicked) throw new Error(`Could not find live desktop-alt navigation button: ${label}`);
  }

  private async waitForText(text: string): Promise<void> {
    await this.driver.waitUntil(async () => {
      const bodyText = await this.driver
        .execute<string>('return document.body?.innerText || "";')
        .catch(() => '');
      return bodyText.includes(text);
    }, 5_000);
  }

  private async visibleText(): Promise<string[]> {
    const bodyText = await this.driver.execute<string>('return document.body?.innerText || "";');
    return bodyText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async collectConsoleErrors(): Promise<string[]> {
    const pageErrors = await this.driver
      .execute<unknown[]>('return window.__desktopAltE2eErrors || [];')
      .catch(() => []);
    const browserLogs = await this.driver.browserLogs().catch(() => []);
    const logErrors = browserLogs
      .filter((entry) => !entry.level || /error|severe/i.test(entry.level))
      .map((entry) => entry.message)
      .filter((message): message is string => Boolean(message));

    return [...pageErrors.map(String), ...logErrors];
  }

  private async installErrorCaptureForAllWindows(): Promise<void> {
    const handles = await this.driver.getWindowHandles();
    for (const handle of handles) {
      await this.driver.switchToWindow(handle).catch(() => undefined);
      await this.installErrorCapture().catch(() => undefined);
    }
  }

  private async installErrorCapture(): Promise<void> {
    await this.driver.execute<boolean>(ERROR_CAPTURE_SCRIPT);
  }

  private async findDesktopAltWindow(): Promise<string | null> {
    return this.findWindowWithPredicate(
      `
        return Boolean(
          document.querySelector(arguments[0]) ||
          location.href.includes('desktop-alt.html') ||
          document.documentElement?.dataset?.window === 'desktop-alt'
        );
      `,
      [DESKTOP_ALT_SELECTOR],
    );
  }

  private async waitForDesktopAltWindow(): Promise<string> {
    let desktop: string | null = null;
    await this.driver.waitUntil(async () => {
      desktop = await this.findDesktopAltWindow();
      return Boolean(desktop);
    }, 8_000);
    if (!desktop) throw new Error('Timed out waiting for the desktop-alt window.');
    return desktop;
  }

  private async findWindowWithSelector(selector: string): Promise<string | null> {
    return this.findWindowWithPredicate('return Boolean(document.querySelector(arguments[0]));', [
      selector,
    ]);
  }

  private async findResponsiveNonDesktopWindow(desktop: string | null): Promise<string | null> {
    const handles = await this.driver.getWindowHandles();
    for (const handle of handles) {
      if (handle === desktop) continue;
      const responsive = await this.driver
        .switchToWindow(handle)
        .then(() => this.driver.execute<boolean>('return document.readyState !== "loading";'))
        .catch(() => false);
      if (responsive) return handle;
    }
    return null;
  }

  private async findWindowWithPredicate(script: string, args: unknown[] = []): Promise<string | null> {
    const handles = await this.driver.getWindowHandles();
    for (const handle of handles) {
      const matches = await this.driver
        .switchToWindow(handle)
        .then(() => this.driver.execute<boolean>(script, args))
        .catch(() => false);
      if (matches) return handle;
    }
    return null;
  }

  private async invokeTauriCommand(command: string, args: Record<string, unknown>): Promise<boolean> {
    const result = await this.driver.executeAsync<{ ok: boolean; error?: string }>(
      `
        const command = arguments[0];
        const payload = arguments[1];
        const done = arguments[arguments.length - 1];
        const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
        if (!invoke) {
          done({ ok: false, error: 'Tauri invoke bridge is not exposed to WebDriver.' });
          return;
        }
        Promise.resolve(invoke(command, payload))
          .then(() => done({ ok: true }))
          .catch((error) => done({ ok: false, error: String(error?.message || error) }));
      `,
      [command, args],
    );

    if (!result.ok) throw new Error(result.error ?? `Tauri command failed: ${command}`);
    return true;
  }
}

class WebDriverClient {
  private sessionId: string | null = null;

  constructor(private readonly baseUrl: string) {}

  async status(): Promise<boolean> {
    await this.raw('GET', '/status');
    return true;
  }

  async createSession(appPath: string): Promise<void> {
    const response = await this.raw<SessionValue>('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'wry',
          'tauri:options': {
            application: appPath,
          },
        },
      },
    });

    this.sessionId = response.value?.sessionId ?? response.sessionId ?? null;
    if (!this.sessionId) throw new Error('tauri-driver did not return a WebDriver session id.');
  }

  async waitForWindow(): Promise<void> {
    await this.waitUntil(async () => (await this.getWindowHandles()).length > 0, 10_000);
  }

  async getWindowHandles(): Promise<string[]> {
    return this.send<string[]>('GET', '/window/handles');
  }

  async switchToWindow(handle: string): Promise<void> {
    await this.send<null>('POST', '/window', { handle });
  }

  async closeCurrentWindow(): Promise<void> {
    await this.send<null>('DELETE', '/window');
  }

  async findElement(selector: string): Promise<string> {
    const element = await this.send<Record<string, string>>('POST', '/element', {
      using: 'css selector',
      value: selector,
    });
    const elementId = element['element-6066-11e4-a52e-4f735466cecf'] ?? element.ELEMENT;
    if (!elementId) throw new Error(`WebDriver did not return an element id for ${selector}.`);
    return elementId;
  }

  async clickElement(elementId: string): Promise<void> {
    await this.send<null>('POST', `/element/${encodeURIComponent(elementId)}/click`);
  }

  async execute<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.send<T>('POST', '/execute/sync', { script, args });
  }

  async executeAsync<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.send<T>('POST', '/execute/async', { script, args });
  }

  async browserLogs(): Promise<WebDriverLogEntry[]> {
    return this.send<WebDriverLogEntry[]>('POST', '/log', { type: 'browser' });
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return;
    await this.raw('DELETE', `/session/${this.sessionId}`);
    this.sessionId = null;
  }

  async waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      try {
        if (await predicate()) return;
      } catch (error) {
        lastError = error;
      }
      await sleep(100);
    }

    throw new Error(
      lastError instanceof Error
        ? `Timed out waiting for WebDriver condition: ${lastError.message}`
        : 'Timed out waiting for WebDriver condition.',
    );
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.sessionId) throw new Error('WebDriver session has not been created.');
    const response = await this.raw<T>(method, `/session/${this.sessionId}${path}`, body);
    return response.value as T;
  }

  private async raw<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<WebDriverResponse<T>> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as WebDriverResponse<T> & {
      value?: { message?: string };
    };

    if (!response.ok) {
      const message =
        typeof payload.value?.message === 'string'
          ? payload.value.message
          : `${method} ${path} failed with HTTP ${response.status}`;
      // `message` is only a one-line summary ("session not created: ..."); the
      // driver-specific `stacktrace`/`data` fields next to it are where the
      // actual cause lives. Keep the whole payload on the thrown error.
      throw Object.assign(new Error(message), {
        webdriverStatus: response.status,
        webdriverPayload: payload,
      });
    }

    return payload as WebDriverResponse<T>;
  }
}

async function resolveLiveConfig(): Promise<{ config: LiveConfig | null; reason: string }> {
  const appPath =
    process.env.HQ_SYNC_DESKTOP_ALT_APP ?? process.env.HQ_SYNC_DESKTOP_ALT_APP_PATH ?? '';
  const webdriverUrl = process.env.HQ_SYNC_DESKTOP_ALT_WEBDRIVER_URL ?? 'http://127.0.0.1:4444';
  const liveRequested = isTruthy(process.env.HQ_SYNC_DESKTOP_ALT_LIVE);

  if (!liveRequested && !appPath) {
    return {
      config: null,
      reason:
        'set HQ_SYNC_DESKTOP_ALT_LIVE=1 with HQ_SYNC_DESKTOP_ALT_APP to enable live tauri-driver checks',
    };
  }

  if (!appPath) {
    return {
      config: null,
      reason: 'HQ_SYNC_DESKTOP_ALT_LIVE was set but no HQ_SYNC_DESKTOP_ALT_APP path was provided',
    };
  }

  if (commandOnPath('tauri-driver')) {
    return { config: { appPath, webdriverUrl }, reason: '' };
  }

  const reusableClient = new WebDriverClient(webdriverUrl);
  const reusableDriverRunning = await reusableClient.status().catch(() => false);

  if (reusableDriverRunning) {
    return { config: { appPath, webdriverUrl }, reason: '' };
  }

  return {
    config: null,
    reason: 'live inputs were provided, but tauri-driver was not on PATH and no WebDriver server responded',
  };
}

/**
 * One tauri-driver server per test process.
 *
 * `dispose()` used to kill the driver it was handed, so a multi-case spec
 * (smoke-pages runs three routes) tore the server down and immediately raced to
 * rebind port 4444 for the next case — the losing case reported
 * `session not created`. The driver is a server: keep it up for the module
 * lifetime, let each case create and delete its own session against it, and
 * reap it when the test process exits.
 */
let sharedDriverProcess: ChildProcess | null = null;

function reapSharedDriver(): void {
  sharedDriverProcess?.kill();
  sharedDriverProcess = null;
}

/**
 * Where tauri-driver's own output and the native WebDriver's verbose log land.
 * CI uploads this directory when the smoke fails; locally it defaults under the
 * OS temp dir. Override with HQ_SYNC_DESKTOP_ALT_DRIVER_LOG_DIR.
 */
function driverLogDir(): string {
  const dir =
    process.env.HQ_SYNC_DESKTOP_ALT_DRIVER_LOG_DIR ??
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'desktop-alt-driver-logs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * tauri-driver spawns `msedgedriver.exe` itself with only `--port`/`--host` and
 * exposes no flag for the native driver's own logging — `--native-driver PATH`
 * is the only hook it offers, and it rejects unknown arguments outright. So
 * point it at a shim that adds `--verbose --log-path` and forwards whatever
 * tauri-driver appends. Without this the WebView2 handshake is entirely opaque:
 * the only thing that ever surfaces is the one-line `session not created`
 * summary, which names a symptom rather than a cause.
 */
function writeNativeDriverShim(logDir: string): { shim: string; nativeLog: string } | null {
  if (process.platform !== 'win32') return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shim = join(logDir, `msedgedriver-verbose-${stamp}.cmd`);
  const nativeLog = join(logDir, `msedgedriver-${stamp}.log`);
  writeFileSync(
    shim,
    ['@echo off', `msedgedriver.exe --verbose --log-path="${nativeLog}" %*`, ''].join('\r\n'),
  );
  return { shim, nativeLog };
}

/**
 * Windows-only probe. `msedgewebview2.exe`'s command line is the direct answer
 * to whether the remote debugging port msedgedriver injects actually reached
 * the WebView2 browser process, and which user data folder that process is
 * using — which is where it would write the DevToolsActivePort file.
 */
function snapshotWindowsProcesses(appPath: string, outFile: string): void {
  if (process.platform !== 'win32') return;

  const app = basename(appPath);
  const query =
    `Get-CimInstance Win32_Process -Filter "Name='${app}' or Name='msedgewebview2.exe' ` +
    `or Name='msedgedriver.exe' or Name='tauri-driver.exe'" | ` +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-List | Out-String -Width 8000';

  execFile(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', query],
    { timeout: 30_000 },
    (error, stdout) => {
      const header = `\n=== ${new Date().toISOString()} ===\n`;
      const body = error ? `probe failed: ${error.message}\n` : stdout;
      appendFileSync(outFile, `${header}${body}`);
    },
  );
}

/**
 * Fold the full WebDriver error payload and the driver logs into the thrown
 * message so the failing CI step explains itself without downloading the
 * artifact first.
 */
function describeDriverFailure(
  config: LiveConfig,
  logDir: string,
  nativeLog: string | null,
  error: unknown,
): string {
  const sections: string[] = [];

  const payload = (error as { webdriverPayload?: unknown } | null)?.webdriverPayload;
  if (payload !== undefined) {
    sections.push(`WebDriver error payload:\n${JSON.stringify(payload, null, 2)}`);
  }

  sections.push(`application: ${config.appPath} (exists: ${existsSync(config.appPath)})`);

  const files = [join(logDir, 'tauri-driver.log'), join(logDir, 'processes-midflight.log')];
  if (nativeLog) files.push(nativeLog);

  for (const file of files) {
    if (!existsSync(file)) {
      sections.push(`${file}: (not written)`);
      continue;
    }
    const tail = readFileSync(file, 'utf8').split('\n').slice(-150).join('\n');
    sections.push(`${file} (last 150 lines):\n${tail}`);
  }

  return `\n\n--- live desktop-alt driver diagnostics ---\n${sections.join('\n\n')}\n--- end diagnostics ---`;
}

async function startOrReuseDriver(config: LiveConfig): Promise<DriverStart> {
  const client = new WebDriverClient(config.webdriverUrl);
  const driverRunning = await client.status().catch(() => false);

  if (driverRunning) {
    await client.createSession(config.appPath);
    return { client };
  }

  const logDir = driverLogDir();
  const native = writeNativeDriverShim(logDir);
  const driverArgs = ['--port', String(new URL(config.webdriverUrl).port || 4444)];
  if (native) driverArgs.push('--native-driver', native.shim);

  const driverProcess = spawn('tauri-driver', driverArgs, {
    env: { ...process.env, TAURI_WEBVIEW_AUTOMATION: 'true' },
    // Pipe rather than inherit: when the native driver cannot start,
    // tauri-driver's stderr is the only explanation, and it has to reach both
    // the CI console (for the failing step) and a file (for the artifact).
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const tauriDriverLog = join(logDir, 'tauri-driver.log');
  appendFileSync(
    tauriDriverLog,
    `\n=== tauri-driver ${driverArgs.join(' ')} @ ${new Date().toISOString()} ===\n`,
  );
  for (const stream of [driverProcess.stdout, driverProcess.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendFileSync(tauriDriverLog, text);
      process.stdout.write(text.replace(/^/gm, '[tauri-driver] '));
    });
  }

  // `spawn` reports a missing/unlaunchable binary asynchronously; without this
  // the failure surfaces only as an unhandled 'error' event plus an opaque
  // connection timeout below.
  const spawnErrors: Error[] = [];
  driverProcess.on('error', (error) => {
    spawnErrors.push(error);
  });

  sharedDriverProcess = driverProcess;
  process.once('exit', reapSharedDriver);

  try {
    await client.waitUntil(() => client.status().catch(() => false), 30_000);
    // msedgedriver waits ~60s for the app's DevToolsActivePort file and kills
    // the app on the way out, so snapshot the process tree mid-flight while the
    // WebView2 browser process is still up.
    const midFlight = setTimeout(() => {
      snapshotWindowsProcesses(config.appPath, join(logDir, 'processes-midflight.log'));
    }, 20_000);
    try {
      await client.createSession(config.appPath);
    } finally {
      clearTimeout(midFlight);
    }
    return { client };
  } catch (error) {
    // Read the logs before reaping: msedgedriver is still alive here.
    const report = describeDriverFailure(config, logDir, native?.nativeLog ?? null, error);
    reapSharedDriver();
    const [spawnError] = spawnErrors;
    if (spawnError) {
      throw new Error(
        `Failed to launch tauri-driver: ${spawnError.message}. ` +
          `Install it with \`cargo install tauri-driver --locked\`.${report}`,
      );
    }
    if (error instanceof Error) {
      error.message = `${error.message}${report}`;
      throw error;
    }
    throw new Error(`${String(error)}${report}`);
  }
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
