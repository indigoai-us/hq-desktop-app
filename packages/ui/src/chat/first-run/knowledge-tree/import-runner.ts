/**
 * Runs the context scan for the first-run "Bring in your context" step: one
 * scan at a time, stamped on the scene clock, cancellable, and always
 * ending in a state the screen can show (never a hang).
 *
 * The host (the desktop app) supplies `ImportScanHost`: it spawns
 * `hq import scan --json --stream`, forwards each validated line, and
 * resolves when the scan ends. Everything else is here and pure enough to
 * test with a fake host.
 */

import { SCANNER_OUTDATED, SCANNER_SOURCE, isScanNotRun, parseScanLine, type ScanEvent } from "./scan-stream.js";
import type { TimedScanEvent } from "./scene-model.js";

/** How a scan ended, as the host reports it ("no_hq": there is no HQ folder to read). */
export type ImportScanEndStatus = "done" | "failed" | "cancelled" | "timeout" | "unavailable" | "no_hq";

export interface ImportScanEnd {
  status: ImportScanEndStatus;
}

export interface ImportScanHost {
  /**
   * Start a scan. `onevent` gets every line the host forwarded (an object, or
   * text in tests). Resolves when the scan has ended, however it ended.
   */
  run(scanId: string, onevent: (raw: unknown) => void): Promise<ImportScanEnd | null | undefined>;
  /** Stop a running scan. Safe to call for a scan that already ended. */
  cancel(scanId: string): Promise<unknown> | void;
}

export type ImportPhase = "idle" | "running" | "done" | "failed" | "skipped";

export interface ImportRunView {
  phase: ImportPhase;
  /** Scene second the scan started; null when idle or skipped. */
  scanStart: number | null;
  events: readonly TimedScanEvent[];
  /** `retry: false` when running again cannot help (HQ needs an update first). */
  failure: ImportFailure | null;
}

export interface ImportFailure {
  at: number;
  message: string;
  retry: boolean;
}

export const IMPORT_COPY = {
  failed: "Couldn't finish reading this Mac.",
  timeout: "Reading this Mac took too long.",
  /** An hq without the scan, or an HQ whose scanner is too old. */
  update: "Update HQ to bring in your context.",
  noHq: "HQ isn't set up on this Mac yet.",
} as const;

/**
 * hq-cli's own failure ("error" from source "scanner", then a "done" with no
 * report) asks for an update when the scanner is missing or too old: the
 * `scanner_outdated` code says so, and older CLIs only say "update HQ" in
 * the message. Only that case is told apart, so the screen can say what to do.
 */
function scannerFailureCopy(error: { message: string; code: string | null } | null): string {
  if (!error) return IMPORT_COPY.failed;
  if (error.code === SCANNER_OUTDATED) return IMPORT_COPY.update;
  if (error.code === null && /\bupdate hq\b/i.test(error.message)) return IMPORT_COPY.update;
  return IMPORT_COPY.failed;
}

/** The screen gives up on a scan the host never ends (the host's own bound is 5 minutes). */
export const IMPORT_UI_TIMEOUT_MS = 6 * 60 * 1000;
/** Events kept per scan; a runaway stream stops adding to the scene past this. */
export const MAX_SCAN_EVENTS = 5000;

export interface ImportRunner {
  /** Start a scan, unless one is running or finished. Shows "running" at once. */
  start(): void;
  /** Run again after a failure (not after "Update HQ", where it cannot help). */
  retry(): void;
  /** Scan once more after any failure, "Update HQ" included ("Check again"). */
  recheck(): void;
  /** Stop a running scan; the step goes back to asking. */
  cancel(): void;
  /** "Skip for now". */
  skip(): void;
  current(): ImportRunView;
  dispose(): void;
}

/** What a finished scan hands to the setup bot: counts and the report path, never contents. */
export interface ImportResult {
  summary: Record<string, number>;
  report: string | null;
}

/**
 * The result of a finished scan: the "done" line's summary, or (when the CLI
 * sent none) the companies, projects and per-key counts the stream carried.
 * Null until the scan is done.
 */
export function importResultOf(events: readonly TimedScanEvent[]): ImportResult | null {
  const done = events.find((e) => e.event.type === "done")?.event;
  if (!done || done.type !== "done" || isScanNotRun(done)) return null;
  if (Object.keys(done.summary).length) return { summary: { ...done.summary }, report: done.report };
  const companies = new Set<string>();
  const projects = new Set<string>();
  const latest = new Map<string, number>();
  for (const { event } of events) {
    if (event.type === "company") companies.add(event.id);
    else if (event.type === "project") projects.add(event.id);
    else if (event.type === "count") latest.set(`${event.source}\u0000${event.key}`, Math.max(event.value, latest.get(`${event.source}\u0000${event.key}`) ?? 0));
    else if (event.type === "source" && event.counts) {
      for (const [key, value] of Object.entries(event.counts)) {
        latest.set(`${event.id}\u0000${key}`, Math.max(value, latest.get(`${event.id}\u0000${key}`) ?? 0));
      }
    }
  }
  const summary: Record<string, number> = { companies: companies.size, projects: projects.size };
  for (const [k, v] of latest) {
    const key = k.split("\u0000")[1] ?? k;
    if (key === "companies" || key === "projects") continue;
    summary[key] = (summary[key] ?? 0) + v;
  }
  return { summary, report: done.report };
}

let scanCounter = 0;
function newScanId(): string {
  scanCounter += 1;
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return c?.randomUUID ? c.randomUUID() : `scan-${Date.now().toString(36)}-${scanCounter}`;
}

