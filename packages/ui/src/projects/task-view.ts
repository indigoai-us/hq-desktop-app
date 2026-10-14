/**
 * Task view pane model (console-rail US-024). Pure helpers so the pane can
 * paint from cached stories in the click frame and stay testable.
 */
import { provenanceView } from "../common/provenance.js";
import {
  isPortfolioLiveStatus,
  type PortfolioSessionRef,
} from "../chat/portfolio-session.js";
import { liveSessionsForStory, type Story } from "./projects-model.js";

export type TaskMark = "done" | "live" | "open";

/** Live sessions on a task: the bound server task id, then the id-token match. */
export function taskSessions(
  story: Story,
  sessions: readonly PortfolioSessionRef[],
): PortfolioSessionRef[] {
  const bound = sessions.filter(
    (s) => s.taskId === story.id && isPortfolioLiveStatus(s.status),
  );
  const matched = liveSessionsForStory(story, sessions);
  return [...bound, ...matched.filter((s) => !bound.includes(s))];
}

export function taskMark(
  story: Story,
  sessions: readonly PortfolioSessionRef[],
): TaskMark {
  if (story.passes) return "done";
  return taskSessions(story, sessions).length > 0 ? "live" : "open";
}

/** First live task, else first open task, else the first task. */
export function defaultTaskId(
  stories: readonly Story[],
  sessions: readonly PortfolioSessionRef[],
): string | null {
  const live = stories.find((s) => taskMark(s, sessions) === "live");
  if (live) return live.id;
  const open = stories.find((s) => !s.passes);
  return (open ?? stories[0])?.id ?? null;
}

export function doneSummary(stories: readonly Story[]): string {
  const done = stories.filter((s) => s.passes).length;
  return `Tasks · ${done} of ${stories.length} done`;
}

/** Person on the task: hydrated assignee, then declared provenance. */
export function taskOwner(story: Story): string | null {
  if (story.assignee?.kind === "person") return story.assignee.displayName;
  return provenanceView(story.provenance, "story").people[0]?.label ?? null;
}

/** Bot on the task: live session agent, then a hydrated agent assignee. */
export function taskBot(
  story: Story,
  sessions: readonly PortfolioSessionRef[],
): string | null {
  const agent = taskSessions(story, sessions)
    .map((s) => s.agent?.trim())
    .find((name) => !!name);
  if (agent) return agent;
  if (story.assignee?.kind === "agent") return story.assignee.displayName;
  return null;
}
