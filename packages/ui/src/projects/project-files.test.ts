import { describe, expect, it } from "vitest";
import {
  newFileDestination,
  fileTemplateBody,
  folderSummary,
  normalizeNewFileName,
  repoLinkFromPrdText,
  resolveUploadName,
  rowMarkForPath,
  visibleFileRoots,
} from "./project-files.js";
import type { PortfolioSessionRef } from "./projects-model.js";

describe("visibleFileRoots", () => {
  it("lists the vault path before the linked repo and its branch", () => {
    expect(
      visibleFileRoots({
        vaultPath: "companies/indigo/projects/hq-desktop-console-rail",
        repoPath: "repos/private/hq-desktop-app",
        repoBranch: "feat/console-rail",
        repoAccess: true,
      }),
    ).toEqual([
      {
        kind: "vault",
        path: "companies/indigo/projects/hq-desktop-console-rail",
        branch: null,
      },
      {
        kind: "repo",
        path: "repos/private/hq-desktop-app",
        branch: "feat/console-rail",
      },
    ]);
  });

  it("hides the repo tree when the viewer has vault access only", () => {
    expect(
      visibleFileRoots({
        vaultPath: "companies/indigo/projects/demo",
        repoPath: "repos/private/hq-desktop-app",
        repoBranch: "main",
        repoAccess: false,
      }).map((root) => root.kind),
    ).toEqual(["vault"]);
  });
});

describe("upload conflicts", () => {
  const existing = new Set(["notes.md", "notes-2.md"]);

  it("keeps both by suffixing the stem", () => {
    expect(resolveUploadName("notes.md", existing, "keep-both")).toBe("notes-3.md");
    expect(resolveUploadName("new.md", existing, "keep-both")).toBe("new.md");
  });

  it("replaces or skips a clash", () => {
    expect(resolveUploadName("notes.md", existing, "replace")).toBe("notes.md");
    expect(resolveUploadName("notes.md", existing, "skip")).toBeNull();
  });
});

describe("new file helpers", () => {
  it("normalizes a display name into a markdown file name", () => {
    expect(normalizeNewFileName("Welcome V2")).toBe("welcome-v2.md");
    expect(normalizeNewFileName("../secret")).toBeNull();
  });

  it("reads a repo link from prd.json and ignores a missing one", () => {
    expect(
      repoLinkFromPrdText(
        JSON.stringify({ repo: "repos/private/hq-desktop-app", branch: "feat/atlas-v0" }),
      ),
    ).toEqual({ path: "repos/private/hq-desktop-app", branch: "feat/atlas-v0" });
    expect(repoLinkFromPrdText("{")).toBeNull();
  });

  it("fills a knowledge template with the owner", () => {
    expect(fileTemplateBody("knowledge", "Corey")).toContain("owner: Corey");
    expect(fileTemplateBody("blank", "Corey")).toBe("");
  });
});

describe("row marks", () => {
  const session: PortfolioSessionRef = {
    project: "hq",
    company: "indigo",
    cwd: "/Users/corey/Documents/HQ/companies/indigo/projects/demo/design.md",
    status: "running",
    agent: "deacon",
    lastActivityAt: "2026-10-01T20:00:00Z",
  };

  it("marks a live editor when a session cwd contains the file", () => {
    expect(rowMarkForPath("companies/indigo/projects/demo/design.md", [session])).toEqual({
      label: "deacon",
      live: true,
    });
  });
});

describe("folderSummary", () => {
  it("counts folders and files for the empty preview", () => {
    expect(folderSummary([{ isDir: true }, { isDir: false }, { isDir: false }])).toBe(
      "1 folder · 2 files",
    );
    expect(folderSummary([{ isDir: true }, { isDir: true }])).toBe("2 folders");
    expect(folderSummary([])).toBe("Empty folder");
  });
});

describe("newFileDestination (QA-072)", () => {
  it("names the project and folder in plain words", () => {
    const root = "companies/indigo/projects/demo";
    expect(newFileDestination("a.md", root, root)).toBe(
      "Creates a.md in demo. It syncs to the company vault.",
    );
    expect(newFileDestination("a.md", root, `${root}/notes/`)).toBe(
      "Creates a.md in demo/notes. It syncs to the company vault.",
    );
  });
});
