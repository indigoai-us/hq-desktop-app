/**
 * Door into the US-024 task view pane chunk. The promise is memoized so the
 * board only pays for the pane the first time a card is clicked.
 */
export type TaskViewModule = typeof import("./TaskViewPane.svelte");

let pending: Promise<TaskViewModule> | null = null;

export function loadTaskView(): Promise<TaskViewModule> {
  pending ??= import("./TaskViewPane.svelte").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
