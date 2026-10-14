// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { pinToastsToWindow, toastInsetsFor } from "./harness-toast";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.body.innerHTML = "";
});

describe("toasts on the staged window", () => {
  it("puts the toast corner 16px inside the window's lower right, not the browser's", () => {
    // The 1180×764 window centred on a 1440×900 stage with 92px below it.
    expect(toastInsetsFor({ right: 1310, bottom: 808 }, { width: 1440, height: 900 })).toEqual({ right: 146, bottom: 108 });
  });

  it("falls back to the plain 16px corner when the window fills the viewport", () => {
    expect(toastInsetsFor({ right: 800, bottom: 600 }, { width: 800, height: 600 })).toEqual({ right: 16, bottom: 16 });
  });

  it("sets the layer's inset variables while staged and clears them after", () => {
    const node = document.createElement("div");
    document.body.appendChild(node);
    const action = pinToastsToWindow(node, true);
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--toast-right-inset")).toMatch(/px$/);
    expect(root.getPropertyValue("--toast-bottom-inset")).toMatch(/px$/);
    action.destroy();
    expect(root.getPropertyValue("--toast-right-inset")).toBe("");
    expect(root.getPropertyValue("--toast-bottom-inset")).toBe("");
  });

  it("leaves the layer alone off stage", () => {
    const node = document.createElement("div");
    document.body.appendChild(node);
    pinToastsToWindow(node, false).destroy();
    expect(document.documentElement.style.getPropertyValue("--toast-bottom-inset")).toBe("");
  });
});
