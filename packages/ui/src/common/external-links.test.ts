// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import {
  closestHrefAnchor,
  externalHref,
  handleLinkActivate,
  isNativeEditingTarget,
  openExternalHref,
} from "./external-links.js";

function dispatch(
  type: string,
  target: EventTarget,
  init: MouseEventInit = {},
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe("externalHref", () => {
  it("allows credential-free http(s) and mailto", () => {
    expect(externalHref("https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(externalHref("http://example.com")).toBe("http://example.com");
    expect(externalHref("mailto:ada@example.com")).toBe(
      "mailto:ada@example.com",
    );
  });

  it("rejects relative, javascript, file, tel, and credentialed URLs", () => {
    expect(externalHref("/docs")).toBeNull();
    expect(externalHref("#section")).toBeNull();
    expect(externalHref("javascript:alert(1)")).toBeNull();
    expect(externalHref("file:///etc/passwd")).toBeNull();
    expect(externalHref("tel:+15555550100")).toBeNull();
    expect(externalHref("https://user:pass@example.com")).toBeNull();
    expect(externalHref("")).toBeNull();
  });
});

describe("handleLinkActivate", () => {
  it("opens on left-click in message mode and prevents default", () => {
    const root = document.createElement("div");
    const anchor = document.createElement("a");
    anchor.href = "https://example.com/docs";
    anchor.textContent = "docs";
    root.appendChild(anchor);
    document.body.appendChild(root);
    const onopenurl = vi.fn();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "currentTarget", { value: root });
    Object.defineProperty(event, "target", { value: anchor });
    const handled = handleLinkActivate(event, { onopenurl, mode: "message" });

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(onopenurl).toHaveBeenCalledWith("https://example.com/docs");
    root.remove();
  });

  it("opens on cmd-click and middle-click in shell mode", () => {
    const root = document.createElement("div");
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "https://example.com/x");
    root.appendChild(anchor);
    document.body.appendChild(root);
    const onopenurl = vi.fn();

    const cmd = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    Object.defineProperty(cmd, "currentTarget", { value: root });
    Object.defineProperty(cmd, "target", { value: anchor });
    expect(handleLinkActivate(cmd, { onopenurl, mode: "shell" })).toBe(true);
    expect(onopenurl).toHaveBeenCalledWith("https://example.com/x");

    onopenurl.mockClear();
    const middle = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    Object.defineProperty(middle, "currentTarget", { value: root });
    Object.defineProperty(middle, "target", { value: anchor });
    expect(handleLinkActivate(middle, { onopenurl, mode: "shell" })).toBe(true);
    expect(onopenurl).toHaveBeenCalledWith("https://example.com/x");
    root.remove();
  });

  it("does not intercept unmodified left-click in shell mode", () => {
    const root = document.createElement("div");
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "https://example.com/x");
    root.appendChild(anchor);
    const onopenurl = vi.fn();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "currentTarget", { value: root });
    Object.defineProperty(event, "target", { value: anchor });
    expect(handleLinkActivate(event, { onopenurl, mode: "shell" })).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(onopenurl).not.toHaveBeenCalled();
  });

  it("shows a menu on contextmenu for http(s) links and ignores other schemes", () => {
    const root = document.createElement("div");
    const good = document.createElement("a");
    good.setAttribute("href", "https://example.com/docs");
    const bad = document.createElement("a");
    bad.setAttribute("href", "javascript:alert(1)");
    root.append(good, bad);
    const onmenu = vi.fn();
    const onopenurl = vi.fn();

    const openEvt = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 12,
    });
    Object.defineProperty(openEvt, "currentTarget", { value: root });
    Object.defineProperty(openEvt, "target", { value: good });
    expect(handleLinkActivate(openEvt, { onmenu, onopenurl })).toBe(true);
    expect(openEvt.defaultPrevented).toBe(true);
    expect(onmenu).toHaveBeenCalledWith(
      expect.objectContaining({ href: "https://example.com/docs" }),
    );
    expect(onopenurl).not.toHaveBeenCalled();

    const badEvt = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(badEvt, "currentTarget", { value: root });
    Object.defineProperty(badEvt, "target", { value: bad });
    expect(handleLinkActivate(badEvt, { onmenu, onopenurl })).toBe(true);
    expect(badEvt.defaultPrevented).toBe(true);
    expect(onmenu).toHaveBeenCalledTimes(1);
    expect(onopenurl).not.toHaveBeenCalled();
  });

  it("does not handle contextmenu on plain text", () => {
    const root = document.createElement("div");
    root.textContent = "no link here";
    const onmenu = vi.fn();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "currentTarget", { value: root });
    Object.defineProperty(event, "target", { value: root });
    expect(handleLinkActivate(event, { onmenu })).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(onmenu).not.toHaveBeenCalled();
  });

  it("leaves the native menu on inputs", () => {
    const root = document.createElement("div");
    const input = document.createElement("textarea");
    root.appendChild(input);
    expect(isNativeEditingTarget(input)).toBe(true);
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "currentTarget", { value: root });
    Object.defineProperty(event, "target", { value: input });
    expect(handleLinkActivate(event, { onmenu: vi.fn() })).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("openExternalHref", () => {
  it("ignores non-http schemes", () => {
    const onopenurl = vi.fn();
    expect(openExternalHref("javascript:alert(1)", onopenurl)).toBe(false);
    expect(onopenurl).not.toHaveBeenCalled();
  });
});

describe("closestHrefAnchor", () => {
  it("walks out of a nested child", () => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "https://example.com");
    const code = document.createElement("code");
    anchor.appendChild(code);
    expect(closestHrefAnchor(code)).toBe(anchor);
  });
});

describe("dispatch helper sanity", () => {
  it("constructs cancelable mouse events", () => {
    const node = document.createElement("div");
    const event = dispatch("click", node, { metaKey: true });
    expect(event.metaKey).toBe(true);
    expect(event.cancelable).toBe(true);
  });
});
