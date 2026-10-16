/**
 * The report action cards' destinations and assistant send, as the shell
 * builds them: the assistant button only when the assistant runs on this
 * computer, and a note for every send.
 */
import { describe, expect, it, vi } from "vitest";

import { assistantNameInSentence, briefActionsFor } from "./brief-action-cards.js";

const CLI = { claudeCode: true, codex: false };
const sent = async () => ({ ok: true as const, value: null });

describe("briefActionsFor", () => {
  it("gives no assistant button when the assistant does not run on this computer", async () => {
    const send = vi.fn(sent);
    const actions = briefActionsFor({ uid: "agt_ada", name: "Ada", runsHere: false }, CLI, send);
    expect(actions.destinations).toEqual({ assistantName: null, claudeCode: true, codex: false });
    expect(await actions.onassistant("p", "k")).toBe("Your assistant is not set up on this computer yet.");
    expect(send).not.toHaveBeenCalled();
  });

  it("gives no assistant button with no assistant", () => {
    expect(briefActionsFor(null, CLI, vi.fn(sent)).destinations.assistantName).toBeNull();
  });

  it("sends over the agent lane to an assistant that runs here and says it was sent", async () => {
    const send = vi.fn(sent);
    const actions = briefActionsFor({ uid: "agt_ada", name: "Ada", runsHere: true }, CLI, send);
    expect(actions.destinations.assistantName).toBe("Ada");
    expect(await actions.onassistant("Review PR 42", "brief-action:run-1:d1")).toBe("Sent to Ada. Watch your messages.");
    expect(send).toHaveBeenCalledWith("agt_ada", "Review PR 42", "brief-action:run-1:d1");
  });

  it("says the send failed when the server refuses it or the call throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refused = briefActionsFor({ uid: "agt_ada", name: "Ada", runsHere: true }, CLI, async () => ({ ok: false as const, reason: "error" as const, code: "http-500" }));
    expect(await refused.onassistant("p", "k")).toBe("Could not send this to Ada. Try again in a moment.");
    const threw = briefActionsFor({ uid: "agt_ada", name: "Ada", runsHere: true }, CLI, () => Promise.reject(new Error("offline")));
    expect(await threw.onassistant("p", "k")).toBe("Could not send this to Ada. Try again in a moment.");
    warn.mockRestore();
  });

  it("names an unnamed assistant in lower case inside a sentence", async () => {
    expect(assistantNameInSentence("Your assistant")).toBe("your assistant");
    expect(assistantNameInSentence("Ada")).toBe("Ada");
    const actions = briefActionsFor({ uid: "agt_x", name: "Your assistant", runsHere: true }, CLI, sent);
    expect(actions.destinations.assistantName).toBe("your assistant");
    expect(await actions.onassistant("p", "k")).toBe("Sent to your assistant. Watch your messages.");
  });

  describe("while the brief job is held back", () => {
    const BOTH = { claudeCode: true, codex: true };
    const ada = { uid: "agt_ada", name: "Ada", runsHere: true };

    it("hides the assistant button and sends nothing", async () => {
      const send = vi.fn(sent);
      const actions = briefActionsFor(ada, BOTH, send, { signedIn: { claude: true, codex: true } });
      expect(actions.destinations.assistantName).toBeNull();
      await actions.onassistant("p", "k");
      expect(send).not.toHaveBeenCalled();
    });

    it("keeps Claude Code when Claude is signed in and hides Codex when Codex is not", () => {
      const actions = briefActionsFor(ada, BOTH, sent, { signedIn: { claude: true, codex: false } });
      expect(actions.destinations).toEqual({ assistantName: null, claudeCode: true, codex: false });
    });

    it("keeps Codex when only Codex is signed in", () => {
      const actions = briefActionsFor(ada, BOTH, sent, { signedIn: { claude: false, codex: true } });
      expect(actions.destinations).toEqual({ assistantName: null, claudeCode: false, codex: true });
    });

    it("hides both tools before the sign-in check has run", () => {
      const actions = briefActionsFor(ada, BOTH, sent, { signedIn: null });
      expect(actions.destinations).toEqual({ assistantName: null, claudeCode: false, codex: false });
    });

    it("never shows a tool that is not installed, even when it reads as signed in", () => {
      const actions = briefActionsFor(ada, CLI, sent, { signedIn: { claude: true, codex: true } });
      expect(actions.destinations).toEqual({ assistantName: null, claudeCode: true, codex: false });
    });
  });

  it("outside the held state keeps the assistant and both installed tools, signed in or not", () => {
    const actions = briefActionsFor({ uid: "agt_ada", name: "Ada", runsHere: true }, { claudeCode: true, codex: true }, sent, null);
    expect(actions.destinations).toEqual({ assistantName: "Ada", claudeCode: true, codex: true });
  });
});
