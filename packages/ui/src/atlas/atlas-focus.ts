/**
 * Focus mode: selecting a project gathers its related repos, knowledge and
 * policies into rings around it. Positions are computed once per selection;
 * the map moves the dots there with a CSS transform (compositor only) and
 * back to their home positions when the selection clears. Pure functions.
 */

import type { AtlasDistrictType } from "./atlas-model.js";
import type { AtlasPlaced } from "./atlas-layout.js";

/** Kinds pulled in around a focused project, in ring order. */
export const ATLAS_FOCUS_KINDS: readonly AtlasDistrictType[] = ["repo", "knowledge", "policy"];
/** Space between the project's rim and the first ring, and between rings (world units). */
const FOCUS_GAP = 22;
const FOCUS_SPACING = 8;

export type AtlasFocusOffset = { dx: number; dy: number; x: number; y: number };

/**
 * Orbit positions for the related items of a focused project: repos first,
 * then knowledge, then policies, each kind by name. Rings fill outward; each
 * ring holds as many as fit around it without overlap. Returns, per id, the
 * target position and the offset from its home position. Empty unless the
 * centre is a project with related items of those kinds.
 */
export function atlasFocusOrbit(
  center: Pick<AtlasPlaced, "id" | "type" | "x" | "y" | "r"> | null | undefined,
  related: readonly Pick<AtlasPlaced, "id" | "type" | "label" | "x" | "y" | "r">[],
): Map<string, AtlasFocusOffset> {
  const out = new Map<string, AtlasFocusOffset>();
  if (!center || center.type !== "project") return out;
  const items = related
    .filter((n) => n.id !== center.id && ATLAS_FOCUS_KINDS.includes(n.type))
    .sort(
      (a, b) =>
        ATLAS_FOCUS_KINDS.indexOf(a.type) - ATLAS_FOCUS_KINDS.indexOf(b.type) ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id),
    );
  if (!items.length) return out;
  const maxR = Math.max(...items.map((n) => n.r));
  const pitch = maxR * 2 + FOCUS_SPACING;
  let ring = center.r + FOCUS_GAP + maxR;
  let i = 0;
  let round = 0;
  while (i < items.length) {
    const capacity = Math.max(6, Math.floor((Math.PI * 2 * ring) / pitch));
    const count = Math.min(capacity, items.length - i);
    // Alternate rings start half a step apart so dots do not line up radially.
    const start = -Math.PI / 2 + (round % 2 ? Math.PI / count : 0);
    for (let j = 0; j < count; j += 1, i += 1) {
      const n = items[i]!;
      const a = start + (j / count) * Math.PI * 2;
      const x = center.x + Math.cos(a) * ring;
      const y = center.y + Math.sin(a) * ring;
      out.set(n.id, { x, y, dx: x - n.x, dy: y - n.y });
    }
    ring += pitch;
    round += 1;
  }
  return out;
}

/** Placed objects at their focus positions (home positions for everything not gathered). */
export function atlasFocusPlaced<T extends { id: string; x: number; y: number }>(
  placed: readonly T[],
  orbit: ReadonlyMap<string, AtlasFocusOffset> | null,
): T[] {
  if (!orbit || !orbit.size) return placed as T[];
  return placed.map((n) => {
    const at = orbit.get(n.id);
    return at ? { ...n, x: at.x, y: at.y } : n;
  });
}
