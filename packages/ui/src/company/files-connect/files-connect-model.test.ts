import { describe, expect, it } from "vitest";
import {
  findDeploySources,
  companyDeploymentRows,
  legacyDeploymentRow,
  ACCESS_LEVELS,
  acceptSecretKey,
  applyDeepLink,
  beginConnect,
  clampAccess,
  deployPrompt,
  filterSecrets,
  fixtureCache,
  metadata,
  publicSecret,
  redeployAllowed,
  redeployPrompt,
  shareSheet,
} from "./files-connect-model.js";

describe("US-029 files and connect", () => {
  it("offers only read and write for grant and share", () => {
    expect([...ACCESS_LEVELS]).toEqual(["read", "write"]);
    expect(clampAccess("admin")).toBe("read");
    expect(clampAccess("write")).toBe("write");
    expect(shareSheet({ name: "ATTIO_API_KEY", value: "sk-live-secret" })).toEqual({
      name: "ATTIO_API_KEY",
      levels: ["read", "write"],
    });
  });

  it("strips secret values before a row can render", () => {
    const row = publicSecret({
      name: "STRIPE_SECRET_KEY",
      value: "sk_live_should_never_render",
      kind: "standard",
    });
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain("sk_live");
    expect(row?.name).toBe("STRIPE_SECRET_KEY");
  });

  it("accepts paste and drop on secret fields and rejects typed keys", () => {
    expect(acceptSecretKey("insertFromPaste")).toBe(true);
    expect(acceptSecretKey("insertFromDrop")).toBe(true);
    expect(acceptSecretKey("insertText")).toBe(false);
  });

  it("opens connect in the system browser and waits for the deep link", () => {
    const session = beginConnect("Slack");
    expect(session.phase).toBe("waiting");
    expect(session.url).toContain("Slack");
    expect(applyDeepLink(session, "https://example.com").phase).toBe("waiting");
    expect(applyDeepLink(session, "hq://oauth?code=abc").phase).toBe("returned");
  });

  it("routes deploy and confirmed redeploy through /deploy", () => {
    expect(deployPrompt("indigo", "standup-brief")).toContain("/deploy indigo");
    expect(redeployAllowed(false)).toBe(false);
    expect(redeployAllowed(true)).toBe(true);
    expect(redeployPrompt("indigo", "docs")).toContain("Redeploy docs");
    expect(redeployPrompt("indigo", "docs")).toContain("/deploy indigo");
  });

  it("keeps the scroll budget on the page metadata", () => {
    expect(metadata.performanceBudget.scrollDroppedFramesPct).toBeLessThanOrEqual(0.01);
    expect(metadata.performanceBudget.worstFrameMs).toBeLessThanOrEqual(33);
    expect(filterSecrets(fixtureCache().secrets, "proxy", "").map((row) => row.name)).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
  });
});

describe("company deployment rows (QA-013)", () => {
  it("uses the legacy subdomain field instead of a placeholder name", () => {
    const row = legacyDeploymentRow({ sub: "board-v2", url: "board-v2.indigo-hq.com", state: "active" }, "indigo", 0);
    expect(row.name).toBe("board-v2");
    expect(row.url).toBe("https://board-v2.indigo-hq.com");
  });

  it("maps hq-deploy apps through the shared client mapping", () => {
    const rows = companyDeploymentRows(
      { apps: [{ id: "1", name: "real", subdomain: "real", url: "https://real.indigo-hq.com", active: false }, 7] },
      "indigo",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("real");
    expect(rows[0]!.status).toBe("off");
  });
});

describe("findDeploySources (QA-044)", () => {
  const d = (path: string) => ({ name: path.split("/").pop()!, path, isDir: true });
  const f = (path: string) => ({ name: path.split("/").pop()!, path, isDir: false });
  const P = "companies/acme/projects";

  it("lists project folders that hold an index.html, from the real listing", async () => {
    const tree: Record<string, ReturnType<typeof d>[]> = {
      [P]: [d(`${P}/site`), d(`${P}/notes`)],
      [`${P}/site`]: [d(`${P}/site/dist`), d(`${P}/site/node_modules`)],
      [`${P}/site/dist`]: [f(`${P}/site/dist/index.html`)],
      [`${P}/site/node_modules`]: [f(`${P}/site/node_modules/index.html`)],
      [`${P}/notes`]: [f(`${P}/notes/README.md`)],
    };
    const scan = await findDeploySources("acme", async (path) => tree[path] ?? []);
    expect(scan.reason).toBeNull();
    expect(scan.sources).toEqual([{ id: `${P}/site/dist`, project: "site", path: `${P}/site/dist`, dir: "dist" }]);
  });

  it("says why nothing is deployable", async () => {
    const none = await findDeploySources("acme", async () => []);
    expect(none.sources).toEqual([]);
    expect(none.reason).toMatch(/no projects yet/);
    const unbuilt = await findDeploySources("acme", async (path) => (path === P ? [d(`${P}/a`), d(`${P}/b`)] : []));
    expect(unbuilt.reason).toMatch(/None of this company's 2 projects has a built web page/);
  });

  it("throws when the projects folder cannot be read", async () => {
    await expect(findDeploySources("acme", async () => { throw new Error("denied"); })).rejects.toThrow("denied");
  });
});
