/**
 * First-run timing lines in the hq-sync log (`~/.hq/logs/hq-sync.log`).
 *
 * Every line uses the `first-run` tag and space-separated `key=value` pairs,
 * after the usual logfile timestamp prefix:
 *
 * ```text
 * [first-run] kind=screen event=enter surface=<welcome|takeover> id=<step id>
 * [first-run] kind=screen event=leave surface=<welcome|takeover> id=<step id> elapsed_ms=<n>
 * [first-run] kind=install event=start id=<item>
 * [first-run] kind=install event=end id=<item> outcome=<ok|failed|skipped|cancelled> elapsed_ms=<n>
 * [first-run] kind=probe tool=<claude|codex|...> result=<passed|signed-out|failed|timeout> elapsed_ms=<n>
 * [first-run] kind=phase phase=<blocking> result=<ok|failed> elapsed_ms=<n since launch> (logged from Rust)
 * ```
 *
 * Install ids: node, git, hq-cli, qmd, claude-code, codex, gh, yq, jq (logged
 * from Rust, `apps/sync/src-tauri/src/first_run_timing.rs`), and content,
 * initial-sync, indexing (logged from the renderer with this module). Screen
 * and probe lines also come from here. Values never contain whitespace or `=`:
 * both are replaced with `_`, and an empty value becomes `unknown`, so a
 * reader can split a line on spaces and then on the first `=`.
 * `companies/indigo/projects/install-flow-rethink/scripts/first-run-timeline.sh`
 * in HQ parses these lines into a per-step table. Change the format there and
 * in the Rust module together.
 */

/** The log tag. The host writes `[first-run] <message>` with it. */
export const FIRST_RUN_TIMING_TAG = "first-run";

/** Receives one formatted message (without the tag) per timing event. */
export type FirstRunTimingSink = (message: string) => void;

export type FirstRunSurface = "welcome" | "takeover";
export type InstallOutcome = "ok" | "failed" | "skipped" | "cancelled";
export type ProbeResult = "passed" | "signed-out" | "failed" | "timeout";

/** Make a value safe for the space-separated `key=value` format. */
export function sanitizeValue(raw: string): string {
  const cleaned = raw.trim().replace(/[\s=]/g, "_");
  return cleaned === "" ? "unknown" : cleaned;
}

function ms(elapsed: number): number {
  return Math.max(0, Math.round(elapsed));
}

export function formatScreenEnter(surface: FirstRunSurface, id: string): string {
  return `kind=screen event=enter surface=${surface} id=${sanitizeValue(id)}`;
}

export function formatScreenLeave(surface: FirstRunSurface, id: string, elapsedMs: number): string {
  return `kind=screen event=leave surface=${surface} id=${sanitizeValue(id)} elapsed_ms=${ms(elapsedMs)}`;
}

export function formatInstallStart(id: string): string {
  return `kind=install event=start id=${sanitizeValue(id)}`;
}

export function formatInstallEnd(id: string, outcome: InstallOutcome, elapsedMs: number): string {
  return `kind=install event=end id=${sanitizeValue(id)} outcome=${outcome} elapsed_ms=${ms(elapsedMs)}`;
}

export function formatProbe(tool: string, result: ProbeResult, elapsedMs: number): string {
  return `kind=probe tool=${sanitizeValue(tool)} result=${result} elapsed_ms=${ms(elapsedMs)}`;
}

/** A sink that must never break the flow it measures. */
function emit(sink: FirstRunTimingSink | null | undefined, message: string): void {
  if (!sink) return;
  try {
    sink(message);
  } catch (error) {
    console.warn("[first-run] timing line could not be written", error);
  }
}

export interface ScreenTimer {
  /** The screen now on view. Leaves the previous one first; the same id twice is a no-op. */
  show(id: string): void;
  /** Leaves the current screen, if any. Later `show` calls start afresh. */
  close(): void;
}

export function createScreenTimer(
  surface: FirstRunSurface,
  sink: FirstRunTimingSink | null | undefined,
  now: () => number = () => Date.now(),
): ScreenTimer {
  let current: { id: string; since: number } | null = null;

  function close(): void {
    if (!current) return;
    emit(sink, formatScreenLeave(surface, current.id, now() - current.since));
    current = null;
  }

  return {
    show(id) {
      if (current?.id === id) return;
      close();
      current = { id, since: now() };
      emit(sink, formatScreenEnter(surface, id));
    },
    close,
  };
}

export interface InstallTimer {
  /** Logs the end line once. Later calls do nothing. */
  finish(outcome: InstallOutcome): void;
}

/** Logs the start line now and the end line on `finish`. */
export function startInstallTimer(
  id: string,
  sink: FirstRunTimingSink | null | undefined,
  now: () => number = () => Date.now(),
): InstallTimer {
  const since = now();
  let finished = false;
  emit(sink, formatInstallStart(id));
  return {
    finish(outcome) {
      if (finished) return;
      finished = true;
      emit(sink, formatInstallEnd(id, outcome, now() - since));
    },
  };
}
