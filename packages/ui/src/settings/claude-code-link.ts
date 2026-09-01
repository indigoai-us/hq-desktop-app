/**
 * Claude Code deep-link builder.
 *
 * The Claude Code desktop app registers `claude://code/new` as a deep link
 * for opening a new session, taking:
 *
 *   * `q`      — optional prefilled user prompt (the "question" / first
 *                message). Omitted when the caller wants a plain workspace
 *                launch with no composer text.
 *   * `folder` — absolute path to the working directory for the session.
 *
 * This is the same shape `Popover::fixHqCliUpdateInHq` already uses for the
 * "Fix this in HQ" CTA on the hq-cli auto-update banner; the keys + path
 * (`claude://code/new`) must match — Claude Code does NOT recognise the
 * `claude://open?cwd=...&prompt=...` shape (verified against current Claude
 * Code docs + the existing call site).
 *
 * Dispatch goes through the host's dedicated open-claude-code-link command
 * (`adapter.shell.openClaudeCodeLink`), not a generic external-open — the dedicated command keeps the surface tight (rejects non-
 * `claude://` URLs) so we don't have to widen `shell:allow-open` to the
 * world. See `OpenInClaudeCodeButton.svelte` for the call site.
 *
 * Kept pure and side-effect-free so the URL shape can be unit-tested in
 * isolation. A failing test here is the early-warning that the wire
 * contract has drifted from what Claude Code accepts.
 */

export interface ClaudeCodeLinkInput {
  /** Absolute path the Claude Code session should `cwd` into. Typically the
   *  HQ folder root from `get_config`'s `hqFolderPath`. Maps to the
   *  `folder` URL parameter. */
  folder: string;
  /** Optional prefilled prompt text. Multi-line is fine — `URLSearchParams`
   *  handles encoding. Maps to the `q` URL parameter. Empty / undefined
   *  omits `q` so Claude Code opens the folder without a first message. */
  prompt?: string;
}

/**
 * Build a `claude://code/new?q=…&folder=…` URL. Values are encoded by
 * `URLSearchParams` (which is what the existing `fixHqCliUpdateInHq` call
 * site uses — keep the two in sync).
 *
 * `folder` is omitted from the query when empty so the URL still parses
 * cleanly if the caller hasn't loaded `hqFolderPath` yet. The button
 * suppresses itself in that case, but defending the URL builder is cheap.
 *
 * `q` is omitted when `prompt` is empty or undefined. Existing call sites
 * that pass a prompt keep the previous `q=` shape; the title-bar Launch
 * menu relies on the omit path so a plain session does not pre-type
 * `/setup`.
 */
export function buildClaudeCodeUrl({
  folder,
  prompt,
}: ClaudeCodeLinkInput): string {
  const params = new URLSearchParams();
  if (prompt?.trim()) params.set("q", prompt);
  if (folder) params.set("folder", folder);
  const query = params.toString();
  return query ? `claude://code/new?${query}` : "claude://code/new";
}
