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

type DesktopRouteName = 'sync' | 'meetings' | 'company' | 'company-skills' | 'company-workers';

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
// Native WebDriver session creation can legitimately take about a minute on a
// cold Windows runner. Keep every request bounded below Vitest's 120s live
// ceiling without cutting off that supported startup path.
const WEBDRIVER_REQUEST_TIMEOUT_MS = 90_000;
// `src/main.ts` stamps every webview with its own Tauri window label
// (`document.documentElement.dataset.window`), so the classic popover is
// identifiable without depending on any markup that a redesign could move.
const MAIN_WINDOW_PREDICATE = `
  return document.documentElement?.dataset?.window === 'main';
`;
// WebDriver sees the popover's browser target as soon as WebView2 creates it,
// which is strictly before `src/main.ts` runs and stamps that dataset attribute.
// Sampling the predicate once therefore races the app's first paint: on a busy
// runner msedgedriver reports a single page at `http://tauri.localhost/` whose
// document is still empty, and the probe wrongly concludes the popover is
// absent. The window must still appear — this only gives it a deadline instead
// of one instant.
const MAIN_WINDOW_READY_TIMEOUT_MS = 30_000;
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

  return startLiveHarness(resolution.config);
}

/**
 * Low-level live handle for the signed-out Windows smoke.
 *
 * `DesktopAltTestHarness` is deliberately the *scripted* contract — it can only
 * express things both harnesses can answer, and every one of its verbs
 * (`openDesktopAltWindow`, `navigate`) assumes a signed-in user. The live
 * pre-auth smoke needs the opposite: read the real DOM of the classic popover,
 * and observe how the backend gate *refuses*. That is live-only by
 * construction, so it gets its own narrow surface instead of widening the
 * shared interface with methods the scripted harness would have to fake.
 */
export interface LiveDesktopAltProbe {
  /** Focus the classic popover webview (`html[data-window="main"]`). */
  switchToMainWindow(): Promise<void>;
  /** Evaluate a synchronous script in the focused webview. */
  evaluate<T>(script: string, args?: unknown[]): Promise<T>;
  /** Block until the focused webview's rendered text matches; returns it. */
  waitForBodyText(pattern: RegExp, timeoutMs?: number): Promise<string>;
  /** Rendered (not source) text of the focused webview. */
  bodyText(): Promise<string>;
  /** console.error + uncaught errors + unhandled rejections + driver log. */
  consoleErrors(): Promise<string[]>;
  /** invoke() in the focused webview; rejects with the backend's own error. */
  invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Whether a desktop-alt webview exists. Restores focus to the popover. */
  hasDesktopAltWindow(): Promise<boolean>;
  /** Invoke the app's real quit command and prove its exact process exits. */
  quitAndAssertExited(timeoutMs: number): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Live-only factory: never degrades to the scripted harness.
 *
 * The pre-auth smoke exists to exercise a real installed binary, so "the driver
 * could not be resolved" has to be a red test, not a silent downgrade to a
 * regex pass over .svelte sources.
 */
export async function createLivePreAuthProbe(): Promise<LiveDesktopAltProbe> {
  const resolution = await resolveLiveConfig();

  if (!resolution.config) {
    throw new Error(
      `[desktop-alt-e2e] the live pre-auth smoke requires a real tauri-driver harness, but it ` +
        `could not be resolved: ${resolution.reason}. Refusing to fall back to the scripted ` +
        `harness — that would report a pass without launching the application.`,
    );
  }

  const live = await startLiveHarness(resolution.config);
  await live.switchToMainWindow();
  return live;
}

async function startLiveHarness(config: LiveConfig): Promise<LiveDesktopAltHarness> {
  const start = await startOrReuseDriver(config);

  try {
    const live = await LiveDesktopAltHarness.create(start.client, config);
    console.log(`[desktop-alt-e2e] live tauri-driver harness active at ${config.webdriverUrl}.`);
    return live;
  } catch (error) {
    // Release the session so the next spec can create one against the shared
    // driver; the driver process itself outlives individual harnesses.
    await start.client.deleteSession().catch(() => undefined);
    throw error;
  }
}

// Exported so the readiness contract of `switchToMainWindow` can be pinned by a
// scripted spec against a fake driver — the live job is the only place a real
// one exists, and a race that only reproduces there is a race nothing guards.
export class LiveDesktopAltHarness implements DesktopAltTestHarness, LiveDesktopAltProbe {
  readonly mode = 'live';