/** `error` lines still kept once `MAX_SCAN_EVENTS` is reached; `done` always is. */
const ERROR_EVENTS_PAST_CAP = 64;

/** Run `fn` on the next frame; returns a way to call it off. */
export type FrameScheduler = (fn: () => void) => () => void;

const nextFrame: FrameScheduler = (fn) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(() => fn());
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
};

export function createImportRunner(
  host: ImportScanHost | null,
  now: () => number,
  onchange: (view: ImportRunView) => void,
  opts: {
    timeoutMs?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    /** When batched lines reach the screen (default: the next animation frame). */
    schedule?: FrameScheduler;
  } = {},
): ImportRunner {
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const schedule = opts.schedule ?? nextFrame;
  const timeoutMs = opts.timeoutMs ?? IMPORT_UI_TIMEOUT_MS;
  let view: ImportRunView = { phase: "idle", scanStart: null, events: [], failure: null };
  let active: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sawDone = false;
  let scannerError: { message: string; code: string | null } | null = null;
  let disposed = false;
  /** Lines stamped on arrival, waiting for the next frame (one copy per frame, not per line). */
  let pending: TimedScanEvent[] = [];
  let unschedule: (() => void) | null = null;

  const set = (next: ImportRunView) => {
    view = next;
    if (!disposed) onchange(view);
  };
  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const dropPending = () => {
    unschedule?.();
    unschedule = null;
    pending = [];
  };
  const flush = () => {
    unschedule?.();
    unschedule = null;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    set({ ...view, events: view.events.concat(batch) });
  };
  const fail = (scanId: string, message: string, retry = true) => {
    if (active !== scanId) return;
    flush();
    active = null;
    stopTimer();
    set({ ...view, phase: "failed", failure: { at: now(), message, retry } });
  };
  const finish = (scanId: string) => {
    if (active !== scanId) return;
    flush();
    active = null;
    stopTimer();
    set({ ...view, phase: "done" });
  };

  function start(): void {
    if (disposed || active !== null || view.phase === "running" || view.phase === "done") return;
    const scanId = newScanId();
    active = scanId;
    sawDone = false;
    scannerError = null;
    dropPending();
    set({ phase: "running", scanStart: now(), events: [], failure: null });
    if (!host) {
      fail(scanId, IMPORT_COPY.update, false);
      return;
    }
    timer = setTimer(() => {
      void Promise.resolve(host.cancel(scanId)).catch(() => undefined);
      fail(scanId, IMPORT_COPY.timeout);
    }, timeoutMs);
    const onevent = (raw: unknown) => {
      if (active !== scanId || sawDone) return;
      const event: ScanEvent | null = parseScanLine(raw);
      if (!event) return;
      // The cap holds back progress lines only: `done` always lands, so a very
      // large HQ still finishes, and a few `error` lines still say why.
      const stored = view.events.length + pending.length;
      if (event.type !== "done" && stored >= MAX_SCAN_EVENTS) {
        if (event.type !== "error" || stored >= MAX_SCAN_EVENTS + ERROR_EVENTS_PAST_CAP) return;
      }
      if (event.type === "error" && event.source === SCANNER_SOURCE) {
        scannerError ??= { message: event.message, code: event.code };
      }
      pending.push({ at: now(), event });
      if (event.type !== "done") {
        unschedule ??= schedule(flush);
        return;
      }
      sawDone = true;
      flush();
      if (isScanNotRun(event)) {
        const copy = scannerFailureCopy(scannerError);
        fail(scanId, copy, copy !== IMPORT_COPY.update);
      } else finish(scanId);
    };
    let run: Promise<ImportScanEnd | null | undefined>;
    try {
      run = Promise.resolve(host.run(scanId, onevent));
    } catch {
      run = Promise.resolve({ status: "failed" as const });
    }
    run.then(
      (end) => {
        // Not ours any more (cancelled, skipped or restarted here): nothing to do.
        if (active !== scanId) return;
        if (sawDone) return finish(scanId);
        // Any other end, including a "cancelled" this screen did not ask for
        // (another window took the scan), is a failure the person can retry.
        switch (end?.status) {
          case "timeout":
            return fail(scanId, IMPORT_COPY.timeout);
          case "unavailable":
            return fail(scanId, IMPORT_COPY.update, false);
          case "no_hq":
            return fail(scanId, IMPORT_COPY.noHq);
          default:
            return fail(scanId, IMPORT_COPY.failed);
        }
      },
      () => fail(scanId, IMPORT_COPY.failed),
    );
  }

  return {
    start,
    retry() {
      if (view.phase === "failed" && view.failure?.retry !== false) {
        view = { ...view, phase: "idle" };
        start();
      }
    },
    recheck() {
      // "Check again" after "Update HQ": the person may have updated HQ since.
      if (view.phase === "failed") {
        view = { ...view, phase: "idle" };
        start();
      }
    },
    cancel() {
      const scanId = active;
      if (scanId === null) return;
      active = null;
      stopTimer();
      dropPending();
      set({ phase: "idle", scanStart: null, events: [], failure: null });
      if (host) void Promise.resolve(host.cancel(scanId)).catch(() => undefined);
    },
    skip() {
      if (view.phase === "done") return;
      const scanId = active;
      active = null;
      stopTimer();
      dropPending();
      if (scanId !== null && host) void Promise.resolve(host.cancel(scanId)).catch(() => undefined);
      set({ phase: "skipped", scanStart: null, events: [], failure: null });
    },
    current: () => view,
    dispose() {
      if (active !== null && host) {
        const scanId = active;
        void Promise.resolve(host.cancel(scanId)).catch(() => undefined);
      }
      active = null;
      stopTimer();
      dropPending();
      disposed = true;
    },
  };
}
