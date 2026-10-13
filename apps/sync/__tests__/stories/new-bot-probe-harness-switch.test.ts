// The preview harness's ?probe= switch: the readiness check a local bot gets
// before it is saved (dev-harness/audit-switches.ts). Preview only.
import { describe, expect, it } from "vitest";

import { PROBE_SWITCHES, probeAnswer, probeSwitch, switchedHandler } from "../../dev-harness/audit-switches";

describe("?probe= harness switch", () => {
  it("is off by default and accepts only its listed values", () => {
    expect(probeSwitch("")).toBeNull();
    expect(probeSwitch("?probe=bogus")).toBeNull();
    expect(probeSwitch("?probe=cli-outdated")).toBe("cli-outdated");
    expect(switchedHandler("local_bots_probe", { runtime: "codex" }, "")).toBeUndefined();
  });

  it("answers each outcome in the hq bot probe shape", () => {
    for (const kind of PROBE_SWITCHES) {
      const answer = probeAnswer(kind, { runtime: "codex", model: null }) as Record<string, unknown>;
      if (kind === "unsupported") expect(answer).toEqual({ supported: false });
      else if (kind === "ok" || kind === "fallback") expect(answer.ok).toBe(true);
      else expect(answer).toMatchObject({ ok: false, class: kind });
    }
    expect(probeAnswer("fallback", { runtime: "codex" })).toMatchObject({ modelFallback: { to: "gpt-5.5" } });
  });

  it("lets a supported model pass so the fix can be followed through", () => {
    expect(probeAnswer("cli-outdated", { runtime: "codex", model: "gpt-5.5" })).toMatchObject({ ok: true });
  });

  it("answers local_bots_probe after the loading delay", async () => {
    const answer = switchedHandler("local_bots_probe", { runtime: "codex" }, "?probe=transient&loadingMs=1") as {
      value: Promise<unknown>;
    };
    await expect(answer.value).resolves.toMatchObject({ ok: false, class: "transient" });
  });
});
