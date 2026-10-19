import { describe, expect, it } from "vitest";
import { FIRST_RUN_HANDOFF_PREFIX, parseFirstRunHandoffHint } from "./first-run-handoff.js";

// The exact string `first_run_handoff_hint(Some(true), None, true, false, None)`
// produces in `apps/sync/src-tauri/src/commands/first_run.rs`.
const RUST_HINT =
  'first-run-handoff:{"accountKind":null,"flags":{"desktop.first-run-found-apps-v1":null,"desktop.visual-first-run":true},"route":null,"welcomeSetupOwed":true,"welcomeTourShown":false}';

describe("parseFirstRunHandoffHint", () => {
  it("reads the hint Rust queues on the pending route", () => {
    expect(parseFirstRunHandoffHint(RUST_HINT)).toEqual({
      route: null,
      hint: {
        route: null,
        flags: { visualFirstRun: true, foundApps: null },
        welcomeSetupOwed: true,
        welcomeTourShown: false,
        accountKind: null,
      },
    });
  });

  it("carries a recorded returning account kind and drops anything else", () => {
    const returning = parseFirstRunHandoffHint(
      `${FIRST_RUN_HANDOFF_PREFIX}{"flags":{},"welcomeSetupOwed":true,"welcomeTourShown":false,"accountKind":"returning"}`,
    );
    expect(returning.hint?.accountKind).toBe("returning");
    const older = parseFirstRunHandoffHint(`${FIRST_RUN_HANDOFF_PREFIX}{"flags":{},"welcomeSetupOwed":true,"welcomeTourShown":false}`);
    expect(older.hint?.accountKind).toBeNull();
    const unknown = parseFirstRunHandoffHint(
      `${FIRST_RUN_HANDOFF_PREFIX}{"flags":{},"welcomeSetupOwed":true,"welcomeTourShown":false,"accountKind":"someone@example.com"}`,
    );
    expect(unknown.hint?.accountKind).toBeNull();
  });

  it("keeps a plain pending route as a route with no hint", () => {
    expect(parseFirstRunHandoffHint("messages")).toEqual({ route: "messages", hint: null });
  });

  it("returns nothing for an empty or missing value", () => {
    expect(parseFirstRunHandoffHint(null)).toEqual({ route: null, hint: null });
    expect(parseFirstRunHandoffHint("")).toEqual({ route: null, hint: null });
    expect(parseFirstRunHandoffHint(42)).toEqual({ route: null, hint: null });
  });

  it("drops a malformed hint so the shell falls back to its own reads", () => {
    expect(parseFirstRunHandoffHint(`${FIRST_RUN_HANDOFF_PREFIX}{not json`)).toEqual({ route: null, hint: null });
    expect(parseFirstRunHandoffHint(`${FIRST_RUN_HANDOFF_PREFIX}[]`)).toEqual({ route: null, hint: null });
    expect(
      parseFirstRunHandoffHint(`${FIRST_RUN_HANDOFF_PREFIX}{"flags":{},"welcomeSetupOwed":"yes","welcomeTourShown":false}`),
    ).toEqual({ route: null, hint: null });
  });

  it("treats non-boolean flags as unknown and carries a route through", () => {
    const parsed = parseFirstRunHandoffHint(
      `${FIRST_RUN_HANDOFF_PREFIX}{"route":"messages","flags":{"desktop.visual-first-run":"on","desktop.first-run-found-apps-v1":false},"welcomeSetupOwed":false,"welcomeTourShown":true}`,
    );
    expect(parsed.route).toBe("messages");
    expect(parsed.hint?.flags).toEqual({ visualFirstRun: null, foundApps: false });
  });
});
