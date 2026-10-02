import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  entriesFromDirectory,
  isRawEntityId,
  PENDING_INVITE_LABEL,
  rowPrimaryLabel,
  UNNAMED_MEMBER_LABEL,
} from "./people-picker.js";

const RAW = /^(prs|agt|cmp)_/i;

describe("QA-083 picker rows never use a raw id as the primary label", () => {
  it("falls back to name, then email, then Unnamed member", () => {
    expect(rowPrimaryLabel({ name: "Ada", email: "a@x.test" })).toBe("Ada");
    expect(rowPrimaryLabel({ name: "", email: "a@x.test" })).toBe("a@x.test");
    expect(rowPrimaryLabel({ name: "prs_01KRM2YMFYP7K5E5NGD27KKNFD" })).toBe(UNNAMED_MEMBER_LABEL);
    expect(rowPrimaryLabel({ pending: true })).toBe(PENDING_INVITE_LABEL);
    expect(isRawEntityId("agt_01X")).toBe(true);
    expect(isRawEntityId("cmp_01X")).toBe(true);
    expect(isRawEntityId("Priya")).toBe(false);
  });

  it("roster rows with only an id get a fallback label and keep the id in the detail line", () => {
    const entries = entriesFromDirectory({
      rows: [],
      contacts: [],
      roster: [
        { personUid: "prs_01KRM2YMFYP7K5E5NGD27KKNFD", companyUid: "cmp_hpo" },
        { personUid: "prs_01KQFHN1DMH0PANMMXRT8SJ2F6", companyUid: "cmp_hpo", status: "pending" } as never,
        { personUid: "prs_named", companyUid: "cmp_hpo", name: "Roster Name" } as never,
      ],
    });
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get("prs_01KRM2YMFYP7K5E5NGD27KKNFD")?.name).toBe(UNNAMED_MEMBER_LABEL);
    expect(byId.get("prs_01KRM2YMFYP7K5E5NGD27KKNFD")?.detail).toBe("prs_01KRM2YMFYP7K5E5NGD27KKNFD");
    expect(byId.get("prs_01KQFHN1DMH0PANMMXRT8SJ2F6")?.name).toBe(PENDING_INVITE_LABEL);
    expect(byId.get("prs_named")?.name).toBe("Roster Name");
    for (const entry of entries) expect(entry.name).not.toMatch(RAW);
  });

  it("a named source wins over an earlier id-only row for the same person", () => {
    const entries = entriesFromDirectory({
      rows: [
        {
          id: "dm:prs_a",
          kind: "dm",
          title: "prs_a",
          companyUid: "cmp_hpo",
          unreadDot: false,
          lastActivityAt: 0,
          pinned: false,
          personUid: "prs_a",
        } as never,
      ],
      contacts: [],
      roster: [{ personUid: "prs_a", displayName: "Real Person", companyUid: "cmp_hpo" }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("Real Person");
    expect(entries[0].unnamed).toBe(false);
  });

  it("contract: every list row in the UI package renders its primary label through rowPrimaryLabel", () => {
    const root = join(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".svelte")) files.push(path);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!src.includes('data-testid="people-picker-row"')) continue;
      if (/<b>\{entry\.name\}<\/b>/.test(src) || !src.includes("rowPrimaryLabel(")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
