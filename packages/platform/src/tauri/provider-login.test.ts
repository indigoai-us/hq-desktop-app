/**
 * A vendor CLI can keep a saved-but-dead login: `auth status` says signed in
 * while every model call fails to authenticate. "Sign in again" must reach
 * Rust with `force: true` (sign out, then the browser sign-in); a plain
 * connect must not, so an existing account is never replaced by accident.
 */
import { describe, expect, it } from "vitest";

import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

describe("provider sign-in force flag", () => {
  it("TauriPlatformAdapter passes force only when asked", async () => {
    const calls: Invocation[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return { state: "waiting" };
      },
    });
    await adapter.sessions.loginStart!("claude");
    await adapter.sessions.loginStart!("codex", { force: true });
    expect(calls).toEqual([
      { cmd: "agent_provider_login_start", args: { tool: "claude" } },
      { cmd: "agent_provider_login_start", args: { tool: "codex", force: true } },
    ]);
  });

  it("sync adapter passes force only when asked", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return { state: "waiting" };
      },
      fetch: (() => {
        throw new Error("the adapter must not use window.fetch");
      }) as unknown as typeof globalThis.fetch,
    });
    await adapter.sessions!.loginStart!("grok", { force: false });
    await adapter.sessions!.loginStart!("claude", { force: true });
    expect(calls).toEqual([
      { cmd: "agent_provider_login_start", args: { tool: "grok" } },
      { cmd: "agent_provider_login_start", args: { tool: "claude", force: true } },
    ]);
  });
});
