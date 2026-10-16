import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIRST_RUN_TIMING_TAG,
  createRouteLogger,
  createScreenTimer,
  formatFlagLookup,
  formatRoute,
  formatSetupRunSet,
  formatWelcomeReport,
  formatInstallEnd,
  formatInstallStart,
  formatProbe,
  formatScreenEnter,
  formatScreenLeave,
  sanitizeValue,
  startInstallTimer,
} from "./first-run-timing.js";

// These strings are the documented format. The Rust tests in
// apps/sync/src-tauri/src/first_run_timing.rs pin the install lines to the
// same text, and first-run-timeline.sh parses them.
describe("first-run timing line format", () => {
  it("uses the first-run tag", () => {
    expect(FIRST_RUN_TIMING_TAG).toBe("first-run");
  });

  it("formats screen lines", () => {
    expect(formatScreenEnter("welcome", "welcome-signin")).toBe(
      "kind=screen event=enter surface=welcome id=welcome-signin",
    );
    expect(formatScreenLeave("takeover", "tools", 1534)).toBe(
      "kind=screen event=leave surface=takeover id=tools elapsed_ms=1534",
    );
  });

  it("formats install lines the same way the Rust side does", () => {
    expect(formatInstallStart("qmd")).toBe("kind=install event=start id=qmd");
    expect(formatInstallEnd("claude-code", "ok", 1234)).toBe(
      "kind=install event=end id=claude-code outcome=ok elapsed_ms=1234",
    );
    expect(formatInstallEnd("node", "failed", 0)).toBe(
      "kind=install event=end id=node outcome=failed elapsed_ms=0",
    );
    expect(formatInstallEnd("gh", "skipped", 7)).toBe(
      "kind=install event=end id=gh outcome=skipped elapsed_ms=7",
    );
    expect(formatInstallEnd("hq-cli", "cancelled", 9)).toBe(
      "kind=install event=end id=hq-cli outcome=cancelled elapsed_ms=9",
    );
  });

  it("formats probe lines", () => {
    expect(formatProbe("claude", "passed", 812)).toBe("kind=probe tool=claude result=passed elapsed_ms=812");
    expect(formatProbe("codex", "signed-out", 40)).toBe("kind=probe tool=codex result=signed-out elapsed_ms=40");
    expect(formatProbe("claude", "timeout", 15000)).toBe("kind=probe tool=claude result=timeout elapsed_ms=15000");
    expect(formatProbe("codex", "failed", 3)).toBe("kind=probe tool=codex result=failed elapsed_ms=3");
  });

  it("rounds elapsed time to whole milliseconds and never goes below zero", () => {
    expect(formatInstallEnd("git", "ok", 12.6)).toBe("kind=install event=end id=git outcome=ok elapsed_ms=13");
    expect(formatScreenLeave("welcome", "ready", -5)).toBe(
      "kind=screen event=leave surface=welcome id=ready elapsed_ms=0",
    );
  });

  it("keeps values free of whitespace and '='", () => {
    expect(sanitizeValue("hq cli")).toBe("hq_cli");
    expect(sanitizeValue("a=b\tc\nd")).toBe("a_b_c_d");
    expect(sanitizeValue("  ")).toBe("unknown");
    expect(sanitizeValue("")).toBe("unknown");
    expect(formatInstallStart("bad id=x")).toBe("kind=install event=start id=bad_id_x");
    expect(formatScreenEnter("welcome", "")).toBe("kind=screen event=enter surface=welcome id=unknown");
  });
});

