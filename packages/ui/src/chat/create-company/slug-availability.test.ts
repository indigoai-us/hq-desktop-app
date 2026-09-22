/**
 * Live handle availability: every state, the debounce, the stale-response
 * guard, and the local format check driven by the server's published rule.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createSlugWatcher,
  localSlugProblem,
  parseSlugAvailability,
  slugBlocksSubmit,
  slugInvalidMessage,
  SLUG_IDLE,
  type SlugConstraints,
  type SlugState,
} from "./slug-availability.js";

const CONSTRAINTS: SlugConstraints = {
  pattern: "^[a-z][a-z0-9-]{0,29}$",
  minLength: 1,
  maxLength: 30,
  description: "Lowercase letters, numbers and hyphens, starting with a letter.",
};

/** A manual clock so the debounce is exercised without real timers. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    /** Fire every timer currently queued. */
    flush() {
      const queued = [...pending.entries()];
      pending.clear();
      for (const [, fn] of queued) fn();
    },
    pendingCount: () => pending.size,
  };
}

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    valid: true,
    available: true,
    normalized: "acme",
    constraints: CONSTRAINTS,
    ...over,
  };
}

function harness(
  check: (slug: string) => Promise<unknown>,
  constraints: SlugConstraints | null = CONSTRAINTS,
) {
  const timers = fakeTimers();
  const states: SlugState[] = [];
  const errors: unknown[] = [];
  const watcher = createSlugWatcher({
    check,
    constraints,
    onstate: (state) => states.push(state),
    onerror: (err) => errors.push(err),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    debounceMs: 300,
  });
  return { watcher, states, errors, timers, last: () => states[states.length - 1]! };
}

describe("parseSlugAvailability", () => {
  it("reads a well-formed answer", () => {
    const parsed = parseSlugAvailability(
      answer({ available: false, suggestion: "acme-2", reasons: ["taken"] }),
    );
    expect(parsed).toMatchObject({
      valid: true,
      available: false,
      normalized: "acme",
      suggestion: "acme-2",
      reasons: ["taken"],
    });
    expect(parsed?.constraints).toEqual(CONSTRAINTS);
  });

  it("refuses a payload that is not the shape we expect", () => {
    expect(parseSlugAvailability(null)).toBeNull();
    expect(parseSlugAvailability({ valid: "yes" })).toBeNull();
    expect(parseSlugAvailability({ valid: true })).toBeNull();
  });
});

describe("localSlugProblem", () => {
  it("accepts a handle the server's own pattern accepts", () => {
    expect(localSlugProblem("acme-1", CONSTRAINTS)).toBeNull();
  });

  it("names what is wrong", () => {
    expect(localSlugProblem("1acme", CONSTRAINTS)).toContain(
      "must_start_with_lowercase_letter",
    );
    expect(localSlugProblem("Acme", CONSTRAINTS)).toContain(
      "must_start_with_lowercase_letter",
    );
    expect(localSlugProblem("a b", CONSTRAINTS)).toContain("invalid_characters");
    expect(localSlugProblem("a".repeat(40), CONSTRAINTS)).toContain("too_long");
  });

  it("pre-judges nothing without a published rule", () => {
    expect(localSlugProblem("NOPE!", null)).toBeNull();
  });

  it("pre-judges nothing when the pattern will not compile", () => {
    expect(localSlugProblem("acme", { ...CONSTRAINTS, pattern: "([" })).toBeNull();
  });
});

describe("slugInvalidMessage", () => {
  it("names every reason the server sent", () => {
    const message = slugInvalidMessage(
      ["too_long", "invalid_characters"],
      CONSTRAINTS,
    );
    expect(message).toContain("too long");
    expect(message).toContain("lowercase letters");
  });

  it("falls back to the published description for an unknown reason", () => {
    expect(slugInvalidMessage(["something_new"], CONSTRAINTS)).toBe(
      CONSTRAINTS.description,
    );
  });
});

