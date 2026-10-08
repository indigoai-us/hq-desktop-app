import { describe, expect, it, vi } from "vitest";
import {
  connectedLabel,
  googleIntegrationsFromBody,
  integrationsErrorReason,
  loadPersonalIntegrations,
  slackIntegrationsFromBody,
} from "./personal-integrations.js";

describe("personal integrations loader", () => {
  it("maps the Google accounts payload with sources in console order", () => {
    const rows = googleIntegrationsFromBody({
      accounts: [{ accountId: "g1", email: "me@example.com", scope: "x", connectedAt: "2026-09-30T00:00:00Z", capabilities: ["sheets", "gmail", "calendar"] }, { email: "no-id" }],
    });
    expect(rows).toEqual([{ id: "google:g1", provider: "google", accountId: "g1", app: "Google", identity: "me@example.com", status: "active", connectedAt: "2026-09-30T00:00:00Z", sources: ["Calendar", "Gmail", "Sheets"] }]);
  });

  it("matches capabilities case-insensitively and tolerates non-array capabilities", () => {
    const rows = googleIntegrationsFromBody({ accounts: [{ accountId: "g1", capabilities: ["GMAIL", "Drive"] }, { accountId: "g2", capabilities: "gmail" }] });
    expect(rows.map((row) => row.sources)).toEqual([["Drive", "Gmail"], []]);
  });

  it("maps personal Slack and flags reconnect", () => {
    const rows = slackIntegrationsFromBody({ accounts: [{ accountId: "s1", slackUserDisplay: "Corey", teamName: "Acme", connectedAt: "", reconnectNeeded: true }] });
    expect(rows[0]).toMatchObject({ id: "slack:s1", app: "Slack (personal)", identity: "Corey · Acme", status: "reconnect", sources: [] });
  });

  it("tolerates malformed bodies", () => {
    expect(googleIntegrationsFromBody(null)).toEqual([]);
    expect(slackIntegrationsFromBody({ accounts: "nope" })).toEqual([]);
  });

  it("keeps one provider's rows when the other fails", async () => {
    const rows = await loadPersonalIntegrations({
      listMyGoogleAccounts: vi.fn(async () => ({ ok: false as const, reason: "error" as const, code: "http-500" })),
      listMySlackAccounts: vi.fn(async () => ({ ok: true as const, value: { accounts: [{ accountId: "s1" }] } })),
    });
    expect(rows.map((r) => r.id)).toEqual(["slack:s1"]);
  });

  it("throws plain copy when every provider fails or none exist", async () => {
    await expect(loadPersonalIntegrations(null)).rejects.toThrow("not available in this window");
    await expect(
      loadPersonalIntegrations({ listMyGoogleAccounts: vi.fn(async () => ({ ok: false as const, reason: "error" as const, code: "http-401" })) }),
    ).rejects.toThrow("sign-in expired");
  });

  it("error copy never echoes raw codes", () => {
    for (const code of ["http-500", "http-404", "network", ""]) {
      expect(integrationsErrorReason(code)).not.toMatch(/http|\d{3}/);
    }
  });

  it("formats the connected date and skips bad dates", () => {
    expect(connectedLabel("2026-09-30T12:00:00Z")).toBe("Connected Sep 30, 2026");
    expect(connectedLabel("")).toBe("");
    expect(connectedLabel("garbage")).toBe("");
  });
});
