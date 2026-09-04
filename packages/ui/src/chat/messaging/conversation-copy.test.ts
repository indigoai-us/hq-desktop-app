import { describe, expect, it } from "vitest";

import { copyableText } from "./conversation-copy.js";

describe("copyableText", () => {
  it("returns the prompt when asked, else the visible body + details", () => {
    const msg = {
      body: "Here's the recap",
      details: "line two",
      prompt: "  Full agent report…  ",
    };
    expect(copyableText(msg, "prompt")).toBe("Full agent report…");
    expect(copyableText(msg, "details")).toBe("line two");
    expect(copyableText(msg, "body")).toBe("Here's the recap\n\nline two");
  });

  it("returns null when the requested field is empty", () => {
    expect(copyableText({ body: "hi" }, "prompt")).toBeNull();
    expect(copyableText({ body: "  ", details: "" }, "body")).toBeNull();
  });
});
