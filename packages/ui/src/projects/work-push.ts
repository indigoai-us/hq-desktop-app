/**
 * Apply work-mesh MQTT pushes on the projects page (US-006).
 *
 * The Tauri client forwards three payloads. This module turns them into
 * one ProjectView refetch per open project per 500ms, a company-board
 * refresh, or a live session row the story card already knows how to paint.
 * It does not parse ProjectView bodies — the page refetches through
 * `project-view.ts`.
 */

import type { PortfolioSessionRef } from "./projects-model.js";

export const WORK_PUSH_PROJECT_VIEW = "work:project-view";
export const WORK_PUSH_CHANGED = "work:changed";
export const WORK_PUSH_SESSION = "work:session-event";

export const WORK_PUSH_EVENTS = [
  WORK_PUSH_PROJECT_VIEW,
  WORK_PUSH_CHANGED,
  WORK_PUSH_SESSION,
] as const;

export type WorkPush =
  | { kind: "project-view"; projectId: string }
  | { kind: "work.changed"; resourceId: string }
  | {
      kind: "session-event";
      projectId: string;
      storyId: string;
      event: string;
      chatId: string;
      companyUid: string;
    };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseWorkPush(eventName: string, payload: unknown): WorkPush | null {
  const body =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  if (eventName === WORK_PUSH_PROJECT_VIEW) {
    const projectId = str(body.projectId);
    return projectId ? { kind: "project-view", projectId } : null;
  }
  if (eventName === WORK_PUSH_CHANGED) {
    return { kind: "work.changed", resourceId: str(body.resourceId) };
  }
  if (eventName === WORK_PUSH_SESSION) {
    const event = str(body.event);
    if (!event) return null;
    return {
      kind: "session-event",
      projectId: str(body.projectId),
      storyId: str(body.storyId),
      event,
      chatId: str(body.chatId),
      companyUid: str(body.companyUid),
    };
  }
  return null;
}

type Listener = (handler: (push: WorkPush) => void) => void;
const listeners = new Set<(push: WorkPush) => void>();

export function onWorkPush(handler: (push: WorkPush) => void): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/** Native shell entry. Unknown events are ignored. */
export function dispatchWorkPush(eventName: string, payload: unknown): void {
  const push = parseWorkPush(eventName, payload);
  if (!push) return;
  for (const listener of listeners) listener(push);
}

export function sessionRefFromSessionEvent(
  push: Extract<WorkPush, { kind: "session-event" }>,
  nowIso: string = new Date().toISOString(),
): PortfolioSessionRef {
  const status =
    push.event === "awaitingInput"
      ? "awaiting_input"
      : push.event === "done" || push.event === "errored" || push.event === "blocked"
        ? "done"
        : "running";
  const storyId = push.storyId;
  return {
    project: storyId || push.projectId,
    company: push.companyUid,
    cwd: storyId,
    status,
    source: push.chatId || storyId,
    lastActivityAt: nowIso,
  };
}

export function upsertSessionMarker(
  sessions: readonly PortfolioSessionRef[],
  next: PortfolioSessionRef,
): PortfolioSessionRef[] {
  const key = next.source || next.project;
  const rest = sessions.filter((row) => (row.source || row.project) !== key);
  return [...rest, next];
}

export interface ProjectRefetchWindow {
  note(projectId: string): void;
  dispose(): void;
}

/**
 * At most one refetch per project per `delayMs`. A push for a project that
 * is not open is dropped. Further pushes while a refetch is already waiting
 * do not schedule another.
 */
export function createProjectRefetchWindow(options: {
  isOpen: (projectId: string) => boolean;
  refetch: (projectId: string) => void;
  delayMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}): ProjectRefetchWindow {
  const delayMs = options.delayMs ?? 500;
  const schedule =
    options.schedule ??
    ((fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    });
  const waiting = new Map<string, () => void>();
  return {
    note(projectId: string) {
      if (!projectId || !options.isOpen(projectId)) return;
      if (waiting.has(projectId)) return;
      const cancel = schedule(() => {
        waiting.delete(projectId);
        if (options.isOpen(projectId)) options.refetch(projectId);
      }, delayMs);
      waiting.set(projectId, cancel);
    },
    dispose() {
      for (const cancel of waiting.values()) cancel();
      waiting.clear();
    },
  };
}

export type { Listener };
