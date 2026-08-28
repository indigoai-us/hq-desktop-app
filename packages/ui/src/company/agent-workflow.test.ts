// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { failure, ok } from "@hq/platform";

import { openAgentWorkflow, type AgentWorkflowApi } from "./agent-workflow";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  openClaudeCodeLink: vi.fn(),
  writeText: vi.fn(),
}));

const api = {
  settings: { getConfig: mocks.getConfig },
  shell: { openClaudeCodeLink: mocks.openClaudeCodeLink },
} as unknown as AgentWorkflowApi;

describe("openAgentWorkflow", () => {
  beforeEach(() => {
    mocks.getConfig.mockReset();
    mocks.openClaudeCodeLink.mockReset();
    mocks.writeText.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
  });

  it("reports a deep-link handoff as opened", async () => {
    mocks.getConfig.mockResolvedValueOnce(ok({ hqFolderPath: "/tmp/hq" }));
    mocks.openClaudeCodeLink.mockResolvedValueOnce(ok(undefined));

    await expect(
      openAgentWorkflow(api, "/deploy", "deploy workflow"),
    ).resolves.toMatchObject({ outcome: "opened", ok: true });
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it("reports a successful clipboard fallback as copied, not failed", async () => {
    mocks.getConfig.mockResolvedValueOnce(ok({ hqFolderPath: "/tmp/hq" }));
    mocks.openClaudeCodeLink.mockResolvedValueOnce(
      failure("link-rejected", "not installed"),
    );
    mocks.writeText.mockResolvedValue(undefined);

    await expect(
      openAgentWorkflow(api, "/deploy", "deploy workflow"),
    ).resolves.toMatchObject({ outcome: "copied", ok: false });
    expect(mocks.writeText).toHaveBeenCalledWith("/deploy");
  });

  it("falls back to the clipboard when the capability is unavailable on this platform", async () => {
    mocks.getConfig.mockResolvedValueOnce(ok({ hqFolderPath: "/tmp/hq" }));
    mocks.openClaudeCodeLink.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable" as const,
      code: "desktop-only",
    });
    mocks.writeText.mockResolvedValue(undefined);

    await expect(
      openAgentWorkflow(api, "/deploy", "deploy workflow"),
    ).resolves.toMatchObject({ outcome: "copied", ok: false });
  });

  it("reports failure only when neither handoff path works", async () => {
    mocks.getConfig.mockResolvedValueOnce(ok({ hqFolderPath: "/tmp/hq" }));
    mocks.openClaudeCodeLink.mockResolvedValueOnce(
      failure("link-rejected", "not installed"),
    );
    mocks.writeText.mockRejectedValueOnce(new Error("clipboard denied"));

    await expect(
      openAgentWorkflow(api, "/deploy", "deploy workflow"),
    ).resolves.toMatchObject({ outcome: "failed", ok: false });
  });
});
