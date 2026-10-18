// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIEF_OPEN_TOOL_KEY,
  BRIEF_INSTALL_QUEUE_ITEM,
  briefInstallAfterCheck,
  briefInstallAfterSettle,
  briefInstallQueueStillRunning,
  briefOpenToolConnectorId,
  briefOpenToolContext,
  briefOpenToolLabel,
  briefOpenToolView,
  forgetBriefOpenTool,
  readBriefOpenTool,
  readBriefOpenToolSettle,
  rememberBriefOpenTool,
} from "./brief-open-tool";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("brief open tool", () => {
  it("names Claude Code and Codex the way the welcome edition does", () => {
    expect(briefOpenToolLabel("claude")).toBe("Open Claude Code");
    expect(briefOpenToolLabel("codex")).toBe("Open Codex");
    expect(briefOpenToolLabel("claude")).not.toMatch(/[–—!]/);
    expect(briefOpenToolLabel("codex")).not.toMatch(/[–—!]/);
  });

  it("remembers the Continue choice and forgets it for a new first run", () => {
    expect(readBriefOpenTool()).toBeNull();
    expect(readBriefOpenToolSettle()).toBe("skipped");
    rememberBriefOpenTool("codex", "installed");
    expect(window.localStorage.getItem(BRIEF_OPEN_TOOL_KEY)).toBe("codex");
    expect(readBriefOpenTool()).toBe("codex");
    expect(readBriefOpenToolSettle()).toBe("installed");
    forgetBriefOpenTool();
    expect(readBriefOpenTool()).toBeNull();
    expect(readBriefOpenToolSettle()).toBe("skipped");
  });

  it("does not treat a remembered tool as installed unless the install returned ok", () => {
    rememberBriefOpenTool("claude", "skipped");
    expect(readBriefOpenTool()).toBe("claude");
    expect(readBriefOpenToolSettle()).toBe("skipped");
    window.localStorage.setItem(BRIEF_OPEN_TOOL_KEY, "claude");
    window.localStorage.setItem("hq.brief.open-tool-installed", "1");
    expect(readBriefOpenToolSettle()).toBe("installed");
    window.localStorage.setItem("hq.brief.open-tool-installed", "0");
    expect(readBriefOpenToolSettle()).toBe("skipped");
    window.localStorage.setItem("hq.brief.open-tool-installed", "pending");
    expect(readBriefOpenToolSettle()).toBe("pending");
    window.localStorage.removeItem("hq.brief.open-tool-installed");
    expect(readBriefOpenToolSettle()).toBe("skipped");
  });

  it("says the tool is set up only when HQ is installed, and keeps a slow install pending", () => {
    const setUp = briefOpenToolContext("claude", "installed");
    const pending = briefOpenToolContext("claude", "pending");
    const failed = briefOpenToolContext("claude", "failed");
    const folder = briefOpenToolContext("claude", "folder");
    expect(setUp).toBe("Claude Code is set up with HQ. Open it to keep working there.");
    expect(briefOpenToolContext("codex", "installed")).toBe("Codex is set up with HQ. Open it to keep working there.");
    expect(pending).toBe("HQ is still setting up in Claude Code. You can open it in your HQ folder.");
    expect(briefOpenToolContext("codex", "pending")).toBe("HQ is still setting up in Codex. You can open it in your HQ folder.");
    expect(failed).toBe("HQ is not installed in Claude Code yet. You can try again from Settings.");
    expect(folder).toBe("Open Claude Code in your HQ folder to keep working there.");
    expect(briefOpenToolContext("codex", "folder")).toBe("Open Codex in your HQ folder to keep working there.");
    for (const line of [setUp, pending, failed, folder, briefOpenToolContext("grok", "folder")]) {
      expect(line).not.toMatch(/[–—!]/);
    }
    expect(briefOpenToolConnectorId("claude")).toBe("claude-code");
    expect(briefOpenToolConnectorId("codex")).toBe("codex");
    expect(briefOpenToolConnectorId("grok")).toBeNull();
    expect(briefOpenToolConnectorId(null)).toBeNull();
  });

  it("a live check promotes a slow install and clears a setup that was removed", () => {
    expect(briefOpenToolView("pending", null)).toBe("pending");
    expect(briefOpenToolView("pending", false, true)).toBe("pending");
    expect(briefOpenToolView("pending", true)).toBe("installed");
    expect(briefInstallAfterSettle("pending", true)).toBe("installed");
    expect(briefInstallAfterSettle("pending", false)).toBe("failed");
    expect(briefInstallAfterSettle("installed", false)).toBe("installed");
    expect(briefOpenToolView("installed", false)).toBe("folder");
    expect(briefInstallAfterCheck("installed", false)).toBe("skipped");
    expect(briefOpenToolView("installed", true)).toBe("installed");
    expect(briefOpenToolView("failed", false)).toBe("failed");
    expect(briefOpenToolView("failed", true)).toBe("installed");
    expect(briefInstallAfterCheck("failed", true)).toBe("installed");
    expect(briefInstallAfterCheck("pending", false, true)).toBe("pending");
    expect(briefOpenToolView("skipped", false)).toBe("folder");
    expect(briefOpenToolView("skipped", null)).toBe("folder");
  });

  it("after a restart, pending plus not installed is a failure unless that install is still running", () => {
    expect(briefInstallAfterCheck("pending", false)).toBe("failed");
    expect(briefOpenToolView("pending", false)).toBe("failed");
    expect(briefOpenToolContext("claude", "failed")).toBe(
      "HQ is not installed in Claude Code yet. You can try again from Settings.",
    );
    expect(briefOpenToolContext("codex", briefOpenToolView("pending", false))).toBe(
      "HQ is not installed in Codex yet. You can try again from Settings.",
    );
    expect(briefInstallQueueStillRunning(null)).toBe(false);
    expect(briefInstallQueueStillRunning({ state: "running", currentId: "node" })).toBe(false);
    expect(briefInstallQueueStillRunning({ state: "idle", currentId: BRIEF_INSTALL_QUEUE_ITEM })).toBe(false);
    expect(briefInstallQueueStillRunning({ state: "running", currentId: BRIEF_INSTALL_QUEUE_ITEM })).toBe(true);
    expect(briefInstallAfterCheck("pending", false, true)).toBe("pending");
    expect(briefOpenToolView("pending", false, true)).toBe("pending");
  });

  it("ignores a stored value that is not a coding tool", () => {
    window.localStorage.setItem(BRIEF_OPEN_TOOL_KEY, "cursor");
    expect(readBriefOpenTool()).toBeNull();
  });
});
