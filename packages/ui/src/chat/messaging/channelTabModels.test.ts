import { describe, expect, it } from "vitest";
import {
  BOARD_STAGE_ORDER,
  DEFAULT_VISIBLE_BOARD_STAGES,
  resolveBoardColumns,
  toggleBoardStage,
  type BoardColumnModel,
} from "./channelTabModels";

const injected: BoardColumnModel[] = [
  {
    id: "done",
    title: "Done",
    cards: [{ storyId: "US-001", label: "Send the brief", statusLine: "DONE" }],
  },
];

describe("board column filter", () => {
  it("defaults to To do, Doing, and Done", () => {
    expect(DEFAULT_VISIBLE_BOARD_STAGES).toEqual([
      "queued",
      "in_progress",
      "done",
    ]);
    expect(BOARD_STAGE_ORDER).toEqual([
      "queued",
      "in_progress",
      "review",
      "done",
    ]);
  });

  it("keeps empty stage columns when the host only sent Done", () => {
    const columns = resolveBoardColumns(injected, DEFAULT_VISIBLE_BOARD_STAGES);
    expect(columns.map((c) => [c.id, c.cards.length, c.title])).toEqual([
      ["queued", 0, "To do"],
      ["in_progress", 0, "Doing"],
      ["done", 1, "Done"],
    ]);
  });

  it("can reveal Waiting and hide To do", () => {
    const withReview = toggleBoardStage(DEFAULT_VISIBLE_BOARD_STAGES, "review");
    expect(withReview).toEqual(["queued", "in_progress", "review", "done"]);
    const withoutQueued = toggleBoardStage(withReview, "queued");
    expect(withoutQueued).toEqual(["in_progress", "review", "done"]);
    expect(
      resolveBoardColumns(injected, withoutQueued).map((c) => c.id),
    ).toEqual(["in_progress", "review", "done"]);
  });
});