describe("createSlugWatcher", () => {
  it("goes idle on an empty value and never calls the route", async () => {
    const check = vi.fn();
    const h = harness(check);
    h.watcher.input("   ");
    expect(h.last()).toMatchObject({ status: "idle", message: "" });
    expect(check).not.toHaveBeenCalled();
  });

  it("shows checking, then available", async () => {
    const check = vi.fn(async () => answer());
    const h = harness(check);
    h.watcher.input("acme");
    expect(h.last().status).toBe("checking");
    expect(check).not.toHaveBeenCalled();
    h.timers.flush();
    await vi.waitFor(() => expect(h.last().status).toBe("available"));
    expect(h.last().message).toBe("acme is available.");
    expect(check).toHaveBeenCalledWith("acme");
  });

  it("shows taken with the suggestion the server offered", async () => {
    const check = vi.fn(async () =>
      answer({ available: false, reasons: ["taken"], suggestion: "acme-2" }),
    );
    const h = harness(check);
    h.watcher.input("acme");
    h.timers.flush();
    await vi.waitFor(() => expect(h.last().status).toBe("taken"));
    expect(h.last().suggestion).toBe("acme-2");
  });

  it("shows invalid with the server's reason", async () => {
    const check = vi.fn(async () =>
      answer({ valid: false, available: false, reasons: ["too_long"] }),
    );
    const h = harness(check, null);
    h.watcher.input("acme");
    h.timers.flush();
    await vi.waitFor(() => expect(h.last().status).toBe("invalid"));
    expect(h.last().message).toContain("too long");
  });

  it("rejects a known-bad handle locally, with no round trip", () => {
    const check = vi.fn();
    const h = harness(check);
    h.watcher.input("Acme!");
    expect(h.last().status).toBe("invalid");
    expect(check).not.toHaveBeenCalled();
    expect(h.timers.pendingCount()).toBe(0);
  });

  it("reports a failed check as couldn't-check, logged, and does not block", async () => {
    const boom = new Error("network down");
    const h = harness(async () => {
      throw boom;
    });
    h.watcher.input("acme");
    h.timers.flush();
    await vi.waitFor(() => expect(h.last().status).toBe("unknown"));
    expect(h.errors).toContain(boom);
    expect(slugBlocksSubmit(h.last())).toBe(false);
  });

  it("treats an unreadable answer as couldn't-check, not as a verdict", async () => {
    const h = harness(async () => ({ nonsense: true }));
    h.watcher.input("acme");
    h.timers.flush();
    await vi.waitFor(() => expect(h.last().status).toBe("unknown"));
    expect(h.errors).toHaveLength(1);
  });

  it("debounces: one keystroke burst, one call", async () => {
    const check = vi.fn(async () => answer());
    const h = harness(check);
    h.watcher.input("a");
    h.watcher.input("ac");
    h.watcher.input("acme");
    expect(h.timers.pendingCount()).toBe(1);
    h.timers.flush();
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(check).toHaveBeenCalledWith("acme");
  });

  it("never lets a late answer for an older value win", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const check = vi.fn(
      (slug: string) =>
        new Promise<unknown>((resolve) => {
          resolvers.push((value) => resolve(value));
          void slug;
        }),
    );
    const h = harness(check);

    h.watcher.input("acm");
    h.timers.flush();
    h.watcher.input("acme");
    h.timers.flush();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    // The newer value answers first, then the stale one arrives.
    resolvers[1]!(answer({ normalized: "acme", available: true }));
    await vi.waitFor(() => expect(h.last().status).toBe("available"));
    resolvers[0]!(
      answer({ normalized: "acm", available: false, reasons: ["taken"] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.last()).toMatchObject({ status: "available", normalized: "acme" });
  });

  it("cancel drops a pending check and its answer", async () => {
    let resolve: ((value: unknown) => void) | null = null;
    const check = vi.fn(
      () => new Promise<unknown>((r) => { resolve = r; }),
    );
    const h = harness(check);
    h.watcher.input("acme");
    h.timers.flush();
    await vi.waitFor(() => expect(resolve).not.toBeNull());
    const before = h.states.length;
    h.watcher.cancel();
    resolve!(answer({ available: false, reasons: ["taken"] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.states.length).toBe(before);
  });

  it("adopts constraints the route published, for the next local check", async () => {
    const h = harness(async () => answer(), null);
    h.watcher.input("acme");
    h.timers.flush();
    await vi.waitFor(() => expect(h.last().status).toBe("available"));
    expect(h.watcher.constraints()).toEqual(CONSTRAINTS);
    h.watcher.input("Acme!");
    expect(h.last().status).toBe("invalid");
  });
});

describe("slugBlocksSubmit", () => {
  it("blocks while checking, taken, or invalid", () => {
    for (const status of ["checking", "taken", "invalid"] as const) {
      expect(slugBlocksSubmit({ ...SLUG_IDLE, status })).toBe(true);
    }
  });

  it("does not block on idle, available, or couldn't-check", () => {
    for (const status of ["idle", "available", "unknown"] as const) {
      expect(slugBlocksSubmit({ ...SLUG_IDLE, status })).toBe(false);
    }
  });
});