  private constructor(
    private readonly driver: WebDriverClient,
    private readonly config: LiveConfig,
  ) {}

  static async create(
    driver: WebDriverClient,
    config: LiveConfig,
  ): Promise<LiveDesktopAltHarness> {
    await driver.waitForWindow();
    const harness = new LiveDesktopAltHarness(driver, config);
    await harness.installErrorCaptureForAllWindows();
    return harness;
  }

  async bootApp(): Promise<{ desktopAltEnabled: boolean }> {
    await this.installErrorCaptureForAllWindows();

    // There is no in-popover launcher to find: the popover's
    // `data-testid="desktop-alt-toggle"` button was removed in 3114f6a6 and
    // `harness.ts` asserts it stays removed. Looking for it here returned null
    // on every live run, so this method reported `toggleVisible: false`
    // unconditionally while claiming to describe a visible control. The honest
    // live answer to "is the desktop view reachable for this user" is the gate
    // the app itself calls, asked of the running backend.
    return { desktopAltEnabled: await this.invokeTauriCommand<boolean>('desktop_alt_enabled') };
  }

  async openDesktopAltWindow(): Promise<DesktopAltWindowState> {
    const existingDesktop = await this.findDesktopAltWindow();

    // The only way the app opens this window — App.svelte, the
    // NotificationFeed deep-links and the tray item all invoke exactly this.
    // It re-enters the Rust gate, so a signed-out run fails here, which is
    // where that failure belongs.
    await this.invokeTauriCommand('open_desktop_alt_window');

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
    const trayAlive = await this.invokeTauriCommand('set_tray_state', { state: 'idle' }).then(
      () => true,
    );

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

    if (route === 'company' || route === 'company-skills' || route === 'company-workers') {
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

      // hq-desktop-v2 US-009: the Skills / Workers workspace sections are
      // first-class sidebar entries under the active company.
      if (route !== 'company') {
        const section = route === 'company-skills' ? 'Skills' : 'Workers';
        const sectionClicked = await this.driver.execute<boolean>(
          `
          const label = arguments[0];
          const nav = document.querySelector('[data-testid="v2-workspace-sections"]');
          const button = nav
            ? [...nav.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
            : null;
          if (!button) return false;
          button.click();
          return true;
        `,
          [section],
        );
        if (!sectionClicked) {
          throw new Error(`Live desktop-alt navigation could not find the ${section} section.`);
        }
        await this.waitForText(
          route === 'company-skills'
            ? 'Company-scoped workflows and operating knowledge'
            : 'Company-scoped agents and specialist roles',
        );
      }
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
    // Teardown errors are proof failures in live mode, not cleanup noise.
    await this.driver.deleteSession();
  }

  // ── LiveDesktopAltProbe ────────────────────────────────────────────────────

  async switchToMainWindow(): Promise<void> {
    // Bounded, for the reason recorded at MAIN_WINDOW_READY_TIMEOUT_MS. The
    // claim is unchanged — a real popover window must show up — so a genuinely
    // missing one still fails, just after the deadline instead of instantly.
    let main: string | null = null;
    await this.driver
      .waitUntil(async () => {
        main = await this.findWindowWithPredicate(MAIN_WINDOW_PREDICATE);
        return Boolean(main);
      }, MAIN_WINDOW_READY_TIMEOUT_MS)
      .catch(() => undefined);
    if (!main) {
      const handles = await this.driver.getWindowHandles();
      throw new Error(
        `The app exposed ${handles.length} webview(s) to WebDriver but none of them is the ` +
          `classic popover (html[data-window="main"]) within ${MAIN_WINDOW_READY_TIMEOUT_MS}ms.`,
      );
    }
    await this.driver.switchToWindow(main);
    await this.installErrorCapture();
  }

  async evaluate<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.driver.execute<T>(script, args);
  }

  async bodyText(): Promise<string> {
    return this.driver.execute<string>('return document.body?.innerText || "";');
  }

