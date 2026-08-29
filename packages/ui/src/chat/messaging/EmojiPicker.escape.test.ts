// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import EmojiPicker from "./EmojiPicker.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("EmojiPicker escape handling", () => {
  it("consumes the Escape it handles so outer layers stay open", async () => {
    // The reply panel closes itself on a window-level Escape. When the picker
    // is open it is the innermost layer, so one Escape must close only it —
    // otherwise the whole thread panel disappears with the picker.
    let pickerClosed = 0;
    let outerSaw = 0;
    const outer = (): void => {
      outerSaw += 1;
    };
    window.addEventListener("keydown", outer);

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(EmojiPicker, {
      target: host,
      props: {
        onpick: () => {},
        onclose: () => {
          pickerClosed += 1;
        },
      },
    });
    await tick();

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(pickerClosed).toBe(1);
    expect(outerSaw).toBe(0);
    window.removeEventListener("keydown", outer);
  });

  it("lets other keys through to outer handlers", async () => {
    let outerSaw = 0;
    const outer = (): void => {
      outerSaw += 1;
    };
    window.addEventListener("keydown", outer);

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(EmojiPicker, {
      target: host,
      props: { onpick: () => {}, onclose: () => {} },
    });
    await tick();

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(outerSaw).toBe(1);
    window.removeEventListener("keydown", outer);
  });
});
