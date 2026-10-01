/**
 * Wire the SetupInstallGuide component to real Tauri commands (US-005).
 *
 * The component is prop-driven: it takes four callbacks and calls them at
 * install / sign-in / refresh / manual-download time. This adapter produces
 * that four-callback shape from the desktop shell's real seams:
 *
 *   - `install_claude_code` / `install_codex` (Rust commands, cross-platform:
 *     they branch on `#[cfg(windows)]` internally to install via `.msi` /
 *     managed npm on Windows and via `.pkg`/brew/npm on macOS)
 *   - `agent_provider_login_start` (opens the tool's own sign-in flow and
 *     resolves when it reports `connected`; HQ never sees the password)
 *   - `detect_ai_tools` (re-probes the CLI on disk after install / sign-in)
 *   - `@tauri-apps/plugin-shell` `open()` for the manual-download fallback URL
 *
 * Pure boundary: the adapter itself has no state and every call goes through
 * injected primitives. Tests mock those primitives instead of the whole
 * `@tauri-apps/api/core` module.
 */

/**
 * Mirror of the SetupInstallGuide types from
 * `packages/ui/src/settings/SetupInstallGuide.svelte`. Kept local because the
 * `@hq/ui` package exports only its root barrel, and this adapter has no
 * runtime dependency on the Svelte component - just its callback contract.
 */
export type CodingTool = "claude" | "codex";
export type AssistantId = "claude-desktop" | "chatgpt-desktop";
export interface InstallOutcome {
  ok: boolean;
  reason?: string;
}

/** Options for one sign-in wait. `signal` stops the wait early. */
export interface SignInOptions {
  signal?: AbortSignal;
}

/**
 * How often the adapter asks the host whether a sign-in it started has
 * finished. Bounded: the loop only runs while one sign-in is in flight.
 */
export const SIGN_IN_POLL_MS = 2_000;
/**
 * How long one sign-in may wait for the browser before the adapter gives up.
 * A little longer than the host's own 5-minute login deadline, so the host's
 * "timed out" answer is what normally ends the wait.
 */
export const SIGN_IN_DEADLINE_MS = 6 * 60_000;

/**
 * Tauri command name for each tool's installer. Cross-platform per the Rust
 * source: `install_deps.rs` branches on `#[cfg(not(windows))]` vs
 * `#[cfg(windows)]` inside each command.
 */
const INSTALL_COMMAND: Record<CodingTool, string> = {
  claude: "install_claude_code",
  codex: "install_codex",
};

/**
 * Official installer URL per tool for the manual-download fallback. If HQ
 * can't install the tool (antivirus, permission, offline), the user gets
 * a one-click link to the official page and finishes it themselves.
 */
const DOWNLOAD_URL: Record<CodingTool, string> = {
  claude: "https://claude.com/download",
  codex: "https://developers.openai.com/codex/cli",
};

/**
 * The four callbacks SetupInstallGuide expects, plus the download URL lookup.
 * Match the `installGuide` prop shape on SetupIncompleteCard exactly.
 *
 * `onopenassistant` is the install-via-assistant path: hand a validated
 * `claude://` or `codex://` URL to the OS URL dispatcher through the
 * scheme-scoped Tauri command. Every URL is built in the renderer from a
 * fixed prompt constant (`INSTALL_VIA_CLAUDE_PROMPT` /
 * `INSTALL_VIA_CHATGPT_PROMPT` in `packages/ui/src/install-choice`); no
 * server text ever contributes.
 */
export interface SetupInstallGuideCallbacks {
  oninstall(tool: CodingTool): Promise<InstallOutcome>;
  /**
   * Start the tool's own browser sign-in and resolve once it has FINISHED:
   * ok:true when the tool reports signed in, ok:false with a plain reason when
   * it failed, timed out or was cancelled. The host's start command answers
   * "waiting" straight away; that is not a failure, so this keeps asking
   * `agent_provider_login_status` until the answer changes.
   */
  onsignin(tool: CodingTool, options?: SignInOptions): Promise<InstallOutcome>;
  /**
   * Is this tool already signed in on this computer? Never starts a sign-in
   * and never throws: anything but a clear "connected" reads as false.
   */
  onstatus(tool: CodingTool): Promise<boolean>;
  /** Stop a sign-in the host is waiting on, so a fresh one can start. */
  oncancelsignin(tool: CodingTool): Promise<void>;
  onrefresh(): Promise<void>;
  downloadUrlFor(tool: CodingTool): string;
  onopen(url: string): Promise<InstallOutcome>;
  onopenassistant(assistant: AssistantId, url: string): Promise<InstallOutcome>;
}

