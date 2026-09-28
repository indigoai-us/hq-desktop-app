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
  onsignin(tool: CodingTool): Promise<InstallOutcome>;
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
}

interface LoginStateWire {
  state: "connected" | "disconnected" | "pending" | "error" | string;
  message?: string | null;
}

/**
 * Best-effort user-friendly reason from the Rust command's error string.
 * The commands return plain `Err(String)` today; we surface it verbatim when
 * present, otherwise a short generic explanation.
 */
function installFailureReason(err: unknown, tool: CodingTool): string {
  const label = tool === "codex" ? "Codex" : "Claude Code";
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err.trim();
  return `HQ couldn't finish installing ${label}.`;
}

function signInFailureReason(state: LoginStateWire, tool: CodingTool): string {
  const label = tool === "codex" ? "Codex" : "Claude Code";
  if (state?.message) return state.message;
  if (state?.state === "error") {
    return `Sign-in for ${label} did not complete.`;
  }
  if (state?.state === "pending") {
    return `Sign-in for ${label} is still waiting in its own window.`;
  }
  return `${label} is not signed in yet.`;
}

/**
 * Build the four-callback shape the guide expects, calling the real Tauri
 * commands. `preferredCodingTool` and `preferredSignInTool` are passed by the
 * component - the adapter takes both directly so we cannot silently install
 * the wrong tool.
 */
export function createSetupInstallGuideCallbacks(
  deps: InstallGuideDeps,
): SetupInstallGuideCallbacks {
  return {
    async oninstall(tool: CodingTool): Promise<InstallOutcome> {
      try {
        await deps.invoke<string>(INSTALL_COMMAND[tool]);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: installFailureReason(err, tool) };
      }
    },

    async onsignin(tool: CodingTool): Promise<InstallOutcome> {
      try {
        const state = await deps.invoke<LoginStateWire>(
          "agent_provider_login_start",
          { tool, force: false },
        );
        if (state && state.state === "connected") {
          return { ok: true };
        }
        return { ok: false, reason: signInFailureReason(state, tool) };
      } catch (err) {
        return { ok: false, reason: installFailureReason(err, tool) };
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
