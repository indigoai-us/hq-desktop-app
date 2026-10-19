/**
 * Pure rules behind "setup is a Local bot": which bot counts as the setup
 * bot, which runtime a new one thinks with, the button label, and the
 * product wording of the copy it ships with.
 */
import { describe, expect, it } from "vitest";
import type { LocalBotRow } from "@hq/platform";

import { messageMarksSetupDone, richContentForMessage } from "./messaging/richMessageContent";
import {
  findSetupBot,
  findSetupBotContact,
  firstSignedInRuntime,
  isAssistantRecord,
  isAssistantSlug,
  setupBotActionLabel,
  SETUP_BOT_COPY,
  SETUP_BOT_INTRO,
  SETUP_BOT_KICKOFF,
  setupFinaleDue,
  SETUP_BOT_KICKOFF_PREFIX,
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
  it("finds the setup bot by its handle, whatever the casing or padding, and carries no name", () => {
    expect(findSetupBot([bot("scout"), bot(" Setup ", "agt_setup")])).toEqual({ agentUid: "agt_setup", handle: "Setup" });
  });

  it("finds it by the role marker an hq-cli reports, never by display name", () => {
    const marked = { ...bot("hazel-handle", "agt_marked"), role: "assistant", displayName: "Hazel" };
    expect(findSetupBot([bot("scout"), marked])).toEqual({ agentUid: "agt_marked", handle: "hazel-handle" });
    expect(findSetupBot([{ ...bot("scout"), displayName: "setup" }])).toBeNull();
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
    // The bot starts by itself, so both states open the same waiting
    // conversation; the label says so either way.
    expect(setupBotActionLabel({ existing: false })).toBe("Open your assistant");
    expect(setupBotActionLabel({ existing: true })).toBe("Open your assistant");
    expect(setupBotActionLabel(null)).toBe("Open your assistant");
  });

  it("calls it 'your assistant' everywhere, never 'setup bot' or an agent", () => {
    const label = "Open your assistant";
    expect(SETUP_BOT_COPY.run).toBe(label);
    expect(SETUP_BOT_COPY.open).toBe(label);
    const prose = [...Object.values(SETUP_BOT_COPY), SETUP_BOT_INTRO].join(" ");
    expect(prose.toLowerCase()).not.toContain("agent");
    expect(prose.toLowerCase()).not.toContain("setup bot");
    expect(prose).toContain("Your assistant");
  });

  it("points people who prefer Claude Code or Codex at the Launch button", () => {
    expect(SETUP_BOT_INTRO).toContain("Claude Code or Codex with the Launch button above");
  });

  it("keeps the intro inside the CLI's --intro limit, on one line", () => {
    expect(SETUP_BOT_INTRO.length).toBeLessThanOrEqual(500);
    // The host rejects control characters in --intro.
    expect(SETUP_BOT_INTRO).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("the intro is the plan, then that it is checking the computer and may take a minute, then the Launch pointer, never an open question", () => {
    const sentences = SETUP_BOT_INTRO.split(/(?<=[.!?])\s+/).filter(Boolean);
    expect(sentences).toHaveLength(3);
    for (const part of ["tools", "HQ Cloud", "company", "work you already have", "apps", "first bot"]) {
      expect(SETUP_BOT_INTRO).toContain(part);
    }
    // Platform-neutral: never names a specific OS ("your Mac", "your PC")
    // because the same intro is sent from Windows and macOS alike.
    expect(sentences[1]).toMatch(/checking your computer now/i);
    expect(sentences[1]).not.toMatch(/\bmac\b/i);
    expect(sentences[1]).toMatch(/a minute/i);
    expect(sentences[2]).toMatch(/Launch button/);
    expect(SETUP_BOT_INTRO).not.toContain("?");
    expect(SETUP_BOT_INTRO.toLowerCase()).not.toMatch(/what would you like|say hi whenever/);
  });

  it("the kickoff fits the CLI's --kickoff limit, on one line, and starts with the prefix the template recognises", () => {
    expect(SETUP_BOT_KICKOFF.length).toBeLessThanOrEqual(2000);
    expect(SETUP_BOT_KICKOFF).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(SETUP_BOT_KICKOFF.startsWith(`${SETUP_BOT_KICKOFF_PREFIX} `)).toBe(true);
    expect(SETUP_BOT_KICKOFF_PREFIX).toBe("Kickoff:");
  });

  it("the kickoff opens with the explain-HQ-or-jump-in question before the first unfinished step", () => {
    const k = SETUP_BOT_KICKOFF;
    expect(k).toMatch(/whether I want HQ explained first or to jump straight in/);
    expect(k.indexOf("explained first")).toBeLessThan(k.indexOf("first unfinished step"));
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
    // Setup never advertises a way to skip it.
    expect(k.toLowerCase()).not.toMatch(/skip/);
  });

  it("creates `setup` from the core `setup` worker, with the bot path on", () => {
    expect(SETUP_BOT_NAME).toBe("setup");
    expect(SETUP_BOT_WORKER).toBe("setup");
  });
});

/**
 * A local wipe that keeps the same HQ account (a reinstall, or a second Mac)
 * leaves the cloud owning the setup agent while `hq bot list` reports nothing,
 * so the create 409s. The DM roster is the desktop's cloud-side view of the
 * person's own bots; this is what the start path asks before creating.
 */
describe("findSetupBotContact", () => {
  const contact = (personUid: string, displayName: string) => ({ personUid, displayName, companyUid: null });

  it("finds a setup bot that exists only in the cloud", () => {
    const roster = { contacts: [contact("prs_mate", "Sam"), contact("agt_cloud_setup", "setup")] };
    expect(findSetupBotContact(roster)).toEqual({ agentUid: "agt_cloud_setup", handle: "setup" });
  });

  it("reads a bare array as well as a { contacts } payload", () => {
    expect(findSetupBotContact([contact("agt_cloud_setup", "  Setup  ")])).toEqual({
      agentUid: "agt_cloud_setup",
      handle: "setup",
    });
  });

  it("finds a named assistant by the cloud's agentRole marker, not by its name", () => {
    const named = { personUid: "agt_hazel", displayName: "Hazel", agentRole: "assistant", role: "member" };
    expect(findSetupBotContact([contact("agt_scout", "Scout"), named])).toEqual({ agentUid: "agt_hazel", handle: "setup" });
    // `role` on a contact is the membership role: it never marks the assistant.
    expect(findSetupBotContact([{ personUid: "agt_x", displayName: "X", role: "assistant" }])).toBeNull();
  });

  it("only ever matches an agent uid — a person called setup is not a bot", () => {
    expect(findSetupBotContact([contact("prs_setup", "setup")])).toBeNull();
  });

  it("ignores every other bot on the roster", () => {
    expect(findSetupBotContact([contact("agt_scout", "scout"), contact("agt_setupper", "setup-helper")])).toBeNull();
  });

  it("answers null for nothing, junk and empty rows", () => {
    expect(findSetupBotContact(null)).toBeNull();
    expect(findSetupBotContact({ contacts: [] })).toBeNull();
    expect(findSetupBotContact("nope")).toBeNull();
    expect(findSetupBotContact([null, 7, { personUid: "agt_x" }])).toBeNull();
  });
});

describe("isAssistantRecord / isAssistantSlug", () => {
  it("knows the assistant by role or handle, and its handle and slug are never names", () => {
    expect(isAssistantRecord({ name: "setup" })).toBe(true);
    expect(isAssistantRecord({ name: "x", role: "assistant" })).toBe(true);
    expect(isAssistantRecord({ name: "x", agentRole: "Assistant" })).toBe(true);
    expect(isAssistantRecord({ name: "scout" })).toBe(false);
    expect(isAssistantSlug("setup")).toBe(true);
    expect(isAssistantSlug("setup-rg13gzm4")).toBe(true);
    expect(isAssistantSlug("Hazel")).toBe(false);
    expect(isAssistantSlug("setup helper")).toBe(false);
  });
});

describe("setupFinaleDue", () => {
  const BOT = "agt_SETUP";
  const done = "Here's where you've landed.\n\n```hq-block\n{\"v\":1,\"blocks\":[{\"kind\":\"setupDone\"}]}\n```";

  it("is true once the setup bot sends the setupDone block", () => {
    expect(setupFinaleDue([{ fromPersonUid: BOT, body: "hi" }, { fromPersonUid: BOT, body: done }], BOT, messageMarksSetupDone)).toBe(true);
  });

  it("ignores the block from anyone but the setup bot, and plain messages", () => {
    expect(setupFinaleDue([{ fromPersonUid: "prs_ME", body: done }], BOT, messageMarksSetupDone)).toBe(false);
    expect(setupFinaleDue([{ fromPersonUid: BOT, body: "Setup is done!" }], BOT, messageMarksSetupDone)).toBe(false);
    expect(setupFinaleDue([{ fromPersonUid: BOT, body: done }], "  ", messageMarksSetupDone)).toBe(false);
  });

  it("puts the card away once the person writes again", () => {
    const thread = [
      { fromPersonUid: BOT, body: done },
      { fromPersonUid: "prs_ME", body: "one more thing" },
    ];
    expect(setupFinaleDue(thread, BOT, messageMarksSetupDone)).toBe(false);
  });

  it("keeps the card while only the bot has spoken since", () => {
    const thread = [
      { fromPersonUid: "prs_ME", body: "thanks" },
      { fromPersonUid: BOT, body: done },
      { fromPersonUid: BOT, body: "One more tip." },
    ];
    expect(setupFinaleDue(thread, BOT, messageMarksSetupDone)).toBe(true);
  });

  it("does not bring the card back when the bot repeats the block", () => {
    const thread = [
      { fromPersonUid: BOT, body: done },
      { fromPersonUid: "prs_ME", body: "ok" },
      { fromPersonUid: BOT, body: done },
    ];
    expect(setupFinaleDue(thread, BOT, messageMarksSetupDone)).toBe(false);
  });

  it("the block leaves only the prose as the message text", () => {
    const { text, rich } = richContentForMessage({ body: done });
    expect(text).toBe("Here's where you've landed.");
    expect(rich?.blocks).toEqual([{ kind: "setupDone" }]);
  });
});

describe("setupBotNoRuntime", () => {
  it("names no button and no direction: the sign-in panel below carries the next step", async () => {
    const { setupBotNoRuntime, isSetupBotNoRuntimeMessage } = await import("./setup-bot");
    const text = setupBotNoRuntime({ noun: "Mac" });
    expect(text).toBe("HQ needs a coding tool signed in on this Mac to finish setup.");
    expect(text).not.toMatch(/Retry|above|CLI/);
    expect(isSetupBotNoRuntimeMessage(text)).toBe(true);
    // A host still on the older wording keeps showing the panel.
    expect(
      isSetupBotNoRuntimeMessage(
        "HQ needs a coding tool signed in on this Mac to finish setup. Sign in above, then Retry.",
      ),
    ).toBe(true);
  });
});
