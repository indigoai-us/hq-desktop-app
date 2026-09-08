/**
 * `rowExtras` — the host's way to decorate a sidebar conversation row.
 *
 * The shared sidebar knows channels and DMs; it does not know what a host
 * associates with them (Sync: the agent sessions bound to a project channel).
 * A host hands `DesktopApp` one function and the sidebar asks it per row:
 * an optional badge next to the title, an optional card shown while the row
 * is hovered, and optional actions appended to the row's context menu. The
 * sidebar mounts what it is handed and never learns what the data means, so
 * `packages/ui` stays free of any host page or platform SDK.
 */
import type { Component } from "svelte";

import type { ConversationRow } from "./sidebar-model.js";

export interface ConversationRowAction {
  /** Stable id — also the `data-testid` suffix of the menu item. */
  id: string;
  label: string;
  onselect: () => void;
}

/** One host-owned row rendered beneath its parent conversation. */
export interface ConversationRowChild {
  /** Stable within the parent row. */
  id: string;
  label: string;
  meta?: string | null;
  selected?: boolean;
  /** Optional semantic state used only for the leading indicator. */
  status?: "starting" | "idle" | "working" | "needsYou" | "ended";
  /** Actions use a plus glyph instead of a status indicator. */
  kind?: "item" | "action";
  onselect: () => void;
}

export interface ConversationRowExtras {
  /** Short text after the row title (e.g. "2" or "1 live"). */
  badge?: string | null;
  /** Mounted beside the row while it is hovered; receives the row. */
  hoverCard?: Component<{ row: ConversationRow }> | null;
  /** Appended to the row's right-click menu. */
  actions?: ConversationRowAction[];
  /** Host-owned rows nested directly beneath this conversation. */
  children?: ConversationRowChild[];
  /** Accessible label for the nested row group. */
  childrenLabel?: string;
  /** Initial state before the operator explicitly expands or collapses it. */
  childrenExpandedByDefault?: boolean;
  /** Lazy host data can subscribe only while this child group is mounted. */
  onChildrenVisibilityChange?: (visible: boolean) => void;
}

/** Host callback: `null` for a row it has nothing to add to. */
export type RowExtrasResolver = (
  row: ConversationRow,
  destination?: { page: string; param: string | null } | null,
) => ConversationRowExtras | null;
