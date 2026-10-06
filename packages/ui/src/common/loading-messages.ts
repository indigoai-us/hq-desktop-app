/**
 * Waiting lines for the shared loader (BLANK-3). Edit the copy here; the
 * loader is the only reader. Rules: short, light, plain American English,
 * sentence case, no jargon or ids, nothing that sounds like an error, and
 * nothing about the person's own data.
 */
export type LoadingSurface = "atlas" | "team" | "meetings";

export const LOADING_MESSAGES: readonly string[] = [
  "Warming up the engines.",
  "Fetching the good stuff.",
  "Lining everything up.",
  "Almost there, probably.",
  "Counting twice to be sure.",
  "Tidying up before you arrive.",
  "Taking the scenic route.",
  "Stretching first.",
  "Polishing the last few pixels.",
  "Herding a few stray bytes.",
  "Making it look effortless.",
  "Checking under the couch cushions.",
  "Brewing a fresh pot.",
  "Untangling the cables.",
  "Waiting for the kettle.",
  "Putting things in the right order.",
  "Rounding up the details.",
  "Good things take a moment.",
  "Still on it.",
  "Nearly ready for you.",
];

export const SURFACE_LOADING_MESSAGES: Record<LoadingSurface, readonly string[]> = {
  atlas: ["Unfolding the map.", "Drawing the roads.", "Finding north."],
  team: ["Saying hello to everyone.", "Gathering the crew.", "Taking attendance."],
  meetings: ["Loading"],
};

/** Surfaces that show only their own plain line, never the general pool. */
const PLAIN_SURFACES: ReadonlySet<LoadingSurface> = new Set(["meetings"]);

/** Surface lines first, then the general pool, without repeats. */
export function loadingMessages(surface?: LoadingSurface | null): string[] {
  const own = surface ? SURFACE_LOADING_MESSAGES[surface] : [];
  if (surface && PLAIN_SURFACES.has(surface)) return [...own];
  return [...own, ...LOADING_MESSAGES.filter((line) => !own.includes(line))];
}
