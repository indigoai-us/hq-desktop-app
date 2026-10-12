import { describe, expect, it } from "vitest";

import type { FoundMcpServer, FoundWorkApps } from "@hq/platform";

import {
  APP_SIGNATURES,
  SIGNATURE_DOMAINS,
  bareAppName,
  evidenceLine,
  lookupSignatureCatalog,
  matchFoundApps,
  readCatalogLookup,
} from "./found-apps.js";

function server(over: Partial<FoundMcpServer>): FoundMcpServer {
  return {
    tool: "claude_code",
    name: "x",
    transport: "http",
    host: null,
    local: false,
    hasCredentialFields: false,
    enabled: true,
    ...over,
  };
}

function scan(over: Partial<FoundWorkApps>): FoundWorkApps {
  return { platform: "macos", scannedAtMs: 1, apps: [], mcpServers: [], sources: [], truncated: false, ...over };
}

describe("signature table", () => {
  it("has one row per domain with a name and a kind", () => {
    const domains = APP_SIGNATURES.map((s) => s.domain);
    expect(new Set(domains).size).toBe(domains.length);
    for (const s of APP_SIGNATURES) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.domain).toMatch(/^[a-z0-9.-]+\.[a-z]+$/);
      if (s.docsUrl) expect(s.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it("never claims a bundle id, app name or MCP name twice", () => {
    const seen = new Map<string, string>();
    for (const s of APP_SIGNATURES) {
      for (const key of [...(s.bundleIds ?? []).map((b) => `b:${b.toLowerCase()}`), ...(s.appNames ?? []).map((n) => `a:${n.toLowerCase().replace(/[^a-z0-9]/g, "")}`), ...(s.mcpNames ?? []).map((n) => `m:${n.toLowerCase().replace(/[^a-z0-9]/g, "")}`)]) {
        expect(seen.get(key), key).toBeUndefined();
        seen.set(key, s.domain);
      }
    }
  });

  it("is exactly the offerable, non-native signature domains", () => {
    expect(SIGNATURE_DOMAINS).toEqual(APP_SIGNATURES.filter((s) => !s.exclude && !s.native).map((s) => s.domain));
    expect(SIGNATURE_DOMAINS).toMatchInlineSnapshot(`
      [
        "fireflies.ai",
        "granola.ai",
        "fathom.video",
        "otter.ai",
        "loom.com",
        "zoom.us",
        "teams.microsoft.com",
        "linear.app",
        "atlassian.com",
        "asana.com",
        "clickup.com",
        "monday.com",
        "todoist.com",
        "notion.com",
        "obsidian.md",
        "figma.com",
        "miro.com",
        "hubspot.com",
        "discord.com",
        "supabase.com",
        "airtable.com",
        "posthog.com",
        "sentry.io",
        "github.com",
        "api.aws",
        "cloudflare.com",
        "vercel.com",
        "stripe.com",
      ]
    `);
  });

  it("asks the catalog about the same fixed list every time, never excluded or native apps", () => {
    expect(SIGNATURE_DOMAINS).toContain("linear.app");
    expect(SIGNATURE_DOMAINS).toContain("zoom.us");
    expect(SIGNATURE_DOMAINS).not.toContain("1password.com");
    expect(SIGNATURE_DOMAINS).not.toContain("slack.com");
    expect(SIGNATURE_DOMAINS).not.toContain("claude.ai");
  });
});

describe("matchFoundApps", () => {
  it("maps bundles, app names, MCP hosts and MCP names to one app per domain", () => {
    const result = matchFoundApps(
      scan({
        apps: [
          { bundleId: "com.linear", name: "Linear" },
          { bundleId: null, name: "Microsoft Teams (work or school)" },
          { bundleId: "us.zoom.xos", name: "zoom.us" },
          { bundleId: "com.1password.1password", name: "1Password" },
          { bundleId: "dev.example.unknown", name: "Unknown Tool" },
        ],
        mcpServers: [
          server({ tool: "claude_code", name: "linear-server", host: "mcp.linear.app" }),
          server({ tool: "codex", name: "supabase", transport: "stdio" }),
          server({ tool: "claude_code", name: "supabase", host: "mcp.supabase.com" }),
          server({ tool: "cursor", name: "anything", host: "eu.mcp.posthog.com" }),
          server({ tool: "codex", name: "linear", local: true }),
          server({ tool: "codex", name: "my-internal", host: "tools.example.org" }),
        ],
      }),
    );
    const by = new Map(result.apps.map((a) => [a.domain, a]));
    expect(by.get("linear.app")?.evidence).toEqual({ app: true, tools: ["claude_code"] });
    expect(by.get("supabase.com")?.evidence).toEqual({ app: false, tools: ["codex", "claude_code"] });
    expect(by.get("posthog.com")?.evidence.tools).toEqual(["cursor"]);
    expect(by.get("teams.microsoft.com")?.evidence.app).toBe(true);
    expect(by.get("zoom.us")?.docsUrl).toMatch(/^https:\/\/developers\.zoom\.us\//);
    expect(by.get("1password.com")?.excluded).toBe(true);
    // The unknown app and the unknown remote server are counted, not named.
    expect(result.unmatched).toBe(2);
    // A local server is neither matched by name nor counted.
    expect(by.get("linear.app")?.evidence.tools).not.toContain("codex");
  });

  it("keeps signature-table order and marks native providers", () => {
    const result = matchFoundApps(
      scan({ apps: [{ bundleId: "com.tinyspeck.slackmacgap", name: "Slack" }, { bundleId: "com.linear", name: "Linear" }] }),
    );
    expect(result.apps.map((a) => a.domain)).toEqual(["linear.app", "slack.com"]);
    expect(result.apps[1]?.native).toBe("slack");
  });

  it("does not match a host that only ends with the same letters", () => {
    const result = matchFoundApps(scan({ mcpServers: [server({ name: "evil", host: "notlinear.app" })] }));
    expect(result.apps).toEqual([]);
    expect(result.unmatched).toBe(1);
  });

  it("answers nothing for a missing scan or odd shapes", () => {
    expect(matchFoundApps(null)).toEqual({ apps: [], unmatched: 0 });
    expect(matchFoundApps({ apps: null, mcpServers: undefined } as unknown as FoundWorkApps)).toEqual({ apps: [], unmatched: 0 });
  });
});

describe("evidenceLine", () => {
  it("names the AI tools, or the computer for an installed app", () => {
    expect(evidenceLine({ app: true, tools: [] })).toBe("Mac app");
    expect(evidenceLine({ app: true, tools: [] }, "PC")).toBe("PC app");
    expect(evidenceLine({ app: false, tools: ["claude_code"] })).toBe("In Claude Code");
    expect(evidenceLine({ app: true, tools: ["claude_code", "codex"] })).toBe("In Claude Code and Codex");
    expect(evidenceLine({ app: false, tools: ["claude_code", "cursor", "codex"] })).toBe("In Claude Code, Cursor and Codex");
    expect(evidenceLine({ app: false, tools: [] })).toBe("");
  });
});

describe("readCatalogLookup", () => {
  it("reads one match per requested domain and null for the rest", () => {
    const read = readCatalogLookup(
      {
        ok: true,
        companyUid: "cmp_acme",
        matches: {
          "linear.app": { name: "Linear", domain: "linear.app", authClass: "oauth", entryId: "e1" },
          "api.aws": { name: "AWS Knowledge", authClass: "none", entryId: "e2" },
          "zoom.us": null,
          "posthog.com": { name: "PostHog", authClass: "weird" },
        },
      },
      ["linear.app", "api.aws", "zoom.us", "posthog.com", "vercel.com"],
    );
    expect(read).toEqual({
      "linear.app": { entryId: "e1", name: "Linear", authClass: "oauth" },
      "api.aws": { entryId: "e2", name: "AWS Knowledge", authClass: "none" },
      "zoom.us": null,
      "posthog.com": { entryId: null, name: "PostHog", authClass: null },
      "vercel.com": null,
    });
  });

  it("is null for anything not shaped like the answer", () => {
    expect(readCatalogLookup(null)).toBeNull();
    expect(readCatalogLookup({ ok: true })).toBeNull();
    expect(readCatalogLookup({ matches: [] })).toBeNull();
  });
});

describe("Windows app names", () => {
  it("drops installer decorations and versions", () => {
    expect(bareAppName("Zoom Workplace (64-bit)")).toBe("Zoom Workplace");
    expect(bareAppName("Slack (Machine - MSI)")).toBe("Slack");
    expect(bareAppName("Cursor (User)")).toBe("Cursor");
    expect(bareAppName("Notion 3.14.0")).toBe("Notion");
    expect(bareAppName("ClickUp v3.5.1 (User)")).toBe("ClickUp");
    expect(bareAppName("zoom.us")).toBe("zoom.us");
    expect(bareAppName("1Password")).toBe("1Password");
  });

  it("matches the decorated names an uninstall list carries", () => {
    const result = matchFoundApps(
      scan({
        platform: "windows",
        apps: [
          { bundleId: null, name: "Zoom Workplace (64-bit)" },
          { bundleId: null, name: "Notion 3.14.0" },
          { bundleId: null, name: "Slack (Machine - MSI)" },
        ],
      }),
    );
    expect(result.apps.map((a) => a.domain).sort()).toEqual(["notion.com", "slack.com", "zoom.us"]);
  });
});

describe("server matching", () => {
  it("does not take a remote server's name when its host is unrelated", () => {
    const result = matchFoundApps(scan({ mcpServers: [server({ name: "github", host: "tools.example.org" })] }));
    expect(result.apps).toEqual([]);
  });

  it("matches AWS Knowledge only on its MCP host, not any api.aws service host", () => {
    const aws = matchFoundApps(scan({ mcpServers: [server({ name: "k", host: "knowledge-mcp.global.api.aws" })] }));
    expect(aws.apps.map((a) => a.domain)).toEqual(["api.aws"]);
    const other = matchFoundApps(scan({ mcpServers: [server({ name: "s3", host: "s3.us-east-1.api.aws" })] }));
    expect(other.apps).toEqual([]);
  });
});

describe("lookupSignatureCatalog", () => {
  it("always sends the whole fixed list and reads the answer", async () => {
    const sent: (readonly string[])[] = [];
    const read = await lookupSignatureCatalog(
      {
        catalogLookup: async (_uid, domains) => {
          sent.push(domains);
          return { ok: true, value: { ok: true, companyUid: "cmp_acme", matches: { "linear.app": { name: "Linear", authClass: "oauth", entryId: "e1" } } } };
        },
      },
      "cmp_acme",
    );
    expect(sent).toEqual([SIGNATURE_DOMAINS]);
    expect(read?.["linear.app"]).toEqual({ entryId: "e1", name: "Linear", authClass: "oauth" });
    expect(read?.["zoom.us"]).toBeNull();
  });

  it("is null without the method, on failure, or on a refused answer", async () => {
    expect(await lookupSignatureCatalog(null, "c")).toBeNull();
    expect(await lookupSignatureCatalog({}, "c")).toBeNull();
    expect(await lookupSignatureCatalog({ catalogLookup: async () => ({ ok: false }) }, "c")).toBeNull();
    expect(await lookupSignatureCatalog({ catalogLookup: async () => { throw new Error("x"); } }, "c")).toBeNull();
    expect(readCatalogLookup({ ok: false, matches: {} })).toBeNull();
  });
});
