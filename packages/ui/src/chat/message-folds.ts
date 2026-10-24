/**
 * Message folds (hq-message-visibility US-005).
 *
 * A run of one or more messages hidden by the message-types preference
 * collapses into one fold row where it happened. Visible messages stay
 * as rows. A run at the very end of the timeline folds too.
 *
 * Pure helpers only, shared by `ConversationView` (packages/ui) and the
 * apps/sync thread views through `MessageFold.svelte`.
 */
import { messageType, type HumanClassifiable, type MessageType } from "@hq/platform";
import { isMessageTypeVisible, type MessageTypesPref } from "./message-types.js";

export interface FoldSender {
  uid: string;
  name: string;
}

export interface FoldMessageRow<T> {
  kind: "message";
  key: string;
  item: T;
}

export interface FoldRun<T> {
  kind: "fold";
  /** Stable key: `fold:` + the first hidden message's id. */
  key: string;
  /** Hidden messages, in timeline order. */
  items: T[];
  agentCount: number;
  systemCount: number;
  /** Distinct senders in order of first appearance, at most three. */
  senders: FoldSender[];
}

export type FoldRow<T> = FoldMessageRow<T> | FoldRun<T>;

/** Fields the default accessors read. */
export interface FoldableMessage extends HumanClassifiable {
  eventId: string;
  fromDisplayName?: string | null;
  /** Precomputed type (ConversationView rows carry one). */
  type?: MessageType;
}

export interface GroupIntoFoldsOptions<T> {
  typeOf?: (message: T) => MessageType;
  idOf?: (message: T) => string;
  senderOf?: (message: T) => FoldSender;
}

export const MAX_FOLD_AVATARS = 3;

function defaultTypeOf(message: FoldableMessage): MessageType {
  return message.type ?? messageType(message);
}

function defaultIdOf(message: FoldableMessage): string {
  return message.eventId;
}

function defaultSenderOf(message: FoldableMessage): FoldSender {
  const uid = (message.fromPersonUid ?? "").trim();
  const name = (message.fromDisplayName ?? "").trim();
  return { uid, name: name || uid || "Unknown sender" };
}

/**
 * Split a timeline into visible rows and fold runs. `prefs === null` means
 * no type filter: every message is a row and nothing folds.
 */
export function groupIntoFolds<T extends FoldableMessage>(
  messages: readonly T[],
  prefs: MessageTypesPref | null,
  options: GroupIntoFoldsOptions<T> = {},
): FoldRow<T>[] {
  const typeOf = options.typeOf ?? defaultTypeOf;
  const idOf = options.idOf ?? defaultIdOf;
  const senderOf = options.senderOf ?? defaultSenderOf;
  const rows: FoldRow<T>[] = [];
  let run: FoldRun<T> | null = null;
  for (const message of messages) {
    const type = typeOf(message);
    if (prefs === null || isMessageTypeVisible(type, prefs)) {
      run = null;
      rows.push({ kind: "message", key: idOf(message), item: message });
      continue;
    }
    if (!run) {
      run = {
        kind: "fold",
        key: `fold:${idOf(message)}`,
        items: [],
        agentCount: 0,
        systemCount: 0,
        senders: [],
      };
      rows.push(run);
    }
    run.items.push(message);
    if (type === "system") run.systemCount += 1;
    else run.agentCount += 1;
    if (run.senders.length < MAX_FOLD_AVATARS) {
      const sender = senderOf(message);
      const id = sender.uid || sender.name;
      if (!run.senders.some((s) => (s.uid || s.name) === id)) run.senders.push(sender);
    }
  }
  return rows;
}

/** "6 agent updates · 1 system"; "hide …" when open. Zero segments drop. */
export function foldLabel(
  run: Pick<FoldRun<unknown>, "agentCount" | "systemCount">,
  open = false,
): string {
  const parts: string[] = [];
  if (run.agentCount > 0) {
    parts.push(`${run.agentCount} agent ${run.agentCount === 1 ? "update" : "updates"}`);
  }
  if (run.systemCount > 0) parts.push(`${run.systemCount} system`);
  const label = parts.join(" · ");
  return open ? `hide ${label}` : label;
}

/**
 * Message-type markers a live wake or inbox event may carry. Only explicit
 * markers count: the sender uid is not used to infer a type here.
 */
export type UnreadClassifiable = Pick<
  HumanClassifiable,
  "audience" | "isSystemEvent" | "isMeshEvent"
>;

/**
 * True when a new message should raise an unread badge or notification.
 * A message the preference hides would land in a fold, and folds never
 * count as unread.
 */
export function countsTowardUnread(
  message: UnreadClassifiable | null | undefined,
  prefs: MessageTypesPref,
): boolean {
  if (!message) return true;
  return isMessageTypeVisible(messageType(message, { inferFromUid: false }), prefs);
}
