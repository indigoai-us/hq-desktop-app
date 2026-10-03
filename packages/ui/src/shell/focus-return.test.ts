// @vitest-environment happy-dom


import { afterEach, describe, expect, it } from "vitest";

import { focusReturn } from "./focus-return.js";

describe("focusReturn", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses the first control and returns focus to the opener", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const popover = document.createElement("div");
    popover.innerHTML = `<button disabled>off</button><button id="first">Profile</button>`;
    document.body.append(popover);

    const action = focusReturn(popover);
    expect(document.activeElement?.id).toBe("first");

    popover.remove();
    action.destroy();
    expect(document.activeElement).toBe(opener);
  });

  it("falls back to the popover itself when it has no controls", () => {
    const popover = document.createElement("div");
    popover.tabIndex = -1;
    document.body.append(popover);
    focusReturn(popover);
    expect(document.activeElement).toBe(popover);
  });
});
