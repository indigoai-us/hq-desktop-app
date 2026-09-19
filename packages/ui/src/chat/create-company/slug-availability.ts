/**
 * Live company-handle availability for the create-company step.
 *
 * The server owns the rule. `GET /v1/companies/slug-available` answers with
 * the SAME format check and availability query the create submit runs, and
 * publishes the format rule as `constraints` — which the `create_company` card
 * now carries on its slug field too. Nothing here invents a regex: the local
 * check compiles the server's own pattern, and with no constraints in hand it
 * simply does not pre-judge the value.
 *
 * Headless and zero-Svelte so every state is unit-testable: the watcher takes
 * a check function, a debounce, and a timer seam, and pushes state out.
 *
 * The answer is ADVISORY. A handle can be claimed between the check and the
 * submit, so create still decides — a green "available" never means the submit
 * is guaranteed.
 */

export const SLUG_CHECK_DEBOUNCE_MS = 300;

export interface SlugConstraints {
  pattern: string;
  minLength: number;
  maxLength: number;
  description: string;
}

/** The route's answer, as far as this layer cares about it. */
export interface SlugAvailabilityAnswer {
  valid: boolean;
  available: boolean;
  normalized: string;
  suggestion: string | null;
  reasons: string[];
  constraints: SlugConstraints | null;
}

export type SlugCheckFn = (slug: string) => Promise<unknown>;

export type SlugStatus =
  | "idle"
  | "checking"
  | "available"
  | "taken"
  | "invalid"
  /** The check itself failed. Never blocks creating — the server still decides. */
  | "unknown";

export interface SlugState {
  status: SlugStatus;
  /** The raw value this state describes. */
  value: string;
  /** What the server would use. Empty until something has been checked. */
  normalized: string;
  /** One line for the status row. Empty for idle. */
  message: string;
  /** A free handle the person can accept in one click. */
  suggestion: string | null;
}

export const SLUG_IDLE: SlugState = {
  status: "idle",
  value: "",
  normalized: "",
  message: "",
  suggestion: null,
};

/** Create is blocked while we are still checking, or on a known-bad handle. */
export function slugBlocksSubmit(state: SlugState): boolean {
  return (
    state.status === "checking" ||
    state.status === "taken" ||
    state.status === "invalid"
  );
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseConstraints(raw: unknown): SlugConstraints | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const pattern = asString(row.pattern);
  if (!pattern) return null;
  if (typeof row.minLength !== "number" || typeof row.maxLength !== "number") {
    return null;
  }
  return {
    pattern,
    minLength: row.minLength,
    maxLength: row.maxLength,
    description: asString(row.description),
  };
}

/**
 * Read the route's answer. A payload that is not the shape we expect returns
 * null rather than a half-trusted verdict — the caller shows "couldn't check"
 * instead of a confident wrong answer.
 */
export function parseSlugAvailability(
  raw: unknown,
): SlugAvailabilityAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.valid !== "boolean" || typeof row.available !== "boolean") {
    return null;
  }
  const reasons = Array.isArray(row.reasons)
    ? row.reasons.filter((r): r is string => typeof r === "string")
    : [];
  return {
    valid: row.valid,
    available: row.available,
    normalized: asString(row.normalized),
    suggestion: asString(row.suggestion) || null,
    reasons,
    constraints: parseConstraints(row.constraints),
  };
}

const REASON_TEXT: Record<string, string> = {
  empty: "Pick a handle.",
  too_long: "That handle is too long.",
  must_start_with_lowercase_letter: "A handle has to start with a letter.",
  invalid_characters:
    "Use lowercase letters, numbers, and hyphens — nothing else.",
  taken: "That handle is taken.",
};

/**
 * One plain line for the status row. Every reason the server sent is named, so
 * a person is never told "invalid" without being told what to change.
 */
export function slugInvalidMessage(
  reasons: readonly string[],
  constraints: SlugConstraints | null,
): string {
  const known = reasons.map((reason) => REASON_TEXT[reason]).filter(Boolean);
  if (known.length > 0) return known.join(" ");
  if (constraints?.description) return constraints.description;
  return "That handle won't work.";
}

