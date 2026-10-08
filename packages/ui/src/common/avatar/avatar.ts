/**
 * Shared avatar model: what a person's or bot's avatar shows, in order.
 *
 *   1. a real photo from the identity cache, when the packaged CSP can paint it;
 *   2. for a bot or agent, the bundled mascot art picked from its uid;
 *   3. for a person, initials on a color derived from a stable id.
 *
 * Bots never fall back to initials. Pure functions, no Svelte, no DOM.
 */
import { paintableAvatarSrc } from "../../avatars/csp-image-src.js";
import { agentAvatarFor } from "../../chat/messaging/agent-avatars.js";

export type AvatarKind = "person" | "bot";

export type AvatarFace =
  | { type: "photo"; src: string }
  | { type: "mascot"; src: string }
  | { type: "initials"; text: string; hue: number }
  | { type: "glyph"; text: string };

/**
 * Hues for initials (degrees). Indigo and purple are left out: in the desktop
 * design system those read as brand accent, not as a person.
 */
export const AVATAR_HUES: readonly number[] = [8, 28, 44, 92, 150, 178, 200, 222, 334];

/** Glyph a bot shows only when no mascot art is bundled at all. */
export const BOT_GLYPH = "⌁";

/** 32-bit FNV-1a: stable across sessions, machines and JS engines. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The hue for a stable id (uid, else email, else name). Same id, same hue. */
export function avatarHue(id: string): number {
  const key = id.trim().toLowerCase();
  return AVATAR_HUES[fnv1a(key || "?") % AVATAR_HUES.length]!;
}

/** "Hassaan Saleem" → "HS", "corey@x.io" → "CO", "Lin" → "LI". */
export function avatarInitials(name: string): string {
  const base = name.split("@")[0]?.trim() || name.trim();
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return base.slice(0, 2).toUpperCase() || "?";
}

export interface AvatarInput {
  kind: AvatarKind;
  /** Display name, for initials. */
  name: string;
  /** Stable id: person or agent uid. Drives color and mascot choice. */
  id?: string | null;
  /** Photo URL from the identity cache, if any. */
  photo?: string | null;
  /** Bundled mascot art to pick from (tests inject a set). */
  mascots?: readonly string[];
}

/** What the avatar shows, by the fallback order above. */
export function avatarFace(input: AvatarInput): AvatarFace {
  const photo = paintableAvatarSrc(input.photo ?? null);
  if (photo) return { type: "photo", src: photo };
  const id = (input.id ?? "").trim() || input.name.trim();
  if (input.kind === "bot") {
    const mascot = input.mascots ? agentAvatarFor(id, input.mascots) : agentAvatarFor(id);
    return mascot ? { type: "mascot", src: mascot } : { type: "glyph", text: BOT_GLYPH };
  }
  return { type: "initials", text: avatarInitials(input.name), hue: avatarHue(id) };
}
