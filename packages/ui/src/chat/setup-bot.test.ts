/**
 * Pure rules behind "setup is a Local bot": which bot counts as the setup
 * bot, which runtime a new one thinks with, the button label, and the
 * product wording of the copy it ships with.
 */
import { describe, expect, it } from "vitest";
import type { LocalBotRow } from "@hq/platform";

import {
  findSetupBot,
  firstSignedInRuntime,
  setupBotActionLabel,
  SETUP_BOT_COPY,
  SETUP_BOT_INTRO,
  SETUP_BOT_KICKOFF,
  SETUP_BOT_KICKOFF_PREFIX,
  SETUP_BOT_MODE,
  SETUP_BOT_NAME,
  SETUP_BOT_WORKER,
} from "./setup-bot";

function bot(name: string, agentUid = `agt_${name}`): LocalBotRow {
  return {
    name,
    agentUid,
    ownerUid: "prs_test",
    runtime: "claude",
    state: "running",
    pid: 1,
    processAlive: true,
    online: true,
    lastHeartbeatAt: null,
    daemonInstalled: true,
    daemonLoaded: true,
    dir: `/tmp/HQ/personal/workers/${name}`,
  };
}

describe("findSetupBot", () => {
  it("finds the setup bot by name, whatever the casing or padding", () => {
    expect(findSetupBot([bot("scout"), bot(" Setup ", "agt_setup")])).toEqual({ agentUid: "agt_setup", name: " Setup " });
  });

  it("is null when this Mac has no setup bot", () => {
    expect(findSetupBot([bot("scout")])).toBeNull();
    expect(findSetupBot([])).toBeNull();
    expect(findSetupBot(null)).toBeNull();
  });

  it("ignores a row with no uid — there is no DM to open", () => {
    expect(findSetupBot([bot("setup", "  ")])).toBeNull();
  });
});

describe("firstSignedInRuntime", () => {
  it("prefers Claude Code, then Codex, then Grok", () => {
    expect(firstSignedInRuntime({ claude: true, codex: true, grok: true })).toBe("claude");
    expect(firstSignedInRuntime({ claude: false, codex: true, grok: true })).toBe("codex");
    expect(firstSignedInRuntime({ claude: false, codex: false, grok: true })).toBe("grok");
  });

  it("is null when nothing is signed in, or the host has not answered yet", () => {
    expect(firstSignedInRuntime({ claude: false, codex: false, grok: false })).toBeNull();
    expect(firstSignedInRuntime(null)).toBeNull();
  });
});

describe("copy", () => {
  it("labels the one action by whether the bot exists yet", () => {
    expect(setupBotActionLabel({ existing: false })).toBe("Run Setup");
    expect(setupBotActionLabel({ existing: true })).toBe("Open your setup bot");
    expect(setupBotActionLabel(null)).toBe("Run Setup");
  });

  it("says 'setup bot', never 'agent'", () => {
    const copy = [...Object.values(SETUP_BOT_COPY), SETUP_BOT_INTRO].join(" ");
    expect(copy.toLowerCase()).not.toContain("agent");
    expect(copy).toContain("setup bot");
  });

  it("keeps the intro inside the CLI's --intro limit, on one line", () => {
    expect(SETUP_BOT_INTRO.length).toBeLessThanOrEqual(500);
    // The host rejects control characters in --intro.
    expect(SETUP_BOT_INTRO).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("the intro is two short sentences: the plan, then step one starting now — never an open question", () => {
    const sentences = SETUP_BOT_INTRO.split(/(?<=[.!?])\s+/).filter(Boolean);
    expect(sentences).toHaveLength(2);
    for (const part of ["tools", "HQ Cloud", "company", "work you already have", "apps", "first bot"]) {
      expect(SETUP_BOT_INTRO).toContain(part);
    }
    expect(sentences[1]).toMatch(/starting step one now/i);
    expect(SETUP_BOT_INTRO).not.toContain("?");
    expect(SETUP_BOT_INTRO.toLowerCase()).not.toMatch(/what would you like|say hi whenever/);
  });

  it("the kickoff fits the CLI's --kickoff limit, on one line, and starts with the prefix the template recognises", () => {
    expect(SETUP_BOT_KICKOFF.length).toBeLessThanOrEqual(2000);
    expect(SETUP_BOT_KICKOFF).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(SETUP_BOT_KICKOFF.startsWith(`${SETUP_BOT_KICKOFF_PREFIX} `)).toBe(true);
    expect(SETUP_BOT_KICKOFF_PREFIX).toBe("Kickoff:");
  });

  it("the kickoff asks for the state check, the first unfinished step, and exactly one concrete question or action", () => {
    const k = SETUP_BOT_KICKOFF;
    expect(k).toMatch(/signed in to HQ Cloud/);
    expect(k).toMatch(/has a company/);
    expect(k).toMatch(/tools/);
    expect(k).toMatch(/first unfinished step/);
    expect(k).toMatch(/exactly one concrete question or one concrete action/);
    expect(k).toMatch(/do not greet again/);
    expect(k).toMatch(/already finished/);
  });

  it("creates `setup` from the core `setup` worker, with the bot path on", () => {
    expect(SETUP_BOT_NAME).toBe("setup");
    expect(SETUP_BOT_WORKER).toBe("setup");
    // The scripted run stays behind this flag for one build.
    expect(SETUP_BOT_MODE).toBe(true);
  });
});
