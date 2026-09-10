import { describe, expect, it } from "vitest";
import {
  boardTaskGeneratePrompt,
  messageTaskGeneratePrompt,
} from "./task-generate";

describe("task generate prompts", () => {
  it("treats board fields as a seed, not the finished task", () => {
    const text = boardTaskGeneratePrompt({
      title: "Fix login",
      description: "session work",
      projectId: "hq-desktop-sessions-testing",
    });
    expect(text).toContain("starting point");
    expect(text).toContain("Fix login");
    expect(text).toContain("acceptanceCriteria");
    expect(text).toContain("Do not leave a UUID stub");
  });

  it("includes message, notes, and thread", () => {
    const text = messageTaskGeneratePrompt({
      projectId: "demo",
      messageBody: "We should add delete",
      notes: "confirm step",
      thread: [{ author: "Stefan", body: "We should add delete" }],
    });
    expect(text).toContain("We should add delete");
    expect(text).toContain("confirm step");
    expect(text).toContain("Stefan");
  });
});
