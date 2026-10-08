/**
 * Stacked faces on project cards and list rows (US-023).
 *
 * Humans render as circles and bots as rounded squares, matching the rail
 * rule (people are circles, bots keep rounded squares). Built only from real
 * data: provenance people and live bot sessions.
 */
export type BoardFaceKind = "human" | "bot";

export interface BoardFace {
  kind: BoardFaceKind;
  label: string;
  /** Two-letter initials for humans; the bot glyph for bots. */
  mark: string;
}

/** Glyph used for a bot face when no avatar is available (storyboard ⌁). */
export const BOT_FACE_MARK = "⌁";

export function faceInitials(label: string): string {
  const base = label.split("@")[0]?.trim() || label.trim();
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

/**
 * Humans first (the owner leads the stack), then one face per live bot
 * session. Named humans and bots are deduped; the stack is capped.
 */
export function boardFaces(
  humans: readonly string[],
  bots: readonly string[] = [],
  max = 3,
): BoardFace[] {
  const out: BoardFace[] = [];
  const seen = new Set<string>();
  for (const raw of humans) {
    const label = raw.trim();
    const key = `h:${label.toLowerCase()}`;
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "human", label, mark: faceInitials(label) });
  }
  for (const raw of bots) {
    const label = raw.trim() || "bot";
    const key = `b:${label.toLowerCase()}`;
    if (label !== "bot" && seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "bot", label, mark: BOT_FACE_MARK });
  }
  return out.slice(0, max);
}

/** "Corey + deacon" — the plain caption beside the stack. */
export function facesCaption(faces: readonly BoardFace[]): string {
  return faces.map((face) => face.label.split(/[\s@]/)[0]).join(" + ");
}
