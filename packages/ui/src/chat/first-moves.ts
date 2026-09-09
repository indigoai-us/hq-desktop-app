// "First moves" — the short, self-ticking list under the #welcome hero that
// teaches HQ by handing the person one thing to DO at a time.
//
// Rules (product):
//   - At most four moves. Exactly one is expanded ("current"); the rest are
//     one-line rows. Done rows tick themselves from live app state where the
//     app can observe the outcome (a project channel exists); otherwise the
//     click that performed the action marks it (invite opened, tool opened).
//   - State-aware: nothing here shows until the account has a company.
//   - When every move is done the list disappears and #welcome is quiet.
//
// Persistence is local to this machine, like the welcome-first boot flag.

export type FirstMoveId = "project-channel" | "invite" | "agent" | "coding-tools";

export type FirstMoveState = "done" | "current" | "todo";

export interface FirstMove {
  id: FirstMoveId;
  title: string;
  /** One plain sentence shown only while the move is current. */
  body: string;
  state: FirstMoveState;
}

export const FIRST_MOVES_ORDER: readonly FirstMoveId[] = [
  "project-channel",
  "invite",
  "agent",
  "coding-tools",
];

export const FIRST_MOVES_COPY: Record<FirstMoveId, { title: string; body: string; cta: string }> = {
  "project-channel": {
    title: "Start a project channel",
    body: "A channel per project keeps the work, the files, and the people in one place. Name your first one.",
    cta: "New project channel",
  },
  invite: {
    title: "Invite a teammate",
    body: "HQ is better with your team in it. Send one invite; they get the same company, channels, and agents.",
    cta: "Invite someone",
  },
  agent: {
    title: "Talk to an agent",
    body: "Hosted agents work inside your company channel. Add one, then send it a direct message.",
    cta: "Add an agent",
  },
  "coding-tools": {
    title: "Use HQ from your coding tools",
    body: "HQ is already in Claude Code and Codex. Open your HQ folder there and type /startwork.",
    cta: "Open in Claude Code",
  },
};

export const FIRST_MOVES_TITLE = "Your first moves";

export const FIRST_MOVES_STORAGE_KEY = "hq.welcome.first-moves.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storageOrWindow(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Moves marked done on this machine by the click that performed them. */
export function readFirstMovesDone(storage?: StorageLike | null): Set<FirstMoveId> {
  try {
    const raw = storageOrWindow(storage)?.getItem(FIRST_MOVES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((id): id is FirstMoveId => FIRST_MOVES_ORDER.includes(id as FirstMoveId)),
    );
  } catch {
    return new Set();
  }
}

export function markFirstMoveDone(id: FirstMoveId, storage?: StorageLike | null): Set<FirstMoveId> {
  const done = readFirstMovesDone(storage);
  done.add(id);
  try {
    storageOrWindow(storage)?.setItem(FIRST_MOVES_STORAGE_KEY, JSON.stringify([...done]));
  } catch {
    // Storage unavailable: the list simply re-offers the move next boot.
  }
  return done;
}

export interface FirstMovesInput {
  /** The account has at least one company; nothing shows before that. */
  hasCompany: boolean;
  /** Observed from the rail: a project-scoped channel exists. */
  hasProjectChannel: boolean;
  /** Marked by the click that performed the move (persisted locally). */
  done: ReadonlySet<FirstMoveId>;
}

/**
 * The list to render, in order, with exactly one `current` (the first not
 * done). Empty when there is no company yet, or when everything is done.
 */
export function firstMovesFor(input: FirstMovesInput): FirstMove[] {
  if (!input.hasCompany) return [];
  const isDone = (id: FirstMoveId): boolean =>
    id === "project-channel" ? input.hasProjectChannel || input.done.has(id) : input.done.has(id);
  let currentAssigned = false;
  const moves: FirstMove[] = FIRST_MOVES_ORDER.map((id) => {
    const copy = FIRST_MOVES_COPY[id];
    let state: FirstMoveState;
    if (isDone(id)) state = "done";
    else if (!currentAssigned) {
      state = "current";
      currentAssigned = true;
    } else state = "todo";
    return { id, title: copy.title, body: copy.body, state };
  });
  return moves.every((move) => move.state === "done") ? [] : moves;
}
