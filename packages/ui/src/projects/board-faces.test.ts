import { describe, expect, it } from "vitest";
import {
  BOT_FACE_MARK,
  boardFaces,
  faceInitials,
  facesCaption,
} from "./board-faces.js";

describe("boardFaces", () => {
  it("puts humans first and bots after", () => {
    const faces = boardFaces(["Corey Epstein"], ["deacon"]);
    expect(faces).toEqual([
      { kind: "human", label: "Corey Epstein", mark: "CE" },
      { kind: "bot", label: "deacon", mark: BOT_FACE_MARK },
    ]);
    expect(facesCaption(faces)).toBe("Corey + deacon");
  });

  it("dedupes humans and caps the stack", () => {
    const faces = boardFaces(["a b", "A B", "c"], ["x", "y"], 3);
    expect(faces.map((f) => f.kind)).toEqual(["human", "human", "bot"]);
  });

  it("keeps one face per unnamed live bot session", () => {
    expect(boardFaces([], ["", "bot"]).length).toBe(2);
  });

  it("derives initials from emails", () => {
    expect(faceInitials("corey@vyg.ai")).toBe("CO");
  });
});
