import { afterEach, describe, expect, it, vi } from "vitest";

import { formatComposerSendError } from "./composer-send-error";
import { formatUploadServerError } from "./upload-chat-attachments";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

function warnedRaw(warn: ReturnType<typeof vi.spyOn>): boolean {
  return warn.mock.calls.some((args: unknown[]) => args.some((a) => String(a).includes("boom")));
}

afterEach(() => vi.restoreAllMocks());

describe("composer send and upload errors never show raw server text (AUDIT-3c)", () => {
  it("composer send error uses plain copy and logs the raw text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const hadFiles of [false, true]) {
      const copy = formatComposerSendError(RAW, hadFiles);
      expect(copy).not.toContain("boom");
      expect(copy).not.toContain("HTTP 500");
      expect(copy).toContain("Try again.");
    }
    expect(warnedRaw(warn)).toBe(true);
  });

  it("an INVALID_MENTIONS rejection does not echo the server sentence", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const copy = formatComposerSendError(`[INVALID_MENTIONS] ${RAW}`, false);
    expect(copy).toBe("Couldn't send — one of the @mentions isn't valid. Remove it and send again.");
    expect(copy).not.toContain("boom");
    expect(warnedRaw(warn)).toBe(true);
  });

  it("upload error uses plain copy and logs the raw text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const copy = formatUploadServerError(RAW, "shot.png");
    expect(copy).toBe("Could not upload shot.png. Try again.");
    expect(formatComposerSendError(copy, true)).toBe(copy);
    expect(warnedRaw(warn)).toBe(true);
  });
});