  async waitForBodyText(pattern: RegExp, timeoutMs = 20_000): Promise<string> {
    let seen = '';
    await this.driver
      .waitUntil(async () => {
        seen = await this.bodyText().catch(() => '');
        return pattern.test(seen);
      }, timeoutMs)
      .catch(() => {
        throw new Error(
          `The window never rendered text matching ${pattern}. Last rendered text was:\n${seen}`,
        );
      });
    return seen;
  }

  async consoleErrors(): Promise<string[]> {
    return this.collectConsoleErrors();
  }

  async invokeCommand<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.invokeTauriCommand<T>(command, args);
  }

  async hasDesktopAltWindow(): Promise<boolean> {
    const desktop = await this.findDesktopAltWindow();
    // `findDesktopAltWindow` walks every handle to probe it, so the focused
    // window is wherever the walk stopped. Put the caller back on the popover.
    await this.switchToMainWindow();
    return Boolean(desktop);
  }

  async quitAndAssertExited(timeoutMs: number): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('The live process-exit probe is Windows-only.');
    }
    const processIds = await windowsProcessIdsForExecutable(this.config.appPath);
    if (processIds.length === 0) {
      throw new Error(
        `No running process matched the live application path: ${this.config.appPath}`,
      );
    }

    const deadline = Date.now() + timeoutMs;
    const scheduled = await this.driver.execute<boolean>(`
      const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
      if (!invoke) return false;
      setTimeout(() => {
        Promise.resolve(invoke('quit_app')).catch((error) => {
          console.error('[desktop-alt-e2e] quit_app failed', String(error?.message || error));
        });
      }, 0);
      return true;
    `);
    if (!scheduled) {
      throw new Error('Tauri invoke bridge was unavailable before the real quit probe.');
    }

    await waitForProcessIdsToExit(processIds, deadline);
    const deleteBudgetMs = deadline - Date.now();
    if (deleteBudgetMs <= 0) {
      throw new Error(`The app exited but exhausted the ${timeoutMs}ms teardown deadline.`);
    }
    // Keep this strict: a delete-session failure means the real WebDriver
    // lifecycle did not close cleanly, even if the native PID disappeared.
    await this.driver.deleteSession(deleteBudgetMs);
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

  /**
   * Call a Tauri command in the current window and return what it resolved
   * with, so a caller can assert on a command's *answer* (`desktop_alt_enabled`)
   * and not merely on it having not thrown.
   */
  private async invokeTauriCommand<T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const result = await this.driver.executeAsync<{ ok: boolean; value?: T; error?: string }>(
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
          .then((value) => done({ ok: true, value }))
          .catch((error) => done({ ok: false, error: String(error?.message || error) }));
      `,
      [command, args],
    );

    if (!result.ok) throw new Error(result.error ?? `Tauri command failed: ${command}`);
    return result.value as T;
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

  async deleteSession(timeoutMs = 30_000): Promise<void> {
    if (!this.sessionId) return;
    await this.raw('DELETE', `/session/${this.sessionId}`, undefined, timeoutMs);
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
    timeoutMs = WEBDRIVER_REQUEST_TIMEOUT_MS,
  ): Promise<WebDriverResponse<T>> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
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

function windowsProcessIdsForExecutable(appPath: string): Promise<number[]> {
  const appName = basename(appPath).replace(/'/g, "''");
  const query =
    '$target = [System.IO.Path]::GetFullPath($env:HQ_SYNC_E2E_APP_PATH); ' +
    `Get-CimInstance Win32_Process -Filter "Name='${appName}'" | ` +
    'Where-Object { $_.ExecutablePath -and ' +
    '([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) } | ' +
    'ForEach-Object { $_.ProcessId }';

  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', query],
      {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HQ_SYNC_E2E_APP_PATH: appPath },
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Failed to identify the live application process: ${error.message}`));
          return;
        }
        const processIds = stdout
          .split(/\s+/)
          .filter(Boolean)
          .map(Number)
          .filter((value) => Number.isSafeInteger(value) && value > 0);
        resolve([...new Set(processIds)]);
      },
    );
  });
}

async function waitForProcessIdsToExit(processIds: number[], deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const alive = processIds.filter(isProcessAlive);
    if (alive.length === 0) return;
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }

  const alive = processIds.filter(isProcessAlive);
  throw new Error(`Application process did not exit before the deadline; still alive: ${alive.join(',')}`);
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
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
 *
 * Resolves with the captured text (empty string when the probe could not run)
 * so callers can assert on it, not just archive it.
 */