describe("screen timer", () => {
  afterEach(() => vi.restoreAllMocks());

  function clock(start = 1000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("logs one enter and one leave per screen, with the time on screen", () => {
    const lines: string[] = [];
    const c = clock();
    const timer = createScreenTimer("takeover", (m) => lines.push(m), c.now);
    timer.show("name");
    c.advance(250);
    timer.show("team");
    c.advance(1000);
    timer.close();
    expect(lines).toEqual([
      "kind=screen event=enter surface=takeover id=name",
      "kind=screen event=leave surface=takeover id=name elapsed_ms=250",
      "kind=screen event=enter surface=takeover id=team",
      "kind=screen event=leave surface=takeover id=team elapsed_ms=1000",
    ]);
  });

  it("ignores a repeat of the screen already shown", () => {
    const lines: string[] = [];
    const timer = createScreenTimer("welcome", (m) => lines.push(m), clock().now);
    timer.show("welcome-signin");
    timer.show("welcome-signin");
    expect(lines).toEqual(["kind=screen event=enter surface=welcome id=welcome-signin"]);
  });

  it("close with nothing on screen logs nothing, and a later show starts afresh", () => {
    const lines: string[] = [];
    const c = clock();
    const timer = createScreenTimer("welcome", (m) => lines.push(m), c.now);
    timer.close();
    expect(lines).toEqual([]);
    timer.show("ready");
    timer.close();
    timer.close();
    timer.show("ready");
    expect(lines).toEqual([
      "kind=screen event=enter surface=welcome id=ready",
      "kind=screen event=leave surface=welcome id=ready elapsed_ms=0",
      "kind=screen event=enter surface=welcome id=ready",
    ]);
  });

  it("a sink that throws does not break the flow, and the error is logged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timer = createScreenTimer("welcome", () => {
      throw new Error("log is gone");
    });
    expect(() => timer.show("folder")).not.toThrow();
    expect(() => timer.close()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("works without a sink", () => {
    const timer = createScreenTimer("takeover", null);
    expect(() => {
      timer.show("tools");
      timer.close();
    }).not.toThrow();
  });
});

describe("install timer", () => {
  it("logs start at once and the end line once, with the elapsed time", () => {
    const lines: string[] = [];
    let t = 50;
    const timer = startInstallTimer("initial-sync", (m) => lines.push(m), () => t);
    expect(lines).toEqual(["kind=install event=start id=initial-sync"]);
    t += 4200;
    timer.finish("ok");
    timer.finish("failed");
    expect(lines).toEqual([
      "kind=install event=start id=initial-sync",
      "kind=install event=end id=initial-sync outcome=ok elapsed_ms=4200",
    ]);
  });

  it("records failed and cancelled outcomes", () => {
    const lines: string[] = [];
    startInstallTimer("content", (m) => lines.push(m), () => 0).finish("failed");
    startInstallTimer("indexing", (m) => lines.push(m), () => 0).finish("cancelled");
    expect(lines).toEqual([
      "kind=install event=start id=content",
      "kind=install event=end id=content outcome=failed elapsed_ms=0",
      "kind=install event=start id=indexing",
      "kind=install event=end id=indexing outcome=cancelled elapsed_ms=0",
    ]);
  });
});

describe("route, flag and setup-run lines", () => {
  const base = {
    route: "pending" as const,
    flag: null,
    owed: null,
    setupRun: false,
    finished: false,
    finishedUnconfirmed: false,
    hasBots: true,
  };

  it("formats the route line with every input", () => {
    expect(formatRoute({ ...base, route: "visual", flag: true, owed: true })).toBe(
      "kind=route route=visual flag=true owed=true setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
    );
    expect(formatRoute(base)).toBe(
      "kind=route route=pending flag=null owed=null setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
    );
  });

  it("formats flag and setup-run lines", () => {
    expect(formatFlagLookup("visual-first-run", "timeout", false, true, 1000.4)).toBe(
      "kind=flag flag=visual-first-run path=timeout value=false applied=true elapsed_ms=1000",
    );
    expect(formatFlagLookup("found-apps", "unscoped", true, false, 12)).toBe(
      "kind=flag flag=found-apps path=unscoped value=true applied=false elapsed_ms=12",
    );
    expect(formatSetupRunSet("mark-already-set-up")).toBe("kind=setup-run event=set caller=mark-already-set-up");
  });

  it("formats welcome report lines, with a reason only on blocked", () => {
    expect(formatWelcomeReport("dispatched")).toBe("kind=welcome-report event=dispatched");
    expect(formatWelcomeReport("blocked", "connect-model")).toBe("kind=welcome-report event=blocked reason=connect-model");
    expect(formatWelcomeReport("started")).toBe("kind=welcome-report event=started");
    expect(formatWelcomeReport("landed")).toBe("kind=welcome-report event=landed");
    expect(formatWelcomeReport("failed")).toBe("kind=welcome-report event=failed");
    expect(formatWelcomeReport("blocked", "")).toBe("kind=welcome-report event=blocked reason=unknown");
  });

  it("adds late= only for an answer that landed after its wait", () => {
    expect(formatFlagLookup("visual-first-run", "unscoped", true, true, 6200, "applied")).toBe(
      "kind=flag flag=visual-first-run path=unscoped value=true applied=true late=applied elapsed_ms=6200",
    );
    expect(formatFlagLookup("visual-first-run", "unscoped", true, false, 6200, "legacy-started")).toBe(
      "kind=flag flag=visual-first-run path=unscoped value=true applied=false late=legacy-started elapsed_ms=6200",
    );
    expect(formatFlagLookup("visual-first-run", "unscoped", true, false, 13000, "too-late")).toBe(
      "kind=flag flag=visual-first-run path=unscoped value=true applied=false late=too-late elapsed_ms=13000",
    );
  });

  it("logs the route only when its value changes", () => {
    const lines: string[] = [];
    const logger = createRouteLogger((line) => lines.push(line));
    logger.update(base);
    logger.update({ ...base, owed: true });
    logger.update({ ...base, route: "legacy", flag: false, owed: true });
    logger.update({ ...base, route: "legacy", flag: false, owed: true, setupRun: true });
    expect(lines).toEqual([
      "kind=route route=pending flag=null owed=null setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
      "kind=route route=legacy flag=false owed=true setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
    ]);
  });

  it("a sink that throws does not break the caller", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = createRouteLogger(() => {
      throw new Error("disk full");
    });
    expect(() => logger.update(base)).not.toThrow();
    vi.restoreAllMocks();
  });
});
