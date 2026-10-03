import { flushSync } from "svelte";
import { expect, vi } from "vitest";
import { LOADING_MESSAGE_AFTER_MS, LOADING_RETRY_AFTER_MS } from "./read-deadline.js";

/**
 * BLANK-3 contract for a read that never answers (fake timers): the page keeps
 * its loader, a waiting line appears by LOADING_MESSAGE_AFTER_MS, a Try again
 * joins it by LOADING_RETRY_AFTER_MS, and no timer ever turns it into a
 * failed-read state.
 */
export async function expectPendingRead(root: ParentNode, loader: string): Promise<void> {
  flushSync();
  expect(root.querySelector(`[data-testid='${loader}']`), `${loader} at once`).toBeTruthy();
  await vi.advanceTimersByTimeAsync(LOADING_MESSAGE_AFTER_MS + 10);
  flushSync();
  expect(root.querySelector(`[data-testid='${loader}-message']`)?.textContent ?? "", `${loader} waiting line`).toMatch(/\S/);
  expect(root.querySelector(`[data-testid='${loader}-retry']`)).toBeNull();
  await vi.advanceTimersByTimeAsync(LOADING_RETRY_AFTER_MS);
  flushSync();
  expect(root.querySelector(`[data-testid='${loader}']`), `${loader} still loading`).toBeTruthy();
  expect(root.querySelector(`[data-testid='${loader}-retry']`), `${loader} Try again`).toBeTruthy();
  const text = (root instanceof Document ? root.body : (root as Element)).textContent ?? "";
  expect(text, "no failed-read state from a timer").not.toMatch(/\bCould not\b|\bCouldn't\b|didn't load|could not be read/);
}