function snapshotWindowsProcesses(appPath: string, outFile: string): Promise<string> {
  if (process.platform !== 'win32') return Promise.resolve('');

  const app = basename(appPath);
  const query =
    `Get-CimInstance Win32_Process -Filter "Name='${app}' or Name='msedgewebview2.exe' ` +
    `or Name='msedgedriver.exe' or Name='tauri-driver.exe'" | ` +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-List | Out-String -Width 8000';

  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', query],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        const header = `\n=== ${new Date().toISOString()} ===\n`;
        const body = error ? `probe failed: ${error.message}\n` : stdout;
        appendFileSync(outFile, `${header}${body}`);
        resolve(error ? '' : stdout);
      },
    );
  });
}

/**
 * One probe per test process — the answer cannot change once the WebView2
 * environment for this app instance exists.
 */
let automationSwitchesVerified = false;

/**
 * Prove the driver's switches reached the WebView2 browser process.
 *
 * msedgedriver can only inject `--remote-debugging-port` through the
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable, and wry sets
 * `AdditionalBrowserArguments` unconditionally, which makes the WebView2
 * Runtime drop that variable on the floor. The app compensates in
 * `src-tauri/src/util/webview2_automation.rs`. If that forwarding is ever lost,
 * the only symptom is a 60s stall ending in `session not created:
 * DevToolsActivePort file doesn't exist` — a message that names the symptom and
 * not the cause. Checking the browser process's own command line turns that
 * into an immediate, self-explaining failure, and leaves the captured tree in
 * the uploaded artifact either way.
 */
async function assertWebviewAutomationSwitches(config: LiveConfig, logDir: string): Promise<void> {
  if (process.platform !== 'win32' || automationSwitchesVerified) return;

  const snapshot = await snapshotWindowsProcesses(
    config.appPath,
    join(logDir, 'processes-postsession.log'),
  );
  if (!snapshot) return; // probe itself failed; it is diagnostics, not a gate

  const browserProcesses = snapshot
    .split(/\r?\n/)
    .filter((line) => line.includes('--embedded-browser-webview=1'));

  if (browserProcesses.length === 0) {
    throw new Error(
      'No WebView2 browser process was found after the WebDriver session was created. ' +
        `Captured process tree:\n${snapshot}`,
    );
  }

  if (!browserProcesses.some((line) => line.includes('--remote-debugging-port'))) {
    throw new Error(
      'The WebView2 browser process started without --remote-debugging-port, so WebDriver ' +
        'cannot attach to it. msedgedriver injects that switch via ' +
        'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, which the WebView2 Runtime ignores unless the ' +
        'app forwards it through additionalBrowserArgs — see ' +
        `src-tauri/src/util/webview2_automation.rs. Captured process tree:\n${snapshot}`,
    );
  }

  automationSwitchesVerified = true;
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

  const files = [
    join(logDir, 'tauri-driver.log'),
    join(logDir, 'processes-midflight.log'),
    join(logDir, 'processes-postsession.log'),
  ];
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
    // Reusing a driver this process did not spawn, so there is no
    // tauri-driver.log or native driver log of our own — but the WebDriver
    // error payload and the process snapshots still are the whole story, and
    // not wrapping here silently dropped every diagnostic on exactly the path
    // a developer re-running against a warm driver takes.
    const logDir = driverLogDir();
    try {
      await client.createSession(config.appPath);
      await assertWebviewAutomationSwitches(config, logDir);
      return { client };
    } catch (error) {
      throw withDriverDiagnostics(describeDriverFailure(config, logDir, null, error), error);
    }
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
      void snapshotWindowsProcesses(config.appPath, join(logDir, 'processes-midflight.log'));
    }, 20_000);
    try {
      await client.createSession(config.appPath);
    } finally {
      clearTimeout(midFlight);
    }
    await assertWebviewAutomationSwitches(config, logDir);
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
    throw withDriverDiagnostics(report, error);
  }
}

/**
 * Attach a diagnostics report to whatever was thrown, without losing the
 * original error's type or stack.
 */
function withDriverDiagnostics(report: string, error: unknown): Error {
  if (error instanceof Error) {
    error.message = `${error.message}${report}`;
    return error;
  }
  return new Error(`${String(error)}${report}`);
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
