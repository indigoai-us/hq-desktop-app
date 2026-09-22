/**
 * Multi-select model for the sidebar session rows.
 *
 * Pure and DOM-free: the component owns the rendered order and hands it in as
 * `orderedIds` (pinned rows first, then each day section, matching what the
 * rail paints). Range selection anchors on the last row the user picked with a
 * plain or cmd/ctrl click, exactly like Finder and Slack.
 */

export interface SelectionState {
  /** Selected conversation ids, in the order they were added. */
  selected: string[];
  /** Range anchor — the last row picked without shift. */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: [], anchor: null };

export function clearSelection(): SelectionState {
  return { selected: [], anchor: null };
}

export function isSelected(state: SelectionState, id: string): boolean {
  return state.selected.includes(id);
}

export function selectionCount(state: SelectionState): number {
  return state.selected.length;
}

/** Replace the selection with a single row and move the anchor to it. */
export function selectOnly(id: string): SelectionState {
  return { selected: [id], anchor: id };
}

/** cmd/ctrl-click: add or remove one row; the anchor follows the click. */
export function toggleSelected(
  state: SelectionState,
  id: string,
): SelectionState {
  if (state.selected.includes(id)) {
    const selected = state.selected.filter((value) => value !== id);
    return {
      selected,
      // Dropping the anchor row moves the anchor to the newest survivor so a
      // following shift-click still has something to range from.
      anchor: state.anchor === id ? (selected.at(-1) ?? null) : state.anchor,
    };
  }
  return { selected: [...state.selected, id], anchor: id };
}

/**
 * shift-click: select the inclusive range between the anchor and `id` in
 * rendered order. With no anchor (or an anchor that scrolled out of the
 * rendered list) this behaves like a plain click.
 */
export function selectRange(
  state: SelectionState,
  orderedIds: readonly string[],
  id: string,
): SelectionState {
  const end = orderedIds.indexOf(id);
  if (end < 0) return state;
  const start = state.anchor == null ? -1 : orderedIds.indexOf(state.anchor);
  if (start < 0) return selectOnly(id);
  const [from, to] = start <= end ? [start, end] : [end, start];
  const range = orderedIds.slice(from, to + 1);
  // Rows selected outside the range survive; the range itself is appended in
  // rendered order so the toolbar count matches what the user sees.
  const kept = state.selected.filter((value) => !range.includes(value));
  return { selected: [...kept, ...range], anchor: state.anchor };
}

/** Selection after a click, given the modifier keys that came with it. */
export function applyClick(
  state: SelectionState,
  orderedIds: readonly string[],
  id: string,
  modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {},
): SelectionState {
  if (modifiers.shiftKey) return selectRange(state, orderedIds, id);
  if (modifiers.metaKey || modifiers.ctrlKey) return toggleSelected(state, id);
  return selectOnly(id);
}

/** Every rendered row (Select All in the selection toolbar). */
export function selectAll(orderedIds: readonly string[]): SelectionState {
  return {
    selected: [...orderedIds],
    anchor: orderedIds.at(-1) ?? null,
  };
}

/** Drop ids that no longer render (filter change, archive, company switch). */
export function pruneSelection(
  state: SelectionState,
  orderedIds: readonly string[],
): SelectionState {
  const live = new Set(orderedIds);
  const selected = state.selected.filter((id) => live.has(id));
  if (selected.length === state.selected.length) return state;
  return {
    selected,
    anchor: state.anchor != null && live.has(state.anchor) ? state.anchor : null,
  };
}

export interface SelectionKeyResult {
  state: SelectionState;
  /** Row the component should focus, or null to leave focus alone. */
  focusId: string | null;
  handled: boolean;
}

/**
 * Keyboard selection: Arrow up/down move, shift+arrow extends, space toggles,
 * cmd/ctrl+A selects all, Escape clears.
 */
export function applySelectionKey(
  state: SelectionState,
  orderedIds: readonly string[],
  key: {
    key: string;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
  },
  focusedId: string | null,
): SelectionKeyResult {
  const unhandled: SelectionKeyResult = { state, focusId: null, handled: false };
  if (orderedIds.length === 0) return unhandled;

  if (key.key === "Escape") {
    return { state: clearSelection(), focusId: null, handled: true };
  }
  if ((key.metaKey || key.ctrlKey) && key.key.toLowerCase() === "a") {
    return {
      state: selectAll(orderedIds),
      focusId: orderedIds.at(-1) ?? null,
      handled: true,
    };
  }
  if (key.key === " " || key.key === "Spacebar") {
    if (!focusedId) return unhandled;
    return {
      state: toggleSelected(state, focusedId),
      focusId: focusedId,
      handled: true,
    };
  }
  if (key.key !== "ArrowDown" && key.key !== "ArrowUp") return unhandled;

  const step = key.key === "ArrowDown" ? 1 : -1;
  const current = focusedId == null ? -1 : orderedIds.indexOf(focusedId);
  const next =
    current < 0
      ? step === 1
        ? 0
        : orderedIds.length - 1
      : Math.min(orderedIds.length - 1, Math.max(0, current + step));
  const nextId = orderedIds[next];
  if (!nextId) return unhandled;
  return {
    state: key.shiftKey
      ? selectRange(
          state.anchor == null ? selectOnly(focusedId ?? nextId) : state,
          orderedIds,
          nextId,
        )
      : selectOnly(nextId),
    focusId: nextId,
    handled: true,
  };
}
