/**
 * What each card's modal shows.
 *
 * A card whose main button opens a modal (connection-card-model.ts,
 * `CARD_MODAL_TARGETS`) needs content: a component that draws a CardModal
 * and everything inside it. The shell owns which modal is open and hands the
 * content a frame to spread onto CardModal, so every modal shows the art,
 * icon and title of the card that opened it:
 *
 *   <CardModal {...frame} {busy} {steps}>
 *     {#snippet body()} ... {/snippet}
 *     {#snippet footer()} ... {/snippet}
 *   </CardModal>
 *
 * The content keeps its own state (the step, a wait, a field), which is why
 * it is a component and not a pair of snippets held by the shell.
 *
 * TO GIVE A CARD A MODAL: add its target to `CARD_MODAL_TARGETS` and add its
 * content to `CARD_MODAL_CONTENT` below. A target with only one of the two
 * keeps its old button.
 */

import type { Component } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { CARD_MODAL_TARGETS } from "./connection-card-model.js";
import type { ConnectTarget } from "./richMessageContent.js";

/** The props CardModal takes from the shell. Spread it: `<CardModal {...frame}>`. */
export interface CardModalFrame {
  open: boolean;
  /** The card's title. Content may pass its own `title` after the spread. */
  title: string;
  icon: ConnectTarget;
  art: string;
  artPosition: string;
  /** Close the modal. CardModal does not call it while `busy`. */
  onclose: () => void;
}

/** What the shell hands the content of a card's modal. */
export interface CardModalContentProps {
  frame: CardModalFrame;
  /** The bot whose card opened the modal. */
  agentUid: string;
  target: ConnectTarget;
  /** The bot's display name, for the copy. */
  botName: string;
  /** The bot's company, once the server has said. */
  companyUid: string | null;
  adapter: PlatformAdapter;
  /** Open a page in the system browser, the way the cards do. */
  openUrl: (url: string) => void;
  /** Ask the server again about this bot's Slack and tools, so its cards update. */
  refresh: () => Promise<void>;
}

export type CardModalContent = Component<CardModalContentProps>;

/** The content of each card's modal. Empty for now. */
const CARD_MODAL_CONTENT: Partial<Record<ConnectTarget, CardModalContent>> = {
  // slack: SlackConnectModal,
};

/** Content a test put in. See {@link registerCardModalContentForTest}. */
const testContent = new Map<ConnectTarget, CardModalContent>();

/** The content of a card's modal, or null when the card has none. */
export function cardModalContentFor(target: ConnectTarget): CardModalContent | null {
  return testContent.get(target) ?? CARD_MODAL_CONTENT[target] ?? null;
}

/**
 * The cards whose main button opens a modal in this build: marked in the
 * model and with content here. The shell passes this to the card views.
 */
export function cardModalTargets(): ReadonlySet<ConnectTarget> {
  const out = new Set<ConnectTarget>();
  for (const target of CARD_MODAL_TARGETS) if (CARD_MODAL_CONTENT[target]) out.add(target);
  for (const target of testContent.keys()) out.add(target);
  return out;
}

/**
 * TEST SEAM. Give a card a modal for the length of a test: its main button
 * opens `content`. Call it before the shell mounts. Returns the undo, which
 * the test must call.
 */
export function registerCardModalContentForTest(target: ConnectTarget, content: CardModalContent): () => void {
  testContent.set(target, content);
  return () => {
    if (testContent.get(target) === content) testContent.delete(target);
  };
}
