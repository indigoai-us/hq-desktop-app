import { describe, expect, it } from "vitest";
import type { Workspace } from "../../chat/workspaces.js";
import {
  PERSONAL_VAULT,
  breadcrumbs,
  isSensitiveName,
  outlineOf,
  plural,
  splitFrontmatter,
  vaultsFor,
  visibleEntries,
  type Vault,
} from "./vault-model.js";

function ws(over: Partial<Workspace>): Workspace {
  return {
    slug: "acme",
    displayName: "Acme",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_1",
    bucketName: null,
    hasLocalFolder: true,
    localPath: "/hq/companies/acme",
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
    ...over,
  } as Workspace;
}

const ACME: Vault = { id: "company:acme", kind: "company", label: "Acme", root: "companies/acme", slug: "acme" };

describe("vaultsFor", () => {
  it("lists personal first, then readable companies with a local folder", () => {
    const vaults = vaultsFor([
      ws({ slug: "zeta", displayName: "Zeta" }),
      ws({ slug: "acme", displayName: "Acme" }),
      ws({ slug: "remote", displayName: "Remote", hasLocalFolder: false }),
      ws({ slug: "pending", displayName: "Pending", membershipStatus: "pending" }),
      ws({ slug: "personal", kind: "personal", displayName: "Personal" }),
    ]);
    expect(vaults.map((v) => v.id)).toEqual(["personal", "company:acme", "company:zeta"]);
    expect(vaults[1].root).toBe("companies/acme");
  });
});

describe("visibleEntries", () => {
  const e = (name: string, isDir = false) => ({ name, path: name, isDir, hasChildren: isDir });

  it("never shows settings folders or credential files", () => {
    const shown = visibleEntries(ACME, "companies/acme", [
      e("settings", true),
      e("knowledge", true),
      e(".env"),
      e("stripe-credentials.json"),
      e("pricing.md"),
    ]);
    expect(shown.map((x) => x.name)).toEqual(["knowledge", "pricing.md"]);
  });

  it("keeps other vaults and HQ scaffold out of the personal vault's top level", () => {
    const top = [e("companies", true), e("repos", true), e("workspace", true), e("core", true), e("personal", true), e("knowledge", true)];
    expect(visibleEntries(PERSONAL_VAULT, "", top).map((x) => x.name)).toEqual(["personal", "knowledge"]);
    expect(visibleEntries(PERSONAL_VAULT, "", top, { showSystem: true }).map((x) => x.name)).toEqual([
      "core",
      "personal",
      "knowledge",
    ]);
  });

  it("hides dotfiles unless system files are shown", () => {
    const entries = [e(".gitignore"), e(".hq-sync-journal.json"), e("notes.md")];
    expect(visibleEntries(ACME, "companies/acme", entries).map((x) => x.name)).toEqual(["notes.md"]);
    expect(visibleEntries(ACME, "companies/acme", entries, { showSystem: true }).map((x) => x.name)).toEqual([
      ".gitignore",
      ".hq-sync-journal.json",
      "notes.md",
    ]);
  });

  it("matches the Rust sensitive-name rule", () => {
    expect(isSensitiveName(".env.example", false)).toBe(false);
    expect(isSensitiveName("tokens.css", false)).toBe(false);
    expect(isSensitiveName("gmail-token.json", false)).toBe(true);
    expect(isSensitiveName("server.pem", false)).toBe(true);
  });
});

describe("splitFrontmatter", () => {
  it("reads flat keys, inline lists and block lists", () => {
    const { properties, body } = splitFrontmatter(
      "---\ntitle: \"Pricing\"\ntags: [gtm, pricing]\nowners:\n  - Sara\n  - Ali\nstatus: draft\n---\n\n# Pricing\n",
    );
    expect(properties).toEqual([
      { key: "title", value: "Pricing" },
      { key: "tags", value: ["gtm", "pricing"] },
      { key: "owners", value: ["Sara", "Ali"] },
      { key: "status", value: "draft" },
    ]);
    expect(body).toBe("# Pricing\n");
  });

  it("leaves a document without frontmatter alone", () => {
    expect(splitFrontmatter("# Hi\n---\n")).toEqual({ properties: [], body: "# Hi\n---\n" });
  });
});

describe("outlineOf", () => {
  it("lists headings outside code fences, with markup removed", () => {
    expect(outlineOf("# One\n```\n# not\n```\n## Two [[a/b|Bee]] `code`\n### **Three**")).toEqual([
      { level: 1, text: "One", index: 0 },
      { level: 2, text: "Two Bee code", index: 1 },
      { level: 3, text: "Three", index: 2 },
    ]);
  });
});

describe("plural", () => {
  it("says 1 file and 3 files", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(3, "file")).toBe("3 files");
  });
});

describe("breadcrumbs", () => {
  it("builds crumbs relative to the vault", () => {
    expect(breadcrumbs(ACME, "companies/acme/knowledge/pricing.md")).toEqual([
      { label: "knowledge", path: "companies/acme/knowledge" },
      { label: "pricing.md", path: "companies/acme/knowledge/pricing.md" },
    ]);
  });
});
