import { describe, expect, it } from "vitest";
import {
  classifyTasks,
  taskPaneStatus,
  type Story,
} from "./projects-model.js";

function story(id: string, extra: Partial<Story> = {}): Story {
  return {
    id,
    title: id,
    description: "",
    acceptanceCriteria: [],
    passes: false,
    labels: [],
    dependsOn: [],
    ...extra,
  };
}

// QA-036: the task list grouped a started task under In progress while the
// task pane badge read To do. Both must come from the same task-column rule.
describe("taskPaneStatus (QA-036)", () => {
  it("matches the task list column for a started task with no live run", () => {
    const stories = [
      story("US-005", { passes: true }),
      story("US-006", { notes: "backtest started" }),
      story("US-007"),
    ];
    const listColumn = classifyTasks(stories, []).find(
      (t) => t.story.id === "US-006",
    )?.column;
    expect(listColumn).toBe("in-progress");
    const pane = taskPaneStatus(stories[1], stories, []);
    expect(pane.column).toBe(listColumn);
    expect(pane.label).toBe("In progress");
  });

  it("agrees with the list for every story", () => {
    const stories = [
      story("US-001", { passes: true }),
      story("US-002"),
      story("US-003", { dependsOn: ["US-002"] }),
    ];
    for (const item of classifyTasks(stories, [])) {
      expect(taskPaneStatus(item.story, stories, []).column).toBe(item.column);
    }
  });

  it("follows the To do / Done control's pending passes write", () => {
    const stories = [story("US-006", { notes: "started" })];
    expect(taskPaneStatus(stories[0], stories, [], true).label).toBe("Complete");
    const done = [story("US-006", { passes: true, notes: "started" })];
    expect(taskPaneStatus(done[0], done, [], false).label).toBe("In progress");
  });
});
