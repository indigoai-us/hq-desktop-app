// @vitest-environment happy-dom

// The modal a card can open: a dialog at the app shell, with the card's art,
// icon and title, a body and a row of actions. And the pieces a flow inside
// it is built from.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRawSnippet, flushSync, mount, unmount, type Component, type Snippet } from "svelte";

import CardModal from "./CardModal.svelte";
import CardModalField from "./CardModalField.svelte";
import CardModalStatus from "./CardModalStatus.svelte";
import CardModalStep from "./CardModalStep.svelte";
import {
  CARD_MODAL_AUTOFOCUS,
  CARD_MODAL_BACKDROP_GUARD_MS,
  cardModalStepIndex,
  cardModalStepText,
  type CardModalSteps,
} from "./card-modal.js";

interface ModalProps {
  open: boolean;
  title: string;
  icon: "slack" | "tools";
  art: string;
  artPosition?: string;
  onclose: () => void;
  busy?: boolean;
  steps?: CardModalSteps | null;
  body?: Snippet;
  footer?: Snippet;
  returnFocus?: HTMLElement | null;
}

const html = (markup: string): Snippet => createRawSnippet(() => ({ render: () => markup }));

const BODY = html('<div data-testid="probe-body"><p>Add the app to your workspace.</p></div>');
const FOOTER = html(
  '<div data-testid="probe-footer"><button type="button" class="card-modal-btn is-quiet" data-testid="probe-back">Back</button><button type="button" class="card-modal-btn is-primary" data-testid="probe-next">Next</button></div>',
);

let shell: HTMLDivElement;
let app: HTMLDivElement;
let message: HTMLDivElement;
let opener: HTMLButtonElement;
let outside: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let props: ModalProps;
let onclose: ReturnType<typeof vi.fn<() => void>>;
let clock = 0;

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  // The app as the dialog finds it: a shell, the conversation inside it with
  // the card's button deep in a message, and something next to the shell.
  shell = document.createElement("div");
  shell.className = "desktop-shell";
  shell.setAttribute("data-shell-focus-fallback", "");
  shell.tabIndex = -1;
  app = document.createElement("div");
  app.dataset.testid = "app";
  message = document.createElement("div");
  message.style.overflow = "hidden";
  opener = document.createElement("button");
  opener.textContent = "Connect Slack";
  message.appendChild(opener);
  app.appendChild(message);
  shell.appendChild(app);
  outside = document.createElement("div");
  document.body.append(shell, outside);
  onclose = vi.fn<() => void>();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  shell.remove();
  outside.remove();
  vi.restoreAllMocks();
});

/** Mount the modal inside the message, the way a card would hold it. */
function render(over: Partial<ModalProps> = {}): void {
  const state = $state<ModalProps>({
    open: true,
    title: "Slack",
    icon: "slack",
    art: "/art/aurora.jpg",
    onclose,
    body: BODY,
    footer: FOOTER,
    ...over,
  });
  props = state;
  component = mount(CardModal, { target: message, props });
  flushSync();
}

const layer = () => document.querySelector<HTMLElement>('[data-testid="card-modal-layer"]');
const dialog = () => document.querySelector<HTMLElement>('[data-testid="card-modal"]');
const closeButton = () => document.querySelector<HTMLButtonElement>('[data-testid="card-modal-close"]')!;
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  flushSync();
  return event;
}

function pressBackdrop(): void {
  layer()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flushSync();
}

