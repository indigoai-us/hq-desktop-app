// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeConversationRead } from "./observe-conversation-read";

describe("visible conversation read reporting", () => {
  let node: HTMLElement;
  let action: ReturnType<typeof observeConversationRead>;
  let focused: boolean;
  let visible: boolean;
  let onseen: ReturnType<typeof vi.fn<() => Promise<void>>>;
  beforeEach(() => {
    vi.useFakeTimers();
    focused = true; visible = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
    node = document.createElement("div");
    document.body.append(node);
    vi.spyOn(node, "getClientRects").mockReturnValue(Object.assign([new DOMRect()], { item: () => new DOMRect() }));
    Object.defineProperty(node, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(node, "scrollHeight", { value: 1000 });
    node.scrollTop = 900;
    onseen = vi.fn().mockResolvedValue(undefined);
    action = observeConversationRead(node, {key: "m1", onseen});
  });
  afterEach(() => { action.destroy(); node.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
  async function settle() { await vi.advanceTimersByTimeAsync(150); }
  it("marks new arrivals without reopening and deduplicates scroll events", async () => {
    await settle(); expect(onseen).toHaveBeenCalledTimes(1);
    node.dispatchEvent(new Event("scroll")); await settle();
    expect(onseen).toHaveBeenCalledTimes(1);
    action.update({key: "m2", onseen}); await settle();
    expect(onseen).toHaveBeenCalledTimes(2);
  });
  it("waits until the user returns to the focused app", async () => {
    focused = false; await settle(); expect(onseen).not.toHaveBeenCalled();
    focused = true; window.dispatchEvent(new Event("focus")); await settle();
    expect(onseen).toHaveBeenCalledTimes(1);
  });
  it("keeps history-scrolled arrivals unread until reaching latest", async () => {
    node.scrollTop = 300; await settle(); expect(onseen).not.toHaveBeenCalled();
    node.scrollTop = 900; node.dispatchEvent(new Event("scroll")); await settle();
    expect(onseen).toHaveBeenCalledTimes(1);
  });
  it("reports reading again after leaving the latest messages", async () => {
    await settle();
    node.scrollTop = 300; node.dispatchEvent(new Event("scroll")); await settle();
    expect(onseen).toHaveBeenCalledTimes(1);
    node.scrollTop = 900; node.dispatchEvent(new Event("scroll")); await settle();
    expect(onseen).toHaveBeenCalledTimes(2);
  });
  it("does not read hidden content", async () => {
    visible = false; await settle(); expect(onseen).not.toHaveBeenCalled();
    visible = true; Object.defineProperty(node, "clientHeight", {value: 0});
    document.dispatchEvent(new Event("visibilitychange")); await settle();
    expect(onseen).not.toHaveBeenCalled();
  });
  it("retries failed reads when the user interacts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    onseen.mockRejectedValueOnce(new Error("offline")); await settle();
    node.dispatchEvent(new Event("pointerdown")); await settle();
    expect(onseen).toHaveBeenCalledTimes(2);
  });
  it("cancels work when the conversation closes", async () => {
    action.destroy(); await settle(); expect(onseen).not.toHaveBeenCalled();
  });
});