/**
 * Minimal injected surface so the adapter is testable in isolation. The
 * production caller passes `{ invoke, openUrl }` from `@tauri-apps/api/core`
 * and `@tauri-apps/plugin-shell` respectively.
 */
export interface InstallGuideDeps {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  openUrl(url: string): Promise<unknown>;
  /** Wait between status checks. Tests pass a fast one. */
  sleep?(ms: number): Promise<void>;
  /** Poll cadence and overall deadline for one sign-in (tests shorten them). */
  signInPollMs?: number;
  signInDeadlineMs?: number;
}

interface LoginStateWire {
  state: "connected" | "disconnected" | "pending" | "error" | string;
  message?: string | null;
}

/**
 * Turn a Rust install failure into a plain-language reason. The install-deps
 * commands return `Err(String)` today, and that string sometimes contains an
 * npm exit code, a Windows path, or a shell fragment. Surface those verbatim
 * and a non-technical person reads them as gibberish — the Windows test
 * persona had already flagged the raw wording as intimidating. Prefer a
 * plain sentence per known signal, fall back to a generic sentence
 * otherwise, and log the raw text so support can still find it.
 *
 * Kept exported for the pure test in `install-guide-adapter.test.ts`.
 */
export function installFailureReason(err: unknown, tool: CodingTool): string {
  const label = tool === "codex" ? "Codex" : "Claude Code";
  const raw = normalizeErrString(err);
  if (raw) console.warn(`[hq-desktop] install ${tool} failed:`, raw);
  const plain = classifyInstallFailure(raw, label);
  if (plain) return plain;
  return `HQ couldn't finish installing ${label}. You can try again or install ${label} yourself, then click Check again.`;
}

function normalizeErrString(err: unknown): string {
  if (err instanceof Error && err.message) return err.message.trim();
  if (typeof err === "string") return err.trim();
  return "";
}

/**
 * Recognise a few known failure modes and map them to plain sentences. The
 * point is defence, not exhaustive coverage: anything not recognised falls
 * back to the generic sentence in `installFailureReason` rather than leaking
 * raw text. Kept as a pure function so a unit test can pin each mapping.
 */
export function classifyInstallFailure(
  raw: string,
  label: string,
): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  // Network / offline
  if (
    lower.includes("network") ||
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("dns")
  ) {
    return `HQ couldn't reach the internet to install ${label}. Check the network and try again.`;
  }
  // Permission / admin
  if (
    lower.includes("eperm") ||
    lower.includes("eacces") ||
    lower.includes("permission denied") ||
    lower.includes("access is denied") ||
    lower.includes("administrator")
  ) {
    return `HQ needs permission to install ${label} on this computer. Try again. If a Windows prompt appears, click Yes.`;
  }
  // Antivirus / SmartScreen blocks the installer
  if (lower.includes("virus") || lower.includes("smartscreen") || lower.includes("defender")) {
    return `Antivirus on this computer blocked the ${label} installer. Allow the download, then try again.`;
  }
  // Node / npm bootstrap failure
  if (
    lower.includes("npm was not found") ||
    lower.includes("node.js") ||
    lower.includes("nodejs") ||
    lower.includes("enoent")
  ) {
    return `HQ couldn't finish installing ${label} because a required tool is missing. Try again and HQ will fetch what it needs, or you can install ${label} yourself.`;
  }
  // Disk full
  if (lower.includes("enospc") || lower.includes("no space")) {
    return `HQ ran out of disk space installing ${label}. Free up a little space and try again.`;
  }
  return null;
}

/** The host is still waiting on the browser. Older hosts said "pending". */
function isWaiting(state: LoginStateWire | null | undefined): boolean {
  return state?.state === "waiting" || state?.state === "pending";
}

/**
 * A plain sentence for a sign-in that ended without the tool signed in. The
 * host's own messages are written for this purpose ("Sign-in timed out.
 * Please retry."), so they are kept; a waiting message is never returned as
 * a failure reason, because waiting is not a failure.
 */
