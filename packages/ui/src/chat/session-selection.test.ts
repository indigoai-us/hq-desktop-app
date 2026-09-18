import { describe, expect, it } from "vitest";

import {
  applyClick,
  applySelectionKey,
  clearSelection,
  EMPTY_SELECTION,
  isSelected,
  pruneSelection,
  selectAll,
  selectionCount,
  selectOnly,
  selectRange,
  toggleSelected,
} from "./session-selection.js";

const ORDER = ["ch:a", "dm:b", "ch:c", "dm:d", "ch:e"];

describe("session selection", () => {
  it("plain click selects one row and anchors on it", () => {
    const state = applyClick(EMPTY_SELECTION, ORDER, "ch:c");
    expect(state.selected).toEqual(["ch:c"]);
    expect(state.anchor).toBe("ch:c");
    expect(selectionCount(state)).toBe(1);
  });

  it("cmd-click toggles a row on and back off", () => {
    let state = applyClick(EMPTY_SELECTION, ORDER, "ch:a", { metaKey: true });
    state = applyClick(state, ORDER, "dm:d", { ctrlKey: true });
    expect(state.selected).toEqual(["ch:a", "dm:d"]);
    state = toggleSelected(state, "ch:a");
    expect(state.selected).toEqual(["dm:d"]);
    expect(isSelected(state, "ch:a")).toBe(false);
  });

  it("moves the anchor off a row that was toggled away", () => {
    let state = selectOnly("ch:a");
    state = toggleSelected(state, "dm:b");
    state = toggleSelected(state, "dm:b");
    expect(state.anchor).toBe("ch:a");
  });

  it("shift-click selects the inclusive range in rendered order", () => {
    const anchored = selectOnly("dm:b");
    const state = applyClick(anchored, ORDER, "dm:d", { shiftKey: true });
    expect(state.selected).toEqual(["dm:b", "ch:c", "dm:d"]);
  });

  it("shift-click ranges upward too", () => {
    const state = selectRange(selectOnly("dm:d"), ORDER, "dm:b");
    expect(state.selected).toEqual(["dm:b", "ch:c", "dm:d"]);
  });

  it("shift-click with no anchor acts as a plain click", () => {
    const state = applyClick(EMPTY_SELECTION, ORDER, "ch:c", { shiftKey: true });
    expect(state.selected).toEqual(["ch:c"]);
  });

  it("keeps rows selected outside the shift range", () => {
    let state = applyClick(EMPTY_SELECTION, ORDER, "ch:e", { metaKey: true });
    state = applyClick(state, ORDER, "ch:a", { metaKey: true });
    state = applyClick(state, ORDER, "ch:c", { shiftKey: true });
    expect(new Set(state.selected)).toEqual(
      new Set(["ch:e", "ch:a", "dm:b", "ch:c"]),
    );
  });

  it("clears to empty", () => {
    expect(clearSelection()).toEqual({ selected: [], anchor: null });
  });

  it("selects every rendered row", () => {
    expect(selectAll(ORDER).selected).toEqual(ORDER);
  });

  it("prunes rows that stopped rendering", () => {
    const state = selectAll(ORDER);
    const pruned = pruneSelection(state, ["ch:a", "ch:c"]);
    expect(pruned.selected).toEqual(["ch:a", "ch:c"]);
    expect(pruned.anchor).toBeNull();
  });

  it("keeps identity when nothing was pruned", () => {
    const state = selectOnly("ch:a");
    expect(pruneSelection(state, ORDER)).toBe(state);
  });

  describe("keyboard", () => {
    it("arrow down moves the focused row and selects it", () => {
      const result = applySelectionKey(
        EMPTY_SELECTION,
        ORDER,
        { key: "ArrowDown" },
        "ch:a",
      );
      expect(result.handled).toBe(true);
      expect(result.focusId).toBe("dm:b");
      expect(result.state.selected).toEqual(["dm:b"]);
    });

    it("shift+arrow extends the range", () => {
      const start = selectOnly("dm:b");
      const result = applySelectionKey(
        start,
        ORDER,
        { key: "ArrowDown", shiftKey: true },
        "dm:b",
      );
      expect(result.state.selected).toEqual(["dm:b", "ch:c"]);
    });

    it("space toggles the focused row", () => {
      const result = applySelectionKey(
        selectOnly("ch:a"),
        ORDER,
        { key: " " },
        "ch:c",
      );
      expect(result.state.selected).toEqual(["ch:a", "ch:c"]);
    });

    it("cmd+A selects all and Escape clears", () => {
      const all = applySelectionKey(
        EMPTY_SELECTION,
        ORDER,
        { key: "a", metaKey: true },
        null,
      );
      expect(all.state.selected).toEqual(ORDER);
      const cleared = applySelectionKey(
        all.state,
        ORDER,
        { key: "Escape" },
        "ch:a",
      );
      expect(cleared.state.selected).toEqual([]);
      expect(cleared.handled).toBe(true);
    });

    it("stops at the ends of the list", () => {
      const top = applySelectionKey(
        EMPTY_SELECTION,
        ORDER,
        { key: "ArrowUp" },
        "ch:a",
      );
      expect(top.focusId).toBe("ch:a");
      const bottom = applySelectionKey(
        EMPTY_SELECTION,
        ORDER,
        { key: "ArrowDown" },
        "ch:e",
      );
      expect(bottom.focusId).toBe("ch:e");
    });

    it("leaves unrelated keys alone", () => {
      const result = applySelectionKey(
        EMPTY_SELECTION,
        ORDER,
        { key: "k" },
        "ch:a",
      );
      expect(result.handled).toBe(false);
    });
  });
});
