import { describe, expect, it } from "vitest";
import { memberAccessView, prefixCount, summarizeAccess, topPrefix } from "./member-access.js";

const grant = (path: string, permission: string, via: string, extra: Record<string, unknown> = {}) => ({
  path,
  permission,
  sources: [{ via, permission, ...extra }],
});

function payload(opts: { filesBypass?: boolean; secretsBypass?: boolean; files?: unknown[]; secrets?: unknown[] }) {
  return {
    identity: { groups: [{ name: "core" }, { name: "Dev Test" }] },
    files: { roleBypass: opts.filesBypass ?? false, grants: opts.files ?? [] },
    secrets: { roleBypass: opts.secretsBypass ?? false, grants: opts.secrets ?? [] },
  };
}

describe("summarizeAccess owner short-circuit", () => {
  it("gives one line of truth and lists no per-path grants when the role reaches everything", () => {
    const created = Array.from({ length: 46 }, (_, i) => grant(`agents/bot-${i}/*`, "admin", "creator"));
    const view = memberAccessView(
      payload({ filesBypass: true, secretsBypass: true, files: [grant("*", "admin", "email"), ...created] }),
    );
    const s = summarizeAccess(view, { role: "Owner", companyLabel: "Indigo" });
    expect(s.everything).toBe("Owner: every file and secret in Indigo");
    expect(s.files.groups).toEqual([]);
    expect(s.secrets.groups).toEqual([]);
    expect(s.files.bypass).toBe(true);
  });

  it("does not short-circuit when only files are reachable by role", () => {
    const view = memberAccessView(payload({ filesBypass: true, secrets: [grant("prod/", "read", "group", { groupName: "core" })] }));
    const s = summarizeAccess(view, { role: "Admin", companyLabel: "Indigo" });
    expect(s.everything).toBeNull();
    expect(s.files.bypass).toBe(true);
    expect(s.files.groups).toEqual([]);
    expect(s.secrets.groups.map((g) => [g.prefix, g.why, g.rows.length])).toEqual([["prod/", "via core", 1]]);
  });
});

describe("summarizeAccess rollup", () => {
  const view = memberAccessView(
    payload({
      files: [
        ...Array.from({ length: 46 }, (_, i) => grant(`agents/bot-${i}/*`, "admin", "creator")),
        grant("knowledge/", "read", "company-wide"),
        grant("knowledge/public/", "read", "company-wide"),
        grant("projects/alpha/", "write", "group", { groupName: "Finance" }),
        grant("projects/beta/", "read", "group", { groupName: "Finance" }),
        grant("projects/gamma/", "write", "group", { groupName: "Design" }),
        grant("reports/q3.md", "read", "email"),
      ],
      secrets: [grant("stripe/", "read", "group", { groupName: "Finance" })],
    }),
  );
  const s = summarizeAccess(view, { role: "Member", companyLabel: "Indigo" });

  it("groups by source and top-level folder, with counts", () => {
    expect(s.files.total).toBe(52);
    expect(s.files.groups.map((g) => [g.source, g.prefix, g.rows.length, g.level, g.why])).toEqual([
      ["company-wide", "knowledge/", 2, "read", "shared company-wide"],
      ["group", "projects/", 2, "mixed levels", "via Finance"],
      ["group", "projects/", 1, "read + write", "via Design"],
      ["direct", "reports/", 1, "read", "granted directly"],
      ["created", "agents/", 46, "admin", "because they created them"],
    ]);
  });

  it("keeps secrets apart from files", () => {
    expect(s.secrets.groups.map((g) => [g.prefix, g.why])).toEqual([["stripe/", "via Finance"]]);
    expect(s.files.groups.some((g) => g.prefix === "stripe/")).toBe(false);
  });

  it("sorts the paths inside a group", () => {
    const projects = s.files.groups.find((g) => g.why === "via Finance")!;
    expect(projects.rows.map((r) => r.path)).toEqual(["projects/alpha/", "projects/beta/"]);
  });
});

describe("helpers", () => {
  it("names the top-level folder", () => {
    expect(topPrefix("agents/a bot/*")).toBe("agents/");
    expect(topPrefix("knowledge/")).toBe("knowledge/");
    expect(topPrefix("*")).toBe("Everything");
    expect(topPrefix("README.md")).toBe("README.md");
  });

  it("counts prefixes in words", () => {
    expect(prefixCount(1)).toBe("1 prefix");
    expect(prefixCount(46)).toBe("46 prefixes");
  });
});
