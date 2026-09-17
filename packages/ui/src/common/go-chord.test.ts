// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoChord, GO_CHORD_MS } from "./go-chord.js";

describe("createGoChord", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onChord for g then a within the window", () => {
    const letters: string[] = [];
    const chord = createGoChord((letter) => {
      letters.push(letter);
      return letter === "a";
    });
    expect(
      chord.handleKeydown({
        key: "g",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        target: null,
        defaultPrevented: false,
      }),
    ).toBe(true);
    expect(chord.isArmed()).toBe(true);
    expect(
      chord.handleKeydown({
        key: "a",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        target: null,
        defaultPrevented: false,
      }),
    ).toBe(true);
    expect(letters).toEqual(["a"]);
    expect(chord.isArmed()).toBe(false);
  });

  it("disarms after the timeout without firing", () => {
    vi.useFakeTimers();
    const chord = createGoChord(() => true);
    chord.handleKeydown({
      key: "g",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: null,
      defaultPrevented: false,
    });
    vi.advanceTimersByTime(GO_CHORD_MS + 1);
    expect(chord.isArmed()).toBe(false);
    expect(
      chord.handleKeydown({
        key: "a",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        target: null,
        defaultPrevented: false,
      }),
    ).toBe(false);
  });

  it("ignores chords when focus is in an input", () => {
    const input = document.createElement("input");
    const chord = createGoChord(() => true);
    expect(
      chord.handleKeydown({
        key: "g",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        target: input,
        defaultPrevented: false,
      }),
    ).toBe(false);
  });
});
