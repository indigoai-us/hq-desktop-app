/**
 * Shared reactive message-types preference. ChatSidebar writes it from the
 * filter menu; DesktopApp, ConversationView, ChannelConversation and the
 * apps/sync DM pane read it, so a switch re-filters every open view at once.
 */
import {
  loadMessageTypes,
  saveMessageTypes,
  type MessageTypesPref,
} from "./message-types.js";

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let current = $state<MessageTypesPref>(loadMessageTypes(defaultStorage()));

export const messageTypesStore = {
  /** The current preference. Reactive inside components and `$derived`. */
  get value(): MessageTypesPref {
    return current;
  },
  /** Replace the preference and persist it. */
  set(next: MessageTypesPref, storage: Pick<Storage, "setItem"> | null = defaultStorage()): void {
    current = { agents: next.agents === true, system: next.system === true };
    saveMessageTypes(current, storage);
  },
  /** Re-read from storage (tests, or another window wrote the key). */
  reload(storage: Pick<Storage, "getItem"> | null = defaultStorage()): void {
    current = loadMessageTypes(storage);
  },
};
