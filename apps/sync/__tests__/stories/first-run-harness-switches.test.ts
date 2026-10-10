// The preview harness's switches for the visual first run's "Your team",
// Note taker and Project management screens (dev-harness/first-run-fixtures.ts).
// Preview only: off unless the URL names them, and only with ?firstrun=.
import { afterEach, describe, expect, it, vi } from "vitest";

import { firstRunSwitch, resetHarnessSignIns, switchedHandler } from "../../dev-harness/audit-switches";
import { appsSwitch, firstRunScreensAnswer, teamSwitch, teamWorkspaces } from "../../dev-harness/first-run-fixtures";

describe("first-run harness switches", () => {
  it("are off by default and accept only their listed values", () => {
    expect(teamSwitch("")).toBeNull();
    expect(appsSwitch("")).toBeNull();
    expect(teamSwitch("?team=bogus")).toBeNull();
    expect(appsSwitch("?apps=1")).toBeNull();
    expect(teamSwitch("?team=invites")).toBe("invites");
    expect(appsSwitch("?apps=forbidden")).toBe("forbidden");
    expect(firstRunScreensAnswer("list_syncable_workspaces", undefined, "")).toBeUndefined();
  });

  it("only answer under a ?firstrun= switch", () => {
    expect(switchedHandler("list_syncable_workspaces", undefined, "?team=member")).toBeUndefined();
    const answer = switchedHandler("list_syncable_workspaces", undefined, "?firstrun=visual&team=member") as {
      value: { workspaces: Array<{ slug: string; membershipStatus: string | null }> };
    };
    expect(answer.value.workspaces.map((w) => w.slug)).toEqual(["personal", "acme-robotics"]);
  });

  it("give each roster its shape", () => {
    const pending = (kind: Parameters<typeof teamWorkspaces>[0]) =>
      teamWorkspaces(kind).filter((w) => w.membershipStatus === "pending").length;
    expect(pending("invites")).toBe(2);
    expect(pending("member")).toBe(0);
    expect(teamWorkspaces("many").length).toBeGreaterThan(12);
  });

  it("refuse the catalog read under ?apps=forbidden", () => {
    const answer = firstRunScreensAnswer(
      "hq_pro_fetch",
      { url: "/v1/integrations/factory/catalog?companyUid=cmp_acme&query=&limit=100" },
      "?apps=forbidden",
    ) as { value: { status: number } };
    expect(answer.value.status).toBe(403);
  });
});

describe("first-run harness: coding tools sign-in switches", () => {
  afterEach(() => {
    resetHarnessSignIns();
    vi.useRealTimers();
  });

  const preflight = (search: string) =>
    (switchedHandler("agent_session_preflight", undefined, search) as { value: Record<string, unknown> }).value;
  const call = (cmd: string, tool: string, search: string) =>
    (switchedHandler(cmd, { tool }, search) as { value: { state: string } }).value.state;

  it("accept the new switches", () => {
    expect(firstRunSwitch("?firstrun=visual-signin")).toBe("visual-signin");
    expect(firstRunSwitch("?firstrun=visual-signin-fail")).toBe("visual-signin-fail");
    expect(firstRunSwitch("?firstrun=visual-desktop")).toBe("visual-desktop");
    expect(firstRunSwitch("?firstrun=visual-bogus")).toBeNull();
  });

  it("visual-signin: no tool signed in, then Sign in finishes after ?loadingMs and the tool reads as signed in", () => {
    vi.useFakeTimers();
    const search = "?firstrun=visual-signin&loadingMs=1000";
    expect(preflight(search)).toMatchObject({ claudeLoggedIn: false, codexLoggedIn: false, codexStatus: { state: "signedOut" } });
    expect(call("agent_provider_login_start", "codex", search)).toBe("waiting");
    expect(call("agent_provider_login_status", "codex", search)).toBe("waiting");
    vi.advanceTimersByTime(1000);
    expect(call("agent_provider_login_status", "codex", search)).toBe("connected");
    expect(preflight(search)).toMatchObject({ codexAvailable: true, codexLoggedIn: true, codexStatus: { state: "signedIn" } });
  });

  it("visual-signin-fail: the sign-in ends without signing in", () => {
    vi.useFakeTimers();
    const search = "?firstrun=visual-signin-fail&loadingMs=500";
    call("agent_provider_login_start", "claude", search);
    vi.advanceTimersByTime(500);
    expect(call("agent_provider_login_status", "claude", search)).toBe("error");
    expect(preflight(search)).toMatchObject({ claudeLoggedIn: false });
  });

  it("visual-desktop: Claude Desktop without Claude Code, and Codex that can sign in", () => {
    const search = "?firstrun=visual-desktop";
    expect(preflight(search)).toMatchObject({ claudeAvailable: false, claudeStatus: { state: "notInstalled" }, codexStatus: { state: "signedOut" } });
    const tools = (switchedHandler("detect_ai_tools", undefined, search) as { value: Record<string, boolean> }).value;
    expect(tools).toMatchObject({ claude_desktop: true, claude_cli: false });
  });

  it("visual still has a tool signed in", () => {
    expect(preflight("?firstrun=visual")).toMatchObject({ claudeLoggedIn: true, claudeStatus: { state: "signedIn" } });
  });
});
