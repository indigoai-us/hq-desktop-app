import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STEP_COPY } from "../../agents/agent-stepper-model.js";
import {
  EDIT_BOT_TABS,
  TRANSCRIPT_VIRTUALIZE_THRESHOLD,
  appendTranscript,
  botNameFromPayload,
  botProfileFromCache,
  botSubjectName,
  cancelStop,
  confirmStop,
  editBotTabLabel,
  profilePhase,
  requestStop,
  transcriptWindow,
  userProfileFromCache,
  type SessionLine,
  profileViewingCompanyUid,
} from "./profile-pane-model.js";

describe("profile phase", () => {
  it("paints a cached name and shimmers when the name is missing", () => {
    expect(profilePhase("deacon")).toBe("ready");
    expect(profilePhase("  ")).toBe("shimmer");
    expect(profilePhase(null)).toBe("shimmer");
  });
});

describe("edit bot tabs", () => {
  it("reuses the stepper step names except Verify", () => {
    expect(EDIT_BOT_TABS).toEqual([
      "identity",
      "membership",
      "access",
      "capabilities",
      "runtime",
    ]);
    for (const tab of EDIT_BOT_TABS) {
      expect(editBotTabLabel(tab)).toBe(STEP_COPY[tab].title);
    }
  });
});

describe("stop session", () => {
  it("asks for confirmation before the ended state", () => {
    expect(requestStop("live")).toBe("confirm-stop");
    expect(cancelStop("confirm-stop")).toBe("live");
    expect(confirmStop("live")).toBe("live");
    expect(confirmStop("confirm-stop")).toBe("ended");
    expect(requestStop("ended")).toBe("ended");
  });
});

describe("transcript window", () => {
  it("renders every row under the threshold and windows past it", () => {
    const small = transcriptWindow(40, 0, 400);
    expect(small.windowed).toBe(false);
    expect(small.end).toBe(40);

    const lines: SessionLine[] = Array.from({ length: TRANSCRIPT_VIRTUALIZE_THRESHOLD + 20 }, (_, i) => ({
      id: `l${i}`,
      kind: "speech",
      at: "9:40",
      who: "deacon",
      text: `line ${i}`,
    }));
    const grown = appendTranscript(lines, {
      id: "next",
      kind: "tool",
      at: "9:41",
      name: "Bash",
      detail: "pnpm test",
      result: null,
      running: true,
    });
    expect(grown).toHaveLength(TRANSCRIPT_VIRTUALIZE_THRESHOLD + 21);
    const win = transcriptWindow(grown.length, 3600, 400);
    expect(win.windowed).toBe(true);
    expect(win.end - win.start).toBeLessThan(grown.length);
    expect(win.start).toBeGreaterThan(0);
  });
});

describe("cache snapshots", () => {
  it("builds a bot and a person from the roster row alone", () => {
    const bot = botProfileFromCache({ name: "Deacon", live: true, company: "Indigo", owner: "Corey" });
    expect(bot.handle).toBe("@deacon");
    expect(bot.live).toBe(true);
    expect(bot.companies[0]?.name).toBe("Indigo");
    const person = userProfileFromCache({
      name: "Maxx Freedman",
      email: "maxx@example.com",
      role: "Member",
      company: "Indigo",
      live: true,
    });
    expect(person.roleChips[0]).toContain("Indigo");
    expect(person.now).toBe("Live");
  });
});

describe("bot profile subject from a DM header (QA-087)", () => {
  it("skips the conversation placeholder and the raw UID", () => {
    expect(botSubjectName("agt_1", [null, "Direct message", "agt_1", "dr-love"])).toBe("dr-love");
    expect(botSubjectName("agt_1", ["Direct message", ""])).toBe("");
  });

  it("reads the bot's own name from a status payload", () => {
    expect(botNameFromPayload({ agent: { displayName: "dr-love" } })).toBe("dr-love");
    expect(botNameFromPayload({ name: "deacon" })).toBe("deacon");
    expect(botNameFromPayload({})).toBe("");
  });
});

describe("profileViewingCompanyUid (QA-087 viewing company)", () => {
  it("keeps the company a DM was opened from when the DM row has none", () => {
    const origins = { agt_drlove: "cmp_golden" };
    expect(profileViewingCompanyUid(null, "agt_drlove", origins)).toBe("cmp_golden");
    expect(profileViewingCompanyUid("  ", "agt_drlove", origins)).toBe("cmp_golden");
  });

  it("prefers the conversation's own company and returns null when nothing is known", () => {
    expect(profileViewingCompanyUid("cmp_hpo", "agt_drlove", { agt_drlove: "cmp_golden" })).toBe("cmp_hpo");
    expect(profileViewingCompanyUid(null, "agt_other", { agt_drlove: "cmp_golden" })).toBeNull();
    expect(profileViewingCompanyUid(null, null, {})).toBeNull();
  });

  it("is what the shell passes to both bot profile panes", () => {
    const shell = readFileSync(join(__dirname, "../DesktopApp.svelte"), "utf8");
    expect(shell).toMatch(/if \(origin\) dmOriginCompany = \{ \.\.\.dmOriginCompany, \[uid\]: origin \}/);
    const botMounts = shell.split('kind: "bot",').slice(1).map((chunk) => chunk.slice(0, 900));
    expect(botMounts).toHaveLength(2);
    for (const mount of botMounts) {
      expect(mount).toContain("company: profileCompanyUid ? companyDisplayName(profileCompanyUid, companyNames) : null");
      expect(mount).not.toMatch(/company: selectedRow\.companyUid/);
    }
  });
});
