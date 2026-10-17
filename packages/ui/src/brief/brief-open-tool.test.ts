// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIEF_OPEN_TOOL_KEY,
  briefOpenToolLabel,
  forgetBriefOpenTool,
  readBriefOpenTool,
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
    rememberBriefOpenTool("codex");
    expect(window.localStorage.getItem(BRIEF_OPEN_TOOL_KEY)).toBe("codex");
    expect(readBriefOpenTool()).toBe("codex");
    forgetBriefOpenTool();
    expect(readBriefOpenTool()).toBeNull();
  });

  it("ignores a stored value that is not a coding tool", () => {
    window.localStorage.setItem(BRIEF_OPEN_TOOL_KEY, "cursor");
    expect(readBriefOpenTool()).toBeNull();
  });
});