export function signInFailureReason(state: LoginStateWire | null | undefined, tool: CodingTool): string {
  const label = tool === "codex" ? "Codex" : "Claude Code";
  if (isWaiting(state)) {
    return `HQ stopped waiting for the ${label} sign-in. Try again when you're ready.`;
  }
  if (state?.message) return state.message;
  if (state?.state === "error") {
    return `Sign-in for ${label} did not complete.`;
  }
  return `${label} is not signed in yet.`;
}

const CANCELLED: InstallOutcome = { ok: false, reason: "Sign-in cancelled." };

/**
 * Build the four-callback shape the guide expects, calling the real Tauri
 * commands. `preferredCodingTool` and `preferredSignInTool` are passed by the
 * component - the adapter takes both directly so we cannot silently install
 * the wrong tool.
 */
export function createSetupInstallGuideCallbacks(
  deps: InstallGuideDeps,
): SetupInstallGuideCallbacks {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = deps.signInPollMs ?? SIGN_IN_POLL_MS;
  const deadlineMs = deps.signInDeadlineMs ?? SIGN_IN_DEADLINE_MS;
  return {
    async oninstall(tool: CodingTool): Promise<InstallOutcome> {
      try {
        await deps.invoke<string>(INSTALL_COMMAND[tool]);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: installFailureReason(err, tool) };
      }
    },

    async onsignin(tool: CodingTool, options: SignInOptions = {}): Promise<InstallOutcome> {
      const { signal } = options;
      let state: LoginStateWire;
      try {
        state = await deps.invoke<LoginStateWire>(
          "agent_provider_login_start",
          { tool, force: false },
        );
      } catch (err) {
        return { ok: false, reason: installFailureReason(err, tool) };
      }
      // The start command answers "waiting" as soon as the browser opens.
      // Treating that answer as the result is what showed "Sign-in did not
      // complete" while the person was still signing in: keep asking until
      // the host reports how the sign-in actually ended.
      const started = Date.now();
      while (isWaiting(state)) {
        if (signal?.aborted) return CANCELLED;
        if (Date.now() - started >= deadlineMs) break;
        await sleep(pollMs);
        if (signal?.aborted) return CANCELLED;
        try {
          state = await deps.invoke<LoginStateWire>("agent_provider_login_status", { tool });
        } catch {
          // One failed check is not the end of the sign-in; ask again.
        }
      }
      if (state && state.state === "connected") return { ok: true };
      return { ok: false, reason: signInFailureReason(state, tool) };
    },

    async onstatus(tool: CodingTool): Promise<boolean> {
      try {
        const state = await deps.invoke<LoginStateWire>("agent_provider_login_status", { tool });
        return state?.state === "connected";
      } catch {
        return false;
      }
    },

    async oncancelsignin(tool: CodingTool): Promise<void> {
      try {
        await deps.invoke("agent_provider_login_cancel", { tool });
      } catch {
        // Nothing to cancel, or the host could not: the next start reports it.
      }
    },

    async onrefresh(): Promise<void> {
      // detect_ai_tools returns a value we do not need here - the caller's
      // `shell.detectAiTools` update runs first and drives the UI; this
      // extra call keeps the Rust-side cache warm for the next probe.
      try {
        await deps.invoke("detect_ai_tools");
      } catch {
        // The Rust side is best-effort; failing here must not break the
        // guided flow (the guide already re-detected via `shell.detectAiTools`).
      }
    },

    downloadUrlFor(tool: CodingTool): string {
      return DOWNLOAD_URL[tool];
    },

    async onopen(url: string): Promise<InstallOutcome> {
      try {
        await deps.openUrl(url);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason:
            err instanceof Error && err.message
              ? err.message
              : "HQ couldn't open the download page.",
        };
      }
    },

    async onopenassistant(
      assistant: AssistantId,
      url: string,
    ): Promise<InstallOutcome> {
      const command =
        assistant === "claude-desktop"
          ? "open_claude_code_link"
          : "open_codex_deep_link";
      const label =
        assistant === "claude-desktop" ? "Claude" : "ChatGPT";
      try {
        await deps.invoke<void>(command, { url });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason:
            err instanceof Error && err.message
              ? err.message
              : typeof err === "string" && err.trim()
                ? err.trim()
                : `HQ couldn't open ${label} on this computer.`,
        };
      }
    },
  };
}