/** Local format check against the SERVER's published pattern. */
export function localSlugProblem(
  value: string,
  constraints: SlugConstraints | null,
): string[] | null {
  if (!constraints) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  let rule: RegExp;
  try {
    rule = new RegExp(constraints.pattern);
  } catch {
    // A pattern this runtime cannot compile is not a reason to reject the
    // person's handle — fall through and let the server answer.
    return null;
  }
  if (rule.test(normalized)) return null;
  // Mirrors the reasons the server derives, so a locally-rejected handle reads
  // the same as a server-rejected one.
  const reasons: string[] = [];
  if (normalized.length > constraints.maxLength) reasons.push("too_long");
  if (!/^[a-z]/.test(normalized)) {
    reasons.push("must_start_with_lowercase_letter");
  }
  if (!/^[a-z0-9-]*$/.test(normalized)) reasons.push("invalid_characters");
  if (reasons.length === 0) reasons.push("invalid_characters");
  return reasons;
}

export interface SlugWatcherOptions {
  /** Calls the route. Rejects are reported as "couldn't check", never as taken. */
  check: SlugCheckFn;
  onstate: (state: SlugState) => void;
  /** The rule the card published, when it did. Updated as answers arrive. */
  constraints?: SlugConstraints | null;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Where a failed check is reported. Defaults to console.error. */
  onerror?: (err: unknown) => void;
}

export interface SlugWatcher {
  /** The person typed. Debounces, then checks. */
  input(value: string): void;
  /** Drop any pending check and go quiet (step closed, value accepted). */
  cancel(): void;
  /** The most recent constraints, card-published or route-published. */
  constraints(): SlugConstraints | null;
}

/**
 * Debounced checker with a stale-response guard.
 *
 * Every input takes a sequence number. An answer is applied only when its
 * sequence is still the latest, so a slow answer for "acm" can never overwrite
 * the state of "acme" — the classic typeahead flicker.
 */
export function createSlugWatcher(options: SlugWatcherOptions): SlugWatcher {
  const debounceMs = options.debounceMs ?? SLUG_CHECK_DEBOUNCE_MS;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const onerror =
    options.onerror ??
    ((err: unknown) => {
      console.error("[create-company] handle check failed", err);
    });

  let constraints = options.constraints ?? null;
  let seq = 0;
  let timer: unknown = null;

  function stopTimer(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function emit(state: SlugState): void {
    options.onstate(state);
  }

  async function run(value: string, mySeq: number): Promise<void> {
    let answer: SlugAvailabilityAnswer | null = null;
    try {
      answer = parseSlugAvailability(await options.check(value));
    } catch (err) {
      onerror(err);
      if (mySeq !== seq) return;
      emit({
        status: "unknown",
        value,
        normalized: value.trim(),
        message: "Couldn't check that handle — you can still create.",
        suggestion: null,
      });
      return;
    }
    // A late answer for an older value never wins.
    if (mySeq !== seq) return;
    if (!answer) {
      onerror(new Error("Unreadable handle-availability answer"));
      emit({
        status: "unknown",
        value,
        normalized: value.trim(),
        message: "Couldn't check that handle — you can still create.",
        suggestion: null,
      });
      return;
    }
    if (answer.constraints) constraints = answer.constraints;
    const normalized = answer.normalized || value.trim();
    if (!answer.valid) {
      emit({
        status: "invalid",
        value,
        normalized,
        message: slugInvalidMessage(answer.reasons, constraints),
        suggestion: null,
      });
      return;
    }
    if (!answer.available) {
      emit({
        status: "taken",
        value,
        normalized,
        message: answer.suggestion
          ? `${normalized} is taken.`
          : "That handle is taken.",
        suggestion: answer.suggestion,
      });
      return;
    }
    emit({
      status: "available",
      value,
      normalized,
      message: `${normalized} is available.`,
      suggestion: null,
    });
  }

  return {
    input(value: string) {
      seq += 1;
      const mySeq = seq;
      stopTimer();

      if (value.trim().length === 0) {
        emit({ ...SLUG_IDLE, value });
        return;
      }

      const local = localSlugProblem(value, constraints);
      if (local) {
        // Known-bad format never costs a round trip.
        emit({
          status: "invalid",
          value,
          normalized: value.trim(),
          message: slugInvalidMessage(local, constraints),
          suggestion: null,
        });
        return;
      }

      emit({
        status: "checking",
        value,
        normalized: value.trim(),
        message: "Checking…",
        suggestion: null,
      });
      timer = setTimer(() => {
        timer = null;
        void run(value, mySeq);
      }, debounceMs);
    },
    cancel() {
      seq += 1;
      stopTimer();
    },
    constraints() {
      return constraints;
    },
  };
}
