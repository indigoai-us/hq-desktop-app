import { describe, expect, it } from "vitest";

import type { FoundMcpServer, FoundWorkApps } from "@hq/platform";

import { APP_SIGNATURES, SIGNATURE_DOMAINS, evidenceLine, matchFoundApps, readCatalogLookup } from "./found-apps.js";

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
