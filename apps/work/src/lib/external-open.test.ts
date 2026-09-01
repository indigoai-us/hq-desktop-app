// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriInvoke = vi.hoisted(() => vi.fn());

vi.mock("./tauri-invoke.js", () => ({ tauriInvoke }));

import {
  approvedWorkExternalUrl,
  openWorkExternalUrl,
} from "./external-open.js";

describe("Work external URL handoffs", () => {
  beforeEach(() => {
    tauriInvoke.mockReset();
    tauriInvoke.mockResolvedValue(undefined);
  });

  it("refuses unsafe schemes before they can reach window.open", () => {
    const windowOpen = vi
      .spyOn(window, "open")
      .mockImplementation(() => null);

    for (const raw of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "  javascript:alert(1)",
    ]) {
      expect(approvedWorkExternalUrl(raw)).toBeNull();
      openWorkExternalUrl(raw, "web");
    }

    expect(windowOpen).not.toHaveBeenCalled();
    expect(tauriInvoke).not.toHaveBeenCalled();
  });

  it("opens an approved HTTPS handoff with browser protections", () => {
    const windowOpen = vi
      .spyOn(window, "open")
      .mockImplementation(() => null);

    openWorkExternalUrl("https://hq.computer/work?tab=files", "web");

    expect(windowOpen).toHaveBeenCalledWith(
      "https://hq.computer/work?tab=files",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("uses the approved native opener on desktop", async () => {
    openWorkExternalUrl("https://hq.computer/work", "desktop");

    await vi.waitFor(() => {
      expect(tauriInvoke).toHaveBeenCalledWith("plugin:shell|open", {
        path: "https://hq.computer/work",
        with: null,
      });
    });
  });
});
