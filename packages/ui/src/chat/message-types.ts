/**
 * Message types preference (hq-message-visibility US-004).
 *
 * One global default for which message types conversations and sidebar
 * snippets show. People messages always show. Agent (agents and the CLI)
 * and system (mesh / automated events) messages show only when their switch
 * is on. Both default off. Stored in localStorage under
 * {@link MESSAGE_TYPES_STORAGE_KEY} as `{ agents, system }`.
 *
 * Pure helpers only; the shared reactive store lives in
 * `message-types.svelte.ts`.
 */
import type { MessageType } from "@hq/platform";

export const MESSAGE_TYPES_STORAGE_KEY = "hq:messages:types.v1";

export interface MessageTypesPref {
  agents: boolean;
  system: boolean;
}

export const DEFAULT_MESSAGE_TYPES: Readonly<MessageTypesPref> = Object.freeze({
  agents: false,
  system: false,
});

/** Parse a stored value. Anything malformed reads as the default. */
export function parseMessageTypes(raw: string | null | undefined): MessageTypesPref {
  if (!raw) return { ...DEFAULT_MESSAGE_TYPES };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { ...DEFAULT_MESSAGE_TYPES };
    const v = value as Record<string, unknown>;
    return { agents: v.agents === true, system: v.system === true };
  } catch {
    return { ...DEFAULT_MESSAGE_TYPES };
  }
}

export function loadMessageTypes(
  storage: Pick<Storage, "getItem"> | null | undefined,
): MessageTypesPref {
  if (!storage) return { ...DEFAULT_MESSAGE_TYPES };
  try {
    return parseMessageTypes(storage.getItem(MESSAGE_TYPES_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_MESSAGE_TYPES };
  }
}

export function saveMessageTypes(
  pref: MessageTypesPref,
  storage: Pick<Storage, "setItem"> | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      MESSAGE_TYPES_STORAGE_KEY,
      JSON.stringify({ agents: pref.agents === true, system: pref.system === true }),
    );
  } catch (error) {
    console.warn("[hq-ui] best-effort failure at packages/ui/src/chat/message-types.ts", error);
  }
}

/** People always; agent iff `agents`; system iff `system`. */
export function isMessageTypeVisible(type: MessageType, pref: MessageTypesPref): boolean {
  if (type === "agent") return pref.agents === true;
  if (type === "system") return pref.system === true;
  return true;
}

/** True when only people messages show (both switches off). */
export function isPeopleOnly(pref: MessageTypesPref): boolean {
  return pref.agents !== true && pref.system !== true;
}
