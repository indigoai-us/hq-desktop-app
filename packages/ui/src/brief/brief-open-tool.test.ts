// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIEF_OPEN_TOOL_KEY,
  briefOpenToolConnectorId,
  briefOpenToolContext,
  briefOpenToolLabel,
  forgetBriefOpenTool,
  readBriefOpenTool,
  readBriefOpenToolInstalled,
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
    expect(readBriefOpenToolInstalled()).toBe(false);
    rememberBriefOpenTool("codex", true);
    expect(window.localStorage.getItem(BRIEF_OPEN_TOOL_KEY)).toBe("codex");
    expect(readBriefOpenTool()).toBe("codex");
    expect(readBriefOpenToolInstalled()).toBe(true);
    forgetBriefOpenTool();
    expect(readBriefOpenTool()).toBeNull();
    expect(readBriefOpenToolInstalled()).toBe(false);
  });

  it("does not treat a remembered tool as installed unless the install returned ok", () => {
    rememberBriefOpenTool("claude", false);
    expect(readBriefOpenTool()).toBe("claude");
    expect(readBriefOpenToolInstalled()).toBe(false);
    window.localStorage.setItem(BRIEF_OPEN_TOOL_KEY, "claude");
    window.localStorage.removeItem("hq.brief.open-tool-installed");
    expect(readBriefOpenToolInstalled()).toBe(false);
  });

  it("says the tool is set up only after a successful install", () => {
    const setUp = briefOpenToolContext("claude", true);
    const notSetUp = briefOpenToolContext("codex", false);
    expect(setUp).toBe("Claude Code is set up with HQ. Open it to keep working there.");
    expect(briefOpenToolContext("codex", true)).toBe("Codex is set up with HQ. Open it to keep working there.");
    expect(notSetUp).toBe("HQ is not installed in Codex yet. You can still open it.");
    for (const line of [setUp, notSetUp, briefOpenToolContext("grok", false)]) {
      expect(line).not.toMatch(/[–—!]/);
    }
    expect(briefOpenToolConnectorId("claude")).toBe("claude-code");
    expect(briefOpenToolConnectorId("codex")).toBe("codex");
    expect(briefOpenToolConnectorId("grok")).toBeNull();
    expect(briefOpenToolConnectorId(null)).toBeNull();
  });

  it("ignores a stored value that is not a coding tool", () => {
    window.localStorage.setItem(BRIEF_OPEN_TOOL_KEY, "cursor");
    expect(readBriefOpenTool()).toBeNull();
  });
});
