/**
 * US-007: the decision that replaces the company, Bring it in, Coding tools
 * and name steps. Which tool is named, when only the bot is offered, and the
 * copy's source contract.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  FIRST_RUN_DECISION_COPY,
  FIRST_RUN_FLOW,
  decisionToolFor,
  mostUsedTool,
  type FirstRunToolUsage,
} from "./visual-first-run.js";

const NOW = 1_760_000_000_000;

function usage(tool: string, last30: number, total: number, lastActive: number | null = NOW): FirstRunToolUsage {
  return { tool, sessions_total: total, sessions_last_30d: last30, last_active_at: lastActive };
}

describe("FIRST_RUN_FLOW", () => {
  it("is one question, then done", () => {
    expect([...FIRST_RUN_FLOW]).toEqual(["decision", "done"]);
  });

  it("has none of the removed steps", () => {
    for (const removed of ["team", "company", "import", "tools", "name", "apps"]) {
      expect(FIRST_RUN_FLOW as readonly string[]).not.toContain(removed);
    }
  });
});

describe("mostUsedTool", () => {
  it("is null with no scan, an empty scan or no sessions", () => {
    expect(mostUsedTool(null)).toBeNull();
    expect(mostUsedTool(undefined)).toBeNull();
    expect(mostUsedTool([])).toBeNull();
    expect(mostUsedTool([usage("claude-code", 0, 0, null), usage("codex", 0, 0, null)])).toBeNull();
  });

  it("names the tool with the most sessions in the last 30 days", () => {
    expect(mostUsedTool([usage("claude-code", 2, 40), usage("codex", 9, 10)])).toBe("codex");
    expect(mostUsedTool([usage("claude-code", 9, 10), usage("codex", 2, 40)])).toBe("claude");
  });

  it("breaks a 30-day tie on total sessions, then the newest session", () => {
    expect(mostUsedTool([usage("claude-code", 3, 5), usage("codex", 3, 8)])).toBe("codex");
    expect(mostUsedTool([usage("claude-code", 3, 5, NOW), usage("codex", 3, 5, NOW - 1000)])).toBe("claude");
    expect(mostUsedTool([usage("claude-code", 3, 5, NOW - 1000), usage("codex", 3, 5, NOW)])).toBe("codex");
  });

  it("falls back to setup order on a full tie", () => {
    const order = [usage("codex", 1, 1, null), usage("claude-code", 1, 1, null)];
    expect(mostUsedTool(order)).toBe("claude");
  });

  it("counts a tool used only before the last 30 days", () => {
    expect(mostUsedTool([usage("codex", 0, 4, NOW - 90 * 86_400_000)])).toBe("codex");
  });

  it("ignores tools the bot cannot run as", () => {
    expect(mostUsedTool([usage("cursor", 50, 50), usage("codex", 1, 1)])).toBe("codex");
    expect(mostUsedTool([usage("cursor", 50, 50)])).toBeNull();
  });
});

describe("decisionToolFor", () => {
  it("prefers the most used tool over install order", () => {
    expect(decisionToolFor([usage("codex", 4, 4)], { claude: true, codex: true })).toBe("codex");
  });

  it("falls back to the first installed tool when the scan has no sessions", () => {
    expect(decisionToolFor([], { claude: false, codex: true })).toBe("codex");
    expect(decisionToolFor(null, { claude: true, codex: true })).toBe("claude");
  });

  it("is null with no coding tool, so only the bot path shows", () => {
    expect(decisionToolFor(null, null)).toBeNull();
    expect(decisionToolFor([], {})).toBeNull();
    expect(decisionToolFor([usage("claude-code", 0, 0, null)], { claude: false, codex: false })).toBeNull();
  });
});

describe("decision copy", () => {
  it("names the tool and the computer", () => {
    expect(FIRST_RUN_DECISION_COPY.toolLead("Codex", "Mac")).toBe(
      "You use Codex most on this Mac. HQ can open there with everything it just found.",
    );
    expect(FIRST_RUN_DECISION_COPY.toolPrimary("Claude Code")).toBe("Continue in Claude Code");
    expect(FIRST_RUN_DECISION_COPY.backToTool("Codex")).toBe("Continue in Codex instead");
  });

  it("has no em or en dashes and no emoji", () => {
    const strings = [
      FIRST_RUN_DECISION_COPY.kicker,
      FIRST_RUN_DECISION_COPY.toolQuestion,
      FIRST_RUN_DECISION_COPY.toolLead("Codex"),
      FIRST_RUN_DECISION_COPY.toolPrimary("Codex"),
      FIRST_RUN_DECISION_COPY.toolOther,
      FIRST_RUN_DECISION_COPY.botQuestion,
      FIRST_RUN_DECISION_COPY.botLead,
      FIRST_RUN_DECISION_COPY.botPrimary,
      FIRST_RUN_DECISION_COPY.backToTool("Codex"),
      FIRST_RUN_DECISION_COPY.scanning,
    ];
    for (const text of strings) {
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("decision takeover source contract", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "FirstRunDecisionTakeover.svelte"), "utf8");
  // What a person can see or press: the file without its comments, which
  // describe the steps this screen replaced.
  const shipped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");

  it("offers no removed step or default finish", () => {
    for (const gone of ["Finish with defaults", "Bring it in", "Coding tools", "FirstRunTeamStep", "FirstRunToolsSignIn"]) {
      expect(shipped).not.toContain(gone);
    }
  });

  it("has no em or en dashes", () => {
    expect(source).not.toMatch(/[–—]/);
  });

  it("keeps font weight at 500 or less, with no backdrop filter or left accent bar", () => {
    for (const match of source.matchAll(/font-weight:\s*(\d+)/g)) {
      expect(Number(match[1])).toBeLessThanOrEqual(500);
    }
    expect(source).not.toMatch(/backdrop-filter/);
    expect(source).not.toMatch(/border-left:\s*\d/);
  });

  it("shows one primary action per screen", () => {
    expect(source.match(/data-testid="first-run-decision-primary"/g)).toHaveLength(2);
    expect(source).toContain("{:else if showBot}");
  });
});
