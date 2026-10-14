// Apple Command Line Tools gate for first-run setup (macOS).
//
// On a fresh Mac the git at /usr/bin/git is a shim that pops Apple's "install
// the command line developer tools" dialog when run. Setup checks for the
// tools before any stage that runs git, shows its own waiting card, then asks
// macOS to install them and polls until they land. The Rust side never runs
// the shim to check (see src-tauri/src/commands/command_line_tools.rs).

export interface CommandLineToolsStatus {
  /** True only where git depends on the tools (macOS, or the fake harness). */
  required: boolean;
  present: boolean;
  /** Apple's installer helper is running. */
  installerOpen: boolean;
  /** HQ_FAKE_CLT_MISSING harness is active; no real installer exists. */
  simulated: boolean;
}

export type CommandLineToolsPhase = 'installing' | 'ready' | 'cancelled' | 'timeout';

/** Stages that shell out to git, directly or through the hq CLI. */
export const CLT_GATED_STAGES = ['deps', 'initial-sync', 'git-init', 'personalize', 'indexing'] as const;

export const CLT_POLL_MS = 3_000;
/** The install is usually 5 to 15 minutes; allow slow networks. */
export const CLT_TIMEOUT_MS = 45 * 60_000;
/** How long Apple's installer may take to appear before we treat it as closed. */
export const CLT_INSTALLER_APPEAR_GRACE_MS = 20_000;

export const CLT_CARD_COPY = {
  title: "Installing Apple's developer tools",
  body:
    'macOS will show its own prompts: choose Install, then Agree to the license agreement. Please accept them.',
  duration: 'This usually takes 5 to 15 minutes.',
  resume: 'Setup continues on its own when it finishes.',
  showWindow: 'Show the Apple window',
  showingWindow: 'Opening…',
  retryTitle: "Apple's developer tools are not installed yet",
  cancelledBody:
    'The Apple install was closed before it finished. HQ needs these tools to set up your workspace. macOS will show its own prompts: choose Install, then Agree to the license agreement.',
  timeoutBody:
    'The Apple install is taking longer than expected. You can start it again; macOS will show its own prompts: choose Install, then Agree to the license agreement.',
  retry: 'Try again',
  retrying: 'Starting…',
} as const;

export interface CltTickInput {
  status: CommandLineToolsStatus;
  installerSeen: boolean;
  elapsedMs: number;
  timeoutMs?: number;
  appearGraceMs?: number;
}

export interface CltTickResult {
  phase: CommandLineToolsPhase;
  installerSeen: boolean;
}

/**
 * Pure state transition for one poll tick.
 * missing -> installing -> ready, or -> cancelled (Cancel / Disagree closes
 * Apple's installer) or -> timeout.
 */
export function nextCommandLineToolsPhase(input: CltTickInput): CltTickResult {
  const { status } = input;
  const timeoutMs = input.timeoutMs ?? CLT_TIMEOUT_MS;
  const graceMs = input.appearGraceMs ?? CLT_INSTALLER_APPEAR_GRACE_MS;
  if (!status.required || status.present) {
    return { phase: 'ready', installerSeen: input.installerSeen };
  }
  const installerSeen = input.installerSeen || status.installerOpen;
  if (input.elapsedMs >= timeoutMs) return { phase: 'timeout', installerSeen };
  if (status.simulated || status.installerOpen) return { phase: 'installing', installerSeen };
  // Apple's installer closed (or never opened) while the tools are still
  // missing: the person cancelled or disagreed.
  if (installerSeen || input.elapsedMs >= graceMs) return { phase: 'cancelled', installerSeen };
  return { phase: 'installing', installerSeen };
}

export interface CltGateDeps {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Called with 'installing' before the install is triggered, so the card is up first. */
  onPhase: (phase: CommandLineToolsPhase) => void | Promise<void>;
  /** False once the setup run this gate belongs to is gone. */
  isActive: () => boolean;
  pollMs?: number;
  timeoutMs?: number;
  appearGraceMs?: number;
}

export type CltGateOutcome = 'ready' | 'cancelled' | 'timeout' | 'inactive';

/** True when an IPC answer looks like a status; anything else counts as missing. */
function asStatus(value: unknown): CommandLineToolsStatus | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.required !== 'boolean' || typeof v.present !== 'boolean') return null;
  return {
    required: v.required,
    present: v.present,
    installerOpen: v.installerOpen === true,
    simulated: v.simulated === true,
  };
}

async function readStatus(deps: CltGateDeps, command: string): Promise<CommandLineToolsStatus | null> {
  try {
    return asStatus(await deps.invoke<unknown>(command));
  } catch (error) {
    console.warn(`[clt] ${command} failed`, error);
    return null;
  }
}

/** Fast check used before any git stage. Unknown host or bridge errors do not block. */
export async function commandLineToolsMissing(deps: Pick<CltGateDeps, 'invoke'>): Promise<boolean> {
  const status = await readStatus(deps as CltGateDeps, 'command_line_tools_status');
  return !!status && status.required && !status.present;
}

/**
 * Show the card, start Apple's install, and wait for the tools. Resolves
 * 'ready' when they are present; 'cancelled' or 'timeout' for the retry
 * state; 'inactive' when the setup run went away.
 */
export async function runCommandLineToolsGate(deps: CltGateDeps): Promise<CltGateOutcome> {
  const pollMs = deps.pollMs ?? CLT_POLL_MS;
  await deps.onPhase('installing');
  if (!deps.isActive()) return 'inactive';
  const startedAt = deps.now();
  let installerSeen = false;
  let status = await readStatus(deps, 'command_line_tools_start_install');
  for (;;) {
    if (!deps.isActive()) return 'inactive';
    if (status) {
      if (status.installerOpen) {
        // Apple's window opens behind the full-screen setup window.
        void deps
          .invoke('command_line_tools_show_installer')
          .catch((error) => console.warn('[clt] bring installer to front failed', error));
      }
      const next = nextCommandLineToolsPhase({
        status,
        installerSeen,
        elapsedMs: deps.now() - startedAt,
        timeoutMs: deps.timeoutMs,
        appearGraceMs: deps.appearGraceMs,
      });
      installerSeen = next.installerSeen;
      if (next.phase !== 'installing') {
        await deps.onPhase(next.phase);
        return next.phase;
      }
    } else if (deps.now() - startedAt >= (deps.timeoutMs ?? CLT_TIMEOUT_MS)) {
      await deps.onPhase('timeout');
      return 'timeout';
    }
    await deps.sleep(pollMs);
    if (!deps.isActive()) return 'inactive';
    status = await readStatus(deps, 'command_line_tools_status');
  }
}
