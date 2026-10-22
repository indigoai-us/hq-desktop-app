/**
 * Settings › Profile progress line and the public profile nudge that follows it.
 */

export interface ChecklistStep {
  id: "name" | "photo" | "about";
  label: string;
  /** What to do next when this is the first unfinished step. */
  todo: string;
  done: boolean;
}

/** What we know about the caller's public profile. */
export type PublicProfileState =
  | { kind: "unknown" }
  | { kind: "unclaimed" }
  | { kind: "claimed"; hasPhoto: boolean; hasBio: boolean };

export function profileChecklistSteps(input: {
  displayName: string;
  hasPhoto: boolean;
  about: string;
}): ChecklistStep[] {
  return [
    { id: "name", label: "Display name", todo: "Add a display name", done: input.displayName.trim().length > 0 },
    { id: "photo", label: "Profile photo", todo: "Add a photo", done: input.hasPhoto },
    { id: "about", label: "About", todo: "Add an About line", done: input.about.trim().length > 0 },
  ];
}

/** Read `GET /v1/creators/me` (via the adapter) into a public profile state. */
export function publicProfileStateFrom(value: unknown): PublicProfileState {
  if (!value || typeof value !== "object") return { kind: "unclaimed" };
  const me = value as { handle?: unknown; avatarUrl?: unknown; bio?: unknown; code?: unknown };
  if (me.code === "NO_CREATOR" || typeof me.handle !== "string" || !me.handle.trim()) {
    return { kind: "unclaimed" };
  }
  return {
    kind: "claimed",
    hasPhoto: typeof me.avatarUrl === "string" && me.avatarUrl.length > 0,
    hasBio: typeof me.bio === "string" && me.bio.trim().length > 0,
  };
}

/** The one-line nudge toward the public profile, or null when there's nothing left to do. */
export function publicProfileHint(state: PublicProfileState): string | null {
  if (state.kind === "unknown") return null;
  if (state.kind === "unclaimed") return "Next: claim your public profile";
  if (state.hasPhoto && state.hasBio) return null;
  if (!state.hasPhoto && !state.hasBio) return "Next: add a photo and bio to your public profile";
  return state.hasPhoto ? "Next: add a bio to your public profile" : "Next: add a photo to your public profile";
}