describe("the card modal: opening and closing", () => {
  it("draws nothing until it is open, and goes when it is closed", () => {
    render({ open: false });
    expect(dialog()).toBeNull();
    props.open = true;
    flushSync();
    expect(dialog()).not.toBeNull();
    props.open = false;
    flushSync();
    expect(dialog()).toBeNull();
    expect(layer()).toBeNull();
  });

  it("draws at the app shell, not inside the message that holds the card", () => {
    render();
    expect(layer()!.parentElement).toBe(shell);
    expect(message.contains(dialog())).toBe(false);
  });

  it("is a modal dialog named by its title", () => {
    render({ title: "Connect your tools", icon: "tools" });
    const el = dialog()!;
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(el.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("Connect your tools");
    expect(title?.tagName).toBe("H2");
    expect(el.dataset.icon).toBe("tools");
  });

  it("shows the card's wallpaper as a layer a screen reader skips", () => {
    render({ art: "/art/aurora.jpg", artPosition: "center 14%" });
    const art = dialog()!.querySelector<HTMLElement>(".card-modal-art")!;
    expect(art.getAttribute("aria-hidden")).toBe("true");
    expect(art.style.backgroundImage).toContain("/art/aurora.jpg");
    expect(art.style.backgroundPosition).toBe("center 14%");
    expect(art.children).toHaveLength(0);
  });

  it("renders the body and the footer it is given", () => {
    render();
    expect(byId("card-modal-body")!.contains(byId("probe-body"))).toBe(true);
    expect(byId("probe-body")!.textContent).toBe("Add the app to your workspace.");
    expect(byId("card-modal-footer")!.contains(byId("probe-next"))).toBe(true);
  });

  it("has no footer row when no footer is given", () => {
    render({ footer: undefined });
    expect(byId("card-modal-footer")).toBeNull();
  });

  it("closes from its close button", () => {
    render();
    expect(closeButton().getAttribute("aria-label")).toBe("Close");
    closeButton().click();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape, wherever focus is, and keeps the key from the app behind", () => {
    render();
    const heardBehind = vi.fn();
    window.addEventListener("keydown", heardBehind);
    try {
      const event = key("Escape");
      expect(onclose).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
      expect(heardBehind).not.toHaveBeenCalled();
      // After a press on the backdrop focus is on the page itself.
      (document.activeElement as HTMLElement | null)?.blur();
      key("Escape");
      expect(onclose).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("keydown", heardBehind);
    }
  });

  it("closes on a press outside the panel, not on a press inside it", () => {
    render();
    clock += CARD_MODAL_BACKDROP_GUARD_MS + 1;
    byId("probe-body")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    dialog()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onclose).not.toHaveBeenCalled();
    pressBackdrop();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("ignores the second click of the double click that opened it", () => {
    render();
    clock += CARD_MODAL_BACKDROP_GUARD_MS - 1;
    pressBackdrop();
    expect(onclose).not.toHaveBeenCalled();
    clock += 2;
    pressBackdrop();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("stops listening for keys once it is closed", () => {
    render();
    props.open = false;
    flushSync();
    const event = key("Escape");
    expect(onclose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("the card modal: busy", () => {
  it("does not close on Escape, a press outside or its close button while busy", () => {
    render({ busy: true });
    clock += CARD_MODAL_BACKDROP_GUARD_MS + 1;
    expect(dialog()!.getAttribute("aria-busy")).toBe("true");
    expect(closeButton().disabled).toBe(true);
    const event = key("Escape");
    // Still kept from the app behind.
    expect(event.defaultPrevented).toBe(true);
    pressBackdrop();
    closeButton().click();
    expect(onclose).not.toHaveBeenCalled();
  });

  it("closes again once it is no longer busy", () => {
    render({ busy: true });
    clock += CARD_MODAL_BACKDROP_GUARD_MS + 1;
    props.busy = false;
    flushSync();
    expect(closeButton().disabled).toBe(false);
    expect(dialog()!.hasAttribute("aria-busy")).toBe(false);
    key("Escape");
    pressBackdrop();
    expect(onclose).toHaveBeenCalledTimes(2);
  });
});

describe("the card modal: focus", () => {
  it("moves focus into the dialog when it opens and back to the opener when it closes", () => {
    opener.focus();
    render({ open: false });
    expect(document.activeElement).toBe(opener);
    props.open = true;
    flushSync();
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(closeButton());
    props.open = false;
    flushSync();
    expect(document.activeElement).toBe(opener);
  });

  it("puts focus on the control a flow marked for it", () => {
    opener.focus();
    render({ body: html(`<div><input data-testid="probe-field" ${CARD_MODAL_AUTOFOCUS} /></div>`) });
    expect(document.activeElement).toBe(byId("probe-field"));
  });

  it("puts focus on the panel when nothing inside can take it", () => {
    opener.focus();
    render({ busy: true, footer: undefined });
    expect(document.activeElement).toBe(dialog());
  });

  it("gives focus to the shell when the opener is gone", () => {
    opener.focus();
    render();
    opener.remove();
    props.open = false;
    flushSync();
    expect(document.activeElement).toBe(shell);
  });

  it("gives focus back to the control it is told to", () => {
    const other = document.createElement("button");
    app.appendChild(other);
    opener.focus();
    render({ returnFocus: other });
    props.open = false;
    flushSync();
    expect(document.activeElement).toBe(other);
  });

  it("gives focus back when it is unmounted while open", async () => {
    opener.focus();
    render();
    expect(document.activeElement).not.toBe(opener);
    await unmount(component!);
    component = null;
    expect(document.activeElement).toBe(opener);
    expect(layer()).toBeNull();
  });

  it("keeps Tab inside the dialog", () => {
    render();
    const back = byId("probe-back")!;
    const next = byId("probe-next")!;
    // Tab on the last control goes to the first.
    next.focus();
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeButton());
    // Shift+Tab on the first goes to the last.
    expect(key("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(next);
    // Between two controls the browser moves focus itself.
    back.focus();
    expect(key("Tab").defaultPrevented).toBe(false);
    // Focus that ended up outside comes back in.
    (document.activeElement as HTMLElement).blur();
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeButton());
  });

  it("holds focus on the panel when there is nothing to tab to", () => {
    render({ busy: true, footer: undefined });
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog());
  });

  it("makes the app behind inert while open and gives it back after", () => {
    render({ open: false });
    expect(app.hasAttribute("inert")).toBe(false);
    props.open = true;
    flushSync();
    expect(app.hasAttribute("inert")).toBe(true);
    expect(app.getAttribute("aria-hidden")).toBe("true");
    expect(outside.hasAttribute("inert")).toBe(true);
    // The dialog itself, and the shell that holds it, stay live.
    expect(shell.hasAttribute("inert")).toBe(false);
    expect(layer()!.hasAttribute("inert")).toBe(false);
    props.open = false;
    flushSync();
    expect(app.hasAttribute("inert")).toBe(false);
    expect(app.hasAttribute("aria-hidden")).toBe(false);
    expect(outside.hasAttribute("inert")).toBe(false);
  });

  it("leaves alone what was already inert", () => {
    outside.setAttribute("inert", "");
    render();
    props.open = false;
    flushSync();
    expect(outside.hasAttribute("inert")).toBe(true);
  });
});

describe("the card modal: step indicator", () => {
  const steps: CardModalSteps = { labels: ["Create the app", "Add it to Slack", "Say hello"], current: 1 };

  it("shows no indicator without steps", () => {
    render();
    expect(byId("card-modal-steps")).toBeNull();
  });

  it("says which step this is to a screen reader and shows a mark per step", () => {
    render({ steps });
    expect(byId("card-modal-steps-text")!.textContent).toBe("Step 2 of 3: Add it to Slack");
    const marks = [...byId("card-modal-steps")!.querySelectorAll(".card-modal-progress-marks span")];
    expect(marks.map((mark) => mark.className.trim())).toEqual(["is-done", "is-current", ""]);
    // The marks and the visible label are for the eye; the sentence is for the reader.
    expect(byId("card-modal-steps")!.querySelector(".card-modal-progress-marks")!.getAttribute("aria-hidden")).toBe("true");
    expect(byId("card-modal-steps")!.querySelector(".card-modal-progress-label")!.textContent).toBe("Add it to Slack");
  });

  it("follows the flow from step to step", () => {
    render({ steps });
    props.steps = { ...steps, current: 2 };
    flushSync();
    expect(byId("card-modal-steps-text")!.textContent).toBe("Step 3 of 3: Say hello");
  });

  it("keeps a step that is out of range inside the list", () => {
    expect(cardModalStepIndex({ labels: ["a", "b"], current: 9 })).toBe(1);
    expect(cardModalStepIndex({ labels: ["a", "b"], current: -3 })).toBe(0);
    expect(cardModalStepIndex({ labels: ["a", "b"], current: Number.NaN })).toBe(0);
    expect(cardModalStepText({ labels: ["a", "b"], current: 9 })).toBe("Step 2 of 2: b");
    expect(cardModalStepText({ labels: [], current: 0 })).toBe("");
    expect(cardModalStepText({ labels: ["", ""], current: 0 })).toBe("Step 1 of 2");
  });
});

describe("the pieces a flow is built from", () => {
  function mountPiece<P extends Record<string, any>>(piece: Component<P, any, any>, pieceProps: P): HTMLElement {
    component = mount(piece, { target: app, props: pieceProps });
    flushSync();
    return app;
  }

  it("a step row shows its number, its instruction and its action", () => {
    const root = mountPiece(CardModalStep, {
      number: 2,
      state: "current",
      text: "Add the app to your workspace",
      detail: "Opens Slack in your browser",
      action: html('<button type="button" class="card-modal-btn is-small" data-testid="probe-action">Open Slack</button>'),
    });
    const row = root.querySelector<HTMLElement>('[data-testid="card-modal-step"]')!;
    expect(row.tagName).toBe("LI");
    expect(row.dataset.state).toBe("current");
    expect(row.getAttribute("aria-current")).toBe("step");
    expect(row.querySelector(".card-modal-step-num")!.textContent?.trim()).toBe("2");
    expect(row.querySelector(".card-modal-step-text")!.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Step 2: Add the app to your workspace",
    );
    expect(row.querySelector(".card-modal-step-detail")!.textContent).toBe("Opens Slack in your browser");
    expect(row.querySelector(".card-modal-step-action")!.contains(byId("probe-action"))).toBe(true);
  });

  it("a done step shows a check and says done; a step to do is not the current one", async () => {
    const root = mountPiece(CardModalStep, { number: 1, state: "done", text: "Create the app" });
    const row = root.querySelector<HTMLElement>('[data-testid="card-modal-step"]')!;
    expect(row.querySelector(".card-modal-step-num svg")).not.toBeNull();
    expect(row.querySelector(".card-modal-step-num")!.textContent?.trim()).toBe("");
    expect(row.querySelector(".card-modal-step-text")!.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Step 1, done: Create the app",
    );
    expect(row.hasAttribute("aria-current")).toBe(false);
    expect(row.querySelector(".card-modal-step-action")).toBeNull();
    await unmount(component!);
    const todo = mountPiece(CardModalStep, { number: 3, state: "todo", text: "Say hello" });
    const todoRow = todo.querySelector<HTMLElement>('[data-testid="card-modal-step"]')!;
    expect(todoRow.dataset.state).toBe("todo");
    expect(todoRow.hasAttribute("aria-current")).toBe(false);
  });

  it("a status line says working, done or a problem, and a problem is announced at once", async () => {
    const kinds = [
      ["working", "status", ".card-modal-spinner"],
      ["done", "status", "svg"],
      ["problem", "alert", "svg"],
    ] as const;
    for (const [kind, role, mark] of kinds) {
      const root = mountPiece(CardModalStatus, { kind, text: `It is ${kind}.` });
      const line = root.querySelector<HTMLElement>('[data-testid="card-modal-status"]')!;
      expect(line.dataset.kind).toBe(kind);
      expect(line.getAttribute("role")).toBe(role);
      expect(line.querySelector(".card-modal-status-text")!.textContent).toBe(`It is ${kind}.`);
      expect(line.querySelector(`.card-modal-status-mark ${mark}`)).not.toBeNull();
      expect(line.querySelector(".card-modal-status-mark")!.getAttribute("aria-hidden")).toBe("true");
      await unmount(component!);
      component = null;
    }
  });

  it("a text field is tied to its label and reports what is typed", () => {
    const oninput = vi.fn();
    const onsubmit = vi.fn();
    const root = mountPiece(CardModalField, {
      label: "Workspace address",
      placeholder: "acme.slack.com",
      hint: "The address you use to sign in to Slack.",
      oninput,
      onsubmit,
    });
    const field = root.querySelector<HTMLInputElement>("input")!;
    const label = root.querySelector<HTMLLabelElement>("label")!;
    expect(label.textContent).toBe("Workspace address");
    expect(label.htmlFor).toBe(field.id);
    expect(field.id).not.toBe("");
    expect(field.placeholder).toBe("acme.slack.com");
    expect(field.hasAttribute("aria-invalid")).toBe(false);
    expect(document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "The address you use to sign in to Slack.",
    );
    field.value = "acme.slack.com";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(oninput).toHaveBeenLastCalledWith("acme.slack.com");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(onsubmit).toHaveBeenCalledWith("acme.slack.com");
    expect(field.hasAttribute(CARD_MODAL_AUTOFOCUS)).toBe(false);
  });

  it("a text field with an error is marked invalid and says what is wrong", () => {
    const root = mountPiece(CardModalField, {
      label: "Workspace address",
      value: "acme",
      hint: "The address you use to sign in to Slack.",
      error: "That does not look like a Slack address.",
      autofocus: true,
    });
    const field = root.querySelector<HTMLInputElement>("input")!;
    expect(field.value).toBe("acme");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const note = document.getElementById(field.getAttribute("aria-describedby") ?? "")!;
    expect(note.textContent).toBe("That does not look like a Slack address.");
    expect(note.getAttribute("role")).toBe("alert");
    expect(root.querySelector('[data-testid="card-modal-field"]')!.getAttribute("data-invalid")).toBe("true");
    // The error takes the hint's place.
    expect(root.textContent).not.toContain("The address you use to sign in");
    expect(field.hasAttribute(CARD_MODAL_AUTOFOCUS)).toBe(true);
  });
});
