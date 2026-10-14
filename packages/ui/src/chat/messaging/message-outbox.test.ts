import { describe, expect, it, vi } from "vitest";
import {
  createMessageOutbox,
  isQueuedSendToken,
  queuedSendToken,
} from "./message-outbox.js";

describe("message outbox", () => {
  it("sends queued items in enqueue order and stops on failure", async () => {
    const box = createMessageOutbox<string>();
    expect(queuedSendToken(box.enqueue("first"))).toBe("queued:q1");
    box.enqueue("second");
    const sent: string[] = [];
    const send = vi.fn(async (body: string) => {
      sent.push(body);
      if (body === "first") throw new Error("still offline");
    });
    await expect(box.flush(send)).rejects.toThrow("still offline");
    expect(sent).toEqual(["first"]);
    expect(box.list().map((item) => item.payload)).toEqual(["first", "second"]);
    await box.flush(async (body) => {
      sent.push(body);
    });
    expect(sent).toEqual(["first", "first", "second"]);
    expect(box.size).toBe(0);
    expect(isQueuedSendToken("queued:q1")).toBe(true);
    expect(isQueuedSendToken("evt_1")).toBe(false);
  });
});
