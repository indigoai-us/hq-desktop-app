import { describe, expect, it } from "vitest";

import { copyableText, promptPreview } from "./conversation-copy.js";

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

describe("promptPreview", () => {
  it("returns the full text when it fits", () => {
    expect(promptPreview("short")).toBe("short");
  });

  it("clips on a word boundary and adds an ellipsis", () => {
    const text = `${"word ".repeat(50)}END`;
    const preview = promptPreview(text, 40);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThan(text.length);
    expect(preview.includes("END")).toBe(false);
  });
});
